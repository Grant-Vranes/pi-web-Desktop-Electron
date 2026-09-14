export interface DroppedFolderPaths {
  /** Absolute paths for dropped directories. Only populated when the desktop
   *  runtime (`window.piDesktop`) can map File objects to native paths; a
   *  plain browser never exposes the absolute path of an OS drag. */
  paths: string[];
  /** True when the drop carried at least one directory entry, even when the
   *  browser cannot resolve its absolute path. Lets the caller fall back to
   *  the directory picker instead of silently ignoring the drop. */
  hasDirectories: boolean;
}

export interface DroppedEntryLike {
  isDirectory?: boolean;
}

export interface DroppedItemLike {
  webkitGetAsEntry?: () => DroppedEntryLike | null;
}

/** Structural subset of DataTransfer so the collector stays unit-testable. */
export interface FolderDropData {
  files: ArrayLike<File>;
  items: ArrayLike<DroppedItemLike>;
}

/** True while a drag carries OS filesystem entries (files or folders).
 *  Internal app drags (project reorder, file mentions) set other types. */
export function isFileDrag(
  dataTransfer: { types: ArrayLike<string> } | null | undefined,
): boolean {
  if (!dataTransfer) return false;
  for (const type of Array.from(dataTransfer.types)) {
    if (type === "Files") return true;
  }
  return false;
}

/** Extracts the directories from an OS folder drop. Item order matches file
 *  order in Chromium-based runtimes, which is what the desktop shell and all
 *  supported browsers use. `webkitGetAsEntry` must be read synchronously
 *  inside the drop handler — callers pass `event.dataTransfer` directly. */
export function collectDroppedFolders(data: Partial<FolderDropData>): DroppedFolderPaths {
  const files = Array.from(data.files ?? []);
  const items = Array.from(data.items ?? []);
  const paths: string[] = [];
  const seen = new Set<string>();
  let hasDirectories = false;

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const entry = items[index]?.webkitGetAsEntry?.() ?? null;
    if (!entry?.isDirectory) continue;
    hasDirectories = true;
    const nativePath = typeof window === "undefined"
      ? ""
      : (window as unknown as {
          piDesktop?: { getPathForFile(file: File): string };
        }).piDesktop?.getPathForFile(file) ?? "";
    if (!nativePath || seen.has(nativePath)) continue;
    seen.add(nativePath);
    paths.push(nativePath);
  }

  return { paths, hasDirectories };
}
