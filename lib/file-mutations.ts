import fs from "fs";
import path from "path";
import { isExistingFilePathAllowed, isFilePathAllowed } from "./file-access";
import { isWindowsAbsolutePath, samePath } from "./paths";
import { moveToTrash } from "./trash";

export class FileMutationError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export type FileMutationConflictMode = "error" | "overwrite" | "keep-both";

export type FileMutation =
  | { type: "create-file" | "create-directory"; directory: string; name: string }
  | { type: "rename"; sourcePath: string; name: string }
  | { type: "move"; sourcePath: string; destinationDirectory: string; conflict: FileMutationConflictMode }
  | { type: "copy"; sourcePath: string; destinationDirectory: string; conflict: FileMutationConflictMode }
  | { type: "delete"; sourcePath: string }
  | { type: "write"; sourcePath: string; content: string; baseMtimeMs: number | null };

export type FileMutationResult = {
  sourcePath: string;
  destinationPath?: string;
  deleted: boolean;
  mtimeMs?: number;
  size?: number;
};

function resolverFor(...paths: string[]): typeof path {
  return paths.some(isWindowsAbsolutePath) ? path.win32 : path;
}

function assertName(name: string): void {
  if (
    !name
    || name === "."
    || name === ".."
    || /[\\/]/.test(name)
    || path.isAbsolute(name)
    || path.win32.isAbsolute(name)
  ) {
    throw new FileMutationError(400, "Invalid file name");
  }
}

function pathEntryExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (isFileSystemError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function resolveKeepBothName(directory: string, name: string): string {
  const resolver = resolverFor(directory, name);
  const dot = name.lastIndexOf(".");
  const hasExtension = dot > 0;
  const base = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : "";
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = attempt === 0
      ? `${base} copy${extension}`
      : `${base} copy ${attempt + 1}${extension}`;
    if (!pathEntryExists(resolver.join(directory, candidate))) return candidate;
  }
  throw new FileMutationError(409, "A file or directory with this name already exists");
}

function removeExistingForOverwrite(target: string, allowedRoots: Set<string>): void {
  if (!isExistingFilePathAllowed(target, allowedRoots)) {
    throw new FileMutationError(403, "Access denied");
  }
  const stat = fs.lstatSync(target);
  fs.rmSync(target, { recursive: stat.isDirectory(), force: false });
}

function createStagingContainer(directory: string, allowedRoots: Set<string>): string {
  // Exclusive mkdtemp container beside the destination for staged overwrite
  // copies: the caller copies the source into it while the destination is
  // still intact, then swaps the payload over the destination.
  const prefix = resolverFor(directory).join(directory, ".pi-staging-");
  if (!isFilePathAllowed(prefix, allowedRoots)) {
    throw new FileMutationError(403, "Destination is outside the allowed roots");
  }
  return fs.mkdtempSync(prefix);
}

function nearestExistingAncestor(target: string, allowedRoots: Set<string>): string | null {
  // Walk up from target to find the first existing ancestor that is still
  // lexically within an allowed root, probing each candidate with lstat
  // (which does not follow the final component). Used to canonically
  // authorize before probing a leaf whose path may traverse an allowed-root
  // symlink that escapes the root — lstat follows intermediate symlinks, so
  // we must authorize the nearest existing ancestor first. Stops at the
  // lexical root boundary so a root path's tmp-directory parent is never
  // evaluated.
  const resolver = resolverFor(target);
  let current = target;
  for (let depth = 0; depth < 64; depth++) {
    const parent = resolver.dirname(current);
    if (parent === current) return null; // filesystem root
    if (!isFilePathAllowed(parent, allowedRoots)) return null; // walked out of lexical root
    if (pathEntryExists(parent)) return parent;
    current = parent;
  }
  return null;
}

function assertLexicallyAllowed(target: string, allowedRoots: Set<string>): void {
  if (!isFilePathAllowed(target, allowedRoots)) {
    throw new FileMutationError(403, "Access denied");
  }
}

function assertExistingAllowed(target: string, allowedRoots: Set<string>): void {
  // Authorize before observing the leaf so outside-root paths cannot be used
  // as an existence oracle. Canonically authorize the nearest existing
  // ancestor first: an allowed-root symlink whose target escapes the root
  // must return 403 regardless of whether the leaf exists, so we never reveal
  // existence through such a symlink. lstat follows intermediate symlinks, so
  // authorizing the ancestor (which resolves through realpath) catches escapes
  // before any leaf probe.
  assertLexicallyAllowed(target, allowedRoots);
  const ancestor = nearestExistingAncestor(target, allowedRoots);
  if (ancestor !== null && !isExistingFilePathAllowed(ancestor, allowedRoots)) {
    throw new FileMutationError(403, "Access denied");
  }
  if (!pathEntryExists(target)) {
    throw new FileMutationError(404, "File or directory not found");
  }
  // The leaf itself must also resolve within an allowed root (covers a direct
  // symlink whose target is outside the root, where the ancestor is legitimately
  // inside but the leaf escapes).
  if (!isExistingFilePathAllowed(target, allowedRoots)) {
    throw new FileMutationError(403, "Access denied");
  }
}

function assertParentAllowed(target: string, allowedRoots: Set<string>): void {
  const parent = resolverFor(target).dirname(target);
  assertLexicallyAllowed(target, allowedRoots);
  assertLexicallyAllowed(parent, allowedRoots);
  // Canonically authorize the nearest existing ancestor before probing the
  // parent, so an allowed-root symlink escaping the root cannot leak
  // outside-root existence via lstat following intermediate symlinks.
  const ancestor = nearestExistingAncestor(parent, allowedRoots);
  if (ancestor !== null && !isExistingFilePathAllowed(ancestor, allowedRoots)) {
    throw new FileMutationError(403, "Access denied");
  }
  if (!pathEntryExists(parent)) {
    throw new FileMutationError(404, "Parent directory not found");
  }
  if (!isExistingFilePathAllowed(parent, allowedRoots)) {
    throw new FileMutationError(403, "Access denied");
  }
}

function assertVacant(target: string, allowedRoots: Set<string>): void {
  assertLexicallyAllowed(target, allowedRoots);
  if (pathEntryExists(target)) {
    throw new FileMutationError(409, "A file or directory with this name already exists");
  }
}

function assertDirectory(target: string, allowedRoots: Set<string>): void {
  assertExistingAllowed(target, allowedRoots);
  if (!fs.statSync(target).isDirectory()) {
    throw new FileMutationError(400, "Target is not a directory");
  }
}

function isSameOrDescendant(candidate: string, ancestor: string): boolean {
  const resolver = resolverFor(candidate, ancestor);
  const relative = resolver.relative(ancestor, candidate);
  const traversesOutside = relative === ".." || relative.startsWith(`..${resolver.sep}`);
  return relative === "" || (!traversesOutside && !resolver.isAbsolute(relative));
}

// Authorization and mutation are separate path-based Node fs calls. Another
// local process can replace a checked path between them; this known TOCTOU
// window is an accepted limitation of the current Node API approach.
function executeMutation(
  mutation: FileMutation,
  allowedRoots: Set<string>,
): FileMutationResult {
  if ("directory" in mutation) {
    assertName(mutation.name);
    assertDirectory(mutation.directory, allowedRoots);
    const destinationPath = resolverFor(mutation.directory).join(
      mutation.directory,
      mutation.name,
    );
    assertParentAllowed(destinationPath, allowedRoots);
    assertVacant(destinationPath, allowedRoots);

    if (mutation.type === "create-file") {
      fs.writeFileSync(destinationPath, "", { flag: "wx" });
    } else {
      fs.mkdirSync(destinationPath);
    }
    return { sourcePath: destinationPath, destinationPath, deleted: false };
  }

  if (mutation.type === "write") {
    // 404 for normal missing files; 403 before any leaf probe when an
    // intermediate symlink escapes the allowed roots.
    assertExistingAllowed(mutation.sourcePath, allowedRoots);
    const stat = fs.statSync(mutation.sourcePath);
    if (!stat.isFile()) {
      throw new FileMutationError(400, "Target is not a file");
    }
    if (mutation.baseMtimeMs !== null && stat.mtimeMs !== mutation.baseMtimeMs) {
      throw new FileMutationError(409, "File changed on disk since it was read");
    }
    fs.writeFileSync(mutation.sourcePath, mutation.content, "utf-8");
    const nextStat = fs.statSync(mutation.sourcePath);
    return { sourcePath: mutation.sourcePath, deleted: false, mtimeMs: nextStat.mtimeMs, size: nextStat.size };
  }

  if (mutation.type === "delete") {
    assertLexicallyAllowed(mutation.sourcePath, allowedRoots);
    // Canonically authorize the existing parent before lstat of the leaf, so
    // an allowed-root symlink escaping the root cannot be used to probe
    // outside-root existence (lstat follows intermediate symlinks).
    const sourceParent = resolverFor(mutation.sourcePath).dirname(mutation.sourcePath);
    assertExistingAllowed(sourceParent, allowedRoots);
    const sourceStat = fs.lstatSync(mutation.sourcePath);
    if (sourceStat.isSymbolicLink()) {
      // Direct symlink: trash the link itself, not its target. The parent
      // was canonically authorized above; the leaf is trashed non-recursively.
    } else if (!isExistingFilePathAllowed(mutation.sourcePath, allowedRoots)) {
      throw new FileMutationError(403, "Access denied");
    }
    // Move the entry to the OS trash instead of deleting it permanently.
    try {
      moveToTrash(mutation.sourcePath);
    } catch (cause) {
      throw new Error(cause instanceof Error ? cause.message : "Could not move the entry to the trash", { cause });
    }
    return { sourcePath: mutation.sourcePath, deleted: true };
  }

  assertExistingAllowed(mutation.sourcePath, allowedRoots);
  const sourceResolver = resolverFor(mutation.sourcePath);
  const destinationDirectory = mutation.type === "rename"
    ? sourceResolver.dirname(mutation.sourcePath)
    : mutation.destinationDirectory;
  const name = mutation.type === "rename"
    ? mutation.name
    : sourceResolver.basename(mutation.sourcePath);

  assertName(name);
  assertDirectory(destinationDirectory, allowedRoots);
  let destinationPath = resolverFor(destinationDirectory).join(destinationDirectory, name);
  assertParentAllowed(destinationPath, allowedRoots);

  const conflict = "conflict" in mutation ? mutation.conflict : "error";
  let removedExisting = false;

  if (mutation.type !== "rename" && conflict === "overwrite" && samePath(destinationPath, mutation.sourcePath)) {
    // Overwriting an entry with itself is a no-op — the source must survive.
    return { sourcePath: mutation.sourcePath, destinationPath, deleted: false };
  }

  if (mutation.type !== "rename" && pathEntryExists(destinationPath)) {
    // Canonical checks run BEFORE any removal so a rejected overwrite can
    // never destroy the existing destination — including through a symlink
    // alias of the source.
    const canonicalSourcePath = fs.realpathSync(mutation.sourcePath);
    let canonicalDestinationPath: string | null = null;
    try {
      canonicalDestinationPath = fs.realpathSync(destinationPath);
    } catch {
      // Broken symlink destination: treat as lexically distinct.
    }
    if (canonicalDestinationPath !== null && samePath(canonicalDestinationPath, canonicalSourcePath)) {
      // The destination is a symlink alias of the source.
      if (conflict === "error") {
        throw new FileMutationError(409, "A file or directory with this name already exists");
      }
      if (conflict === "overwrite") {
        return { sourcePath: mutation.sourcePath, destinationPath, deleted: false };
      }
      // keep-both falls through to normal destination naming below.
    } else if (conflict === "overwrite" && fs.lstatSync(mutation.sourcePath).isDirectory()) {
      const canonicalDestinationDirectory = fs.realpathSync(destinationDirectory);
      const canonicalDestinationForCheck = resolverFor(
        canonicalDestinationDirectory,
        canonicalSourcePath,
      ).join(
        canonicalDestinationDirectory,
        resolverFor(destinationDirectory).basename(destinationPath),
      );
      if (isSameOrDescendant(canonicalDestinationForCheck, canonicalSourcePath)) {
        throw new FileMutationError(
          400,
          mutation.type === "copy"
            ? "A folder cannot be copied into itself or one of its subfolders"
            : "A folder cannot be moved into itself or one of its subfolders",
        );
      }
    }

    if (conflict === "error") {
      throw new FileMutationError(409, "A file or directory with this name already exists");
    }
    if (conflict === "overwrite") {
      // Removal is deferred: copy branches stage the replacement while the
      // destination is still intact; the move branch removes just before its
      // rename.
      removedExisting = true;
    } else {
      destinationPath = resolverFor(destinationDirectory).join(
        destinationDirectory,
        resolveKeepBothName(destinationDirectory, name),
      );
    }
  } else {
    assertVacant(destinationPath, allowedRoots);
  }

  if (fs.lstatSync(mutation.sourcePath).isDirectory()) {
    const canonicalSourcePath = fs.realpathSync(mutation.sourcePath);
    const canonicalDestinationDirectory = fs.realpathSync(destinationDirectory);
    const canonicalDestinationPath = resolverFor(
      canonicalDestinationDirectory,
      canonicalSourcePath,
    ).join(canonicalDestinationDirectory, resolverFor(destinationDirectory).basename(destinationPath));
    if (isSameOrDescendant(canonicalDestinationPath, canonicalSourcePath)) {
      throw new FileMutationError(
        400,
        mutation.type === "copy"
          ? "A folder cannot be copied into itself or one of its subfolders"
          : "A folder cannot be moved into itself or one of its subfolders",
      );
    }
  }

  if (mutation.type === "copy") {
    const sourceStat = fs.lstatSync(mutation.sourcePath);
    if (sourceStat.isSymbolicLink()) {
      // A directly selected symlink is copied as a link, never dereferenced.
      const linkTarget = fs.readlinkSync(mutation.sourcePath);
      if (removedExisting) {
        // A link cannot be staged; capture the target first, then remove the
        // destination and recreate the link. A racer that recreates the name
        // first makes symlinkSync fail with EEXIST (mapped to 409).
        removeExistingForOverwrite(destinationPath, allowedRoots);
      }
      fs.symlinkSync(linkTarget, destinationPath);
      return { sourcePath: mutation.sourcePath, destinationPath, deleted: false };
    }
    if (sourceStat.isDirectory()) {
      if (removedExisting) {
        // Stage the copy while the destination is still intact, then swap it
        // in, so a failed copy (permissions, disk space) never leaves the
        // destination destroyed.
        const stagingDir = createStagingContainer(destinationDirectory, allowedRoots);
        const stagedPath = resolverFor(stagingDir, name).join(stagingDir, name);
        let destinationRemoved = false;
        try {
          fs.cpSync(mutation.sourcePath, stagedPath, {
            recursive: true,
            dereference: false,
            verbatimSymlinks: true,
            force: false,
            errorOnExist: true,
          });
          removeExistingForOverwrite(destinationPath, allowedRoots);
          destinationRemoved = true;
          fs.renameSync(stagedPath, destinationPath);
        } catch (error) {
          if (!destinationRemoved) {
            // Destination intact — drop the staged attempt.
            fs.rmSync(stagingDir, { recursive: true, force: true });
          }
          // Otherwise the destination is already gone and the staged payload
          // inside stagingDir is the only recovery artifact: the container is
          // deliberately left in place while the error propagates.
          throw error;
        }
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } else {
        fs.cpSync(mutation.sourcePath, destinationPath, {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
          force: false,
          errorOnExist: true,
        });
      }
      return { sourcePath: mutation.sourcePath, destinationPath, deleted: false };
    }
    if (removedExisting) {
      // Staged file copy: write into an exclusive container while the
      // destination is still intact, then swap in, so a failed copy never
      // leaves the destination destroyed.
      const stagingDir = createStagingContainer(destinationDirectory, allowedRoots);
      const stagedPath = resolverFor(stagingDir, name).join(stagingDir, name);
      let destinationRemoved = false;
      try {
        fs.copyFileSync(mutation.sourcePath, stagedPath);
        removeExistingForOverwrite(destinationPath, allowedRoots);
        destinationRemoved = true;
        fs.renameSync(stagedPath, destinationPath);
      } catch (error) {
        if (!destinationRemoved) {
          // Destination intact — drop the staged attempt.
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }
        // Otherwise the destination is already gone and the staged payload
        // inside stagingDir is the only recovery artifact: the container is
        // deliberately left in place while the error propagates.
        throw error;
      }
      fs.rmSync(stagingDir, { recursive: true, force: true });
      return { sourcePath: mutation.sourcePath, destinationPath, deleted: false };
    }
    if (conflict === "keep-both") {
      // COPYFILE_EXCL so a racer that created the candidate between the
      // vacancy check and the copy cannot be silently overwritten. Re-derive
      // the next candidate from the original name.
      let target = destinationPath;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          fs.copyFileSync(mutation.sourcePath, target, fs.constants.COPYFILE_EXCL);
          return { sourcePath: mutation.sourcePath, destinationPath: target, deleted: false };
        } catch (error) {
          if (!isFileSystemError(error) || error.code !== "EEXIST") throw error;
          target = resolverFor(destinationDirectory).join(
            destinationDirectory,
            resolveKeepBothName(destinationDirectory, name),
          );
        }
      }
      throw new FileMutationError(409, "A file or directory with this name already exists");
    }
    // error mode: COPYFILE_EXCL so a racer cannot be silently overwritten;
    // EEXIST maps to 409 in mutateFile.
    fs.copyFileSync(mutation.sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    return { sourcePath: mutation.sourcePath, destinationPath, deleted: false };
  }

  if (removedExisting) {
    removeExistingForOverwrite(destinationPath, allowedRoots);
  }
  fs.renameSync(mutation.sourcePath, destinationPath);
  return { sourcePath: mutation.sourcePath, destinationPath, deleted: false };
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function mutateFile(
  mutation: FileMutation,
  allowedRoots: Set<string>,
): FileMutationResult {
  try {
    return executeMutation(mutation, allowedRoots);
  } catch (error) {
    if (error instanceof FileMutationError) throw error;
    if (isFileSystemError(error) && error.code === "ENOENT") {
      throw new FileMutationError(404, "File or directory not found");
    }
    if (isFileSystemError(error) && error.code === "EEXIST") {
      throw new FileMutationError(409, "A file or directory with this name already exists");
    }
    if (isFileSystemError(error) && error.code === "ENOTDIR") {
      throw new FileMutationError(400, "Target is not a directory");
    }
    if (isFileSystemError(error) && error.code === "ENOTEMPTY") {
      throw new FileMutationError(409, "Directory is not empty");
    }
    throw error;
  }
}
