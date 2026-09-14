import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

// Server-only helper that moves a file or directory to the OS trash instead
// of deleting it permanently. Only imported by lib/file-mutations.ts; never
// from client components.

const EXEC_TIMEOUT_MS = 10_000;

class TrashError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
  }
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// "name", "name 2", "name 3", ... first name not taken in `directory`.
function uniqueNameIn(directory: string, name: string): string {
  if (!fs.existsSync(path.join(directory, name))) return name;
  const dot = name.lastIndexOf(".");
  const hasExtension = dot > 0;
  const base = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : "";
  for (let attempt = 2; attempt < 1000; attempt += 1) {
    const candidate = `${base} ${attempt}${extension}`;
    if (!fs.existsSync(path.join(directory, candidate))) return candidate;
  }
  throw new TrashError("Could not find a free trash name for this entry");
}

// rename() fails across devices; fall back to copy + remove so the entry
// still lands in the trash.
function moveToDirectory(target: string, destination: string): void {
  try {
    fs.renameSync(target, destination);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EXDEV") throw cause;
    fs.cpSync(target, destination, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(target, { recursive: true, force: false });
  }
}

// Fallback trash for macOS when Finder scripting is unavailable (SSH, CI):
// move the entry into the user's ~/.Trash, which Finder displays the same way.
export function moveToHomeTrash(target: string): void {
  const homeTrash = path.join(os.homedir(), ".Trash");
  fs.mkdirSync(homeTrash, { recursive: true });
  const name = uniqueNameIn(homeTrash, path.basename(target));
  moveToDirectory(target, path.join(homeTrash, name));
}

// XDG home trash (~/.local/share/Trash) with a .trashinfo record, used when
// `gio trash` is not installed on Linux.
export function moveToXdgHomeTrash(target: string): void {
  const trashRoot = path.join(os.homedir(), ".local", "share", "Trash");
  const filesDir = path.join(trashRoot, "files");
  const infoDir = path.join(trashRoot, "info");
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(infoDir, { recursive: true });
  const name = uniqueNameIn(filesDir, path.basename(target));
  const destination = path.join(filesDir, name);
  try {
    moveToDirectory(target, destination);
  } catch (cause) {
    throw new TrashError(`Could not move the entry to the trash: ${String(cause)}`, cause);
  }
  const deletionDate = new Date().toISOString().replace(/\.\d{3}Z$/, "");
  const trashInfo = [
    "[Trash Info]",
    `Path=${encodeURI(path.resolve(target))}`,
    `DeletionDate=${deletionDate}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(infoDir, `${name}.trashinfo`), trashInfo, "utf-8");
}

function trashWithFinder(target: string): void {
  try {
    execFileSync(
      "osascript",
      ["-e", `tell application "Finder" to delete POSIX file "${escapeAppleScriptString(target)}"`],
      { timeout: EXEC_TIMEOUT_MS, stdio: "ignore" },
    );
  } catch {
    moveToHomeTrash(target);
  }
}

function trashWithGio(target: string): void {
  try {
    execFileSync("gio", ["trash", target], { timeout: EXEC_TIMEOUT_MS, stdio: "ignore" });
  } catch {
    moveToXdgHomeTrash(target);
  }
}

function trashWithWindowsRecycleBin(target: string): void {
  const script = [
    "$path = @'",
    target,
    "'@",
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    "if (Test-Path -LiteralPath $path -PathType Container) {",
    "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($path, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    "} else {",
    "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($path, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    "}",
  ].join("\n");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: EXEC_TIMEOUT_MS,
    stdio: "ignore",
  });
}

export function moveToTrash(target: string): void {
  switch (process.platform) {
    case "darwin":
      trashWithFinder(target);
      return;
    case "linux":
      trashWithGio(target);
      return;
    case "win32":
      trashWithWindowsRecycleBin(target);
      return;
    default:
      throw new TrashError(`Moving to the trash is not supported on ${process.platform}`);
  }
}
