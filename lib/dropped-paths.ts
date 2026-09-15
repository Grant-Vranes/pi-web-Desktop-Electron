export interface DroppedPath {
  path: string;
  isDirectory: boolean;
}

export interface DropPayload {
  imageFiles: File[];
  pathMentions: string;
  hasNonImageFiles: boolean;
  /** Absolute paths dragged from the in-app file explorer (@ mention targets). */
  internalPaths: DroppedPath[];
  /** True when the drop carried an OS directory whose absolute path could not
   *  be resolved (plain browser). Lets the caller fall back to uploading the
   *  folder contents instead of showing a path error. */
  hasUnresolvedDirectory: boolean;
}

// Drag types set by the FileExplorer tree rows so a file dragged onto the
// chat input (or another explorer node) can be identified as an internal
// @-mention rather than an OS file upload. Keep in sync with FileExplorer.
const INTERNAL_FILE_DRAG_TYPE = "application/x-pi-web-file-path";
const INTERNAL_DIRECTORY_DRAG_TYPE = "application/x-pi-web-file-is-directory";

declare global {
  interface Window {
    piDesktop?: {
      getPathForFile(file: File): string;
    };
  }
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

function isDirectoryItem(item: DataTransferItem | undefined, file: File): boolean {
  const entry = item?.webkitGetAsEntry?.();
  return entry?.isDirectory === true || file.webkitRelativePath?.endsWith("/") === true;
}

/**
 * Resolve an OS file's absolute path, trying every source the runtime can
 * expose, in order:
 *   1. piDesktop.getPathForFile (Electron shell) - canonical on the desktop app.
 *   2. File#path - legacy non-standard Property exposed by older Electron or
 *      webkit builds where webUtils is unavailable.
 * Returns "" when no path is readable (plain browser: security block).
 */
function resolveNativePath(file: File): string {
  const withPath = file as File & { path?: string };
  if (typeof window !== "undefined") {
    const desktopPath = window.piDesktop?.getPathForFile(file) ?? "";
    if (desktopPath) return desktopPath;
  }
  return withPath.path ?? "";
}

function formatPathMention({ path, isDirectory }: DroppedPath): string {
  const normalized = isDirectory && !path.endsWith("/") ? `${path}/` : path;
  const escaped = normalized.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `@"${escaped}" `;
}

function fileUrls(uriList: string): string[] {
  return uriList.split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
}

function pathFromFileUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const path = decodeURIComponent(url.pathname);
    if (!path) return null;
    return /^\/[a-zA-Z]:\//.test(path) ? path.slice(1) : path;
  } catch {
    return null;
  }
}

function uniquePaths(paths: DroppedPath[]): DroppedPath[] {
  const seen = new Set<string>();
  return paths.filter((entry) => {
    const normalized = entry.isDirectory && !entry.path.endsWith("/")
      ? `${entry.path}/`
      : entry.path;
    const key = `${entry.isDirectory ? "directory" : "file"}:${normalized}`;
    if (!normalized || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildDropPayload(dataTransfer: DataTransfer): DropPayload {
  const files = Array.from(dataTransfer.files);
  const items = Array.from(dataTransfer.items ?? []);
  const imageFiles = files.filter(isImageFile);
  const nonImageFiles = files.filter((file) => !isImageFile(file));
  const hasNonImageFiles = nonImageFiles.length > 0;
  const paths: DroppedPath[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (isImageFile(file)) continue;
    const nativePath = resolveNativePath(file);
    if (!nativePath) continue;
    paths.push({
      path: nativePath,
      isDirectory: isDirectoryItem(items[index], file),
    });
  }

  // A directory entry yields no native path in a plain browser (no piDesktop),
  // so flag it: the caller can fall back to uploading the folder contents.
  const hasUnresolvedDirectory = items.some((item) => item?.webkitGetAsEntry?.()?.isDirectory === true)
    && paths.every((entry) => !entry.isDirectory);

  if (paths.length === 0 && hasNonImageFiles) {
    for (const value of fileUrls(dataTransfer.getData("text/uri-list"))) {
      const path = pathFromFileUrl(value);
      if (path) paths.push({ path, isDirectory: false });
    }
  }

  const internalPaths: DroppedPath[] = (dataTransfer.types ?? []).includes(INTERNAL_FILE_DRAG_TYPE)
    ? [{ path: dataTransfer.getData(INTERNAL_FILE_DRAG_TYPE), isDirectory: dataTransfer.getData(INTERNAL_DIRECTORY_DRAG_TYPE) === "true" }].filter((entry) => entry.path)
    : [];

  return {
    imageFiles,
    hasNonImageFiles: hasNonImageFiles || (internalPaths.length > 0),
    pathMentions: uniquePaths(paths).map(formatPathMention).join(""),
    internalPaths,
    hasUnresolvedDirectory,
  };
}
