import type { FileViewerState } from "@/lib/file-viewer-state";
import { getFileName, normalizeFilePathSlashes, sameFilePath } from "../lib/file-paths";
import type { Tab } from "./TabBar";

export type FileTabMutation =
  | { kind: "rename" | "move"; sourcePath: string; destinationPath: string }
  | { kind: "delete"; sourcePath: string };

interface OpenFileTabInput {
  fileName: string;
  filePath: string;
  modeHint?: "diff";
  sourceSessionId?: string | null;
  tabId: string;
}

export function openFileTab(tabs: Tab[], input: OpenFileTabInput): Tab[] {
  const existing = tabs.find((tab) => tab.id === input.tabId);
  if (!existing) {
    return [...tabs, {
      id: input.tabId,
      label: input.fileName,
      filePath: input.filePath,
      sourceSessionId: input.sourceSessionId,
      initialDisplayMode: input.modeHint,
      viewerState: input.modeHint ? {
        displayMode: input.modeHint,
        wrapLines: false,
        scrollTop: 0,
        scrollLeft: 0,
      } : undefined,
      viewerRevision: 0,
    }];
  }

  const sourceChanged = Boolean(
    input.sourceSessionId && existing.sourceSessionId !== input.sourceSessionId,
  );
  const sourceUnchanged = !sourceChanged;
  if (sourceUnchanged && !input.modeHint) return tabs;

  return tabs.map((tab) => {
    if (tab.id !== input.tabId) return tab;
    const next: Tab = { ...tab };
    if (sourceChanged) next.sourceSessionId = input.sourceSessionId;
    if (input.modeHint) {
      const previousState = tab.viewerState;
      const nextViewerState: FileViewerState = {
        ...(previousState ?? {}),
        displayMode: input.modeHint,
        wrapLines: previousState?.wrapLines ?? false,
        scrollTop: 0,
        scrollLeft: 0,
      };

      next.initialDisplayMode = input.modeHint;
      next.viewerState = nextViewerState;
      next.viewerRevision = (tab.viewerRevision ?? 0) + 1;
    } else if (sourceChanged) {
      next.viewerRevision = (tab.viewerRevision ?? 0) + 1;
    }
    return next;
  });
}

function isWindowsFilePath(filePath: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(filePath) || /^[/\\]{2}[^/\\]/.test(filePath);
}

function trimTrailingSeparators(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath);
  if (normalized === "/" || /^[a-zA-Z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, "");
}

function getMutationSuffix(filePath: string, sourcePath: string): string | null {
  const normalizedPath = trimTrailingSeparators(filePath);
  const normalizedSource = trimTrailingSeparators(sourcePath);
  if (sameFilePath(normalizedPath, normalizedSource)) return "";

  const useWindowsRules = isWindowsFilePath(normalizedPath) || isWindowsFilePath(normalizedSource);
  const comparablePath = useWindowsRules ? normalizedPath.toLowerCase() : normalizedPath;
  const comparableSource = useWindowsRules ? normalizedSource.toLowerCase() : normalizedSource;
  const sourcePrefix = comparableSource.endsWith("/") ? comparableSource : `${comparableSource}/`;
  if (!comparablePath.startsWith(sourcePrefix)) return null;

  return normalizedPath.slice(normalizedSource.length).replace(/^\/+/, "");
}

function replaceMutationPrefix(filePath: string, sourcePath: string, destinationPath: string): string | null {
  const suffix = getMutationSuffix(filePath, sourcePath);
  if (suffix === null) return null;
  const destination = trimTrailingSeparators(destinationPath);
  return suffix ? `${destination}/${suffix}` : destinationPath;
}

export function applyFileTabMutation(tabs: Tab[], mutation: FileTabMutation): Tab[] {
  let changed = false;
  if (mutation.kind === "delete") {
    const next = tabs.filter((tab) => {
      const affected = getMutationSuffix(tab.filePath, mutation.sourcePath) !== null;
      changed ||= affected;
      return !affected;
    });
    return changed ? next : tabs;
  }

  const next = tabs.map((tab) => {
    const destination = replaceMutationPrefix(tab.filePath, mutation.sourcePath, mutation.destinationPath);
    if (destination === null) return tab;
    changed = true;
    return {
      ...tab,
      id: `file:${destination}`,
      filePath: destination,
      label: getFileName(destination),
    };
  });
  return changed ? next : tabs;
}

export function getNextActiveFileTabId(
  tabsBefore: Tab[],
  activeTabId: string | null,
  mutation: FileTabMutation,
): string | null {
  const nextTabs = applyFileTabMutation(tabsBefore, mutation);
  if (activeTabId === null) return null;

  const activeTab = tabsBefore.find((tab) => tab.id === activeTabId);
  if (activeTab && getMutationSuffix(activeTab.filePath, mutation.sourcePath) !== null) {
    if (mutation.kind !== "delete") {
      const destination = replaceMutationPrefix(
        activeTab.filePath,
        mutation.sourcePath,
        mutation.destinationPath,
      );
      return destination === null ? activeTabId : `file:${destination}`;
    }
    return nextTabs.at(-1)?.id ?? null;
  }

  return nextTabs.some((tab) => tab.id === activeTabId) ? activeTabId : nextTabs.at(-1)?.id ?? null;
}

export function saveFileViewerState(
  tabs: Tab[],
  tabId: string,
  viewerRevision: number,
  viewerState: FileViewerState,
): Tab[] {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1 || (tabs[index].viewerRevision ?? 0) !== viewerRevision) return tabs;

  const next = [...tabs];
  next[index] = { ...next[index], viewerState };
  return next;
}

// --- Per-project file tab persistence ---------------------------------------

const PROJECT_FILE_TABS_PREFIX = "pi-file-tabs:";

function sanitizeTabForStorage(tab: Tab): Tab {
  // Unsaved editor drafts can be large and are already persisted per session
  // draft; drop them from the per-project snapshot to keep storage light.
  const viewerState = tab.viewerState
    ? { ...tab.viewerState, draft: null }
    : undefined;
  return { ...tab, closing: false, viewerState };
}

export function saveProjectFileTabs(
  projectKey: string,
  tabs: Tab[],
  activeTabId: string | null,
): void {
  try {
    if (tabs.length === 0) {
      window.localStorage.removeItem(PROJECT_FILE_TABS_PREFIX + projectKey);
      return;
    }
    const payload = { tabs: tabs.map(sanitizeTabForStorage), activeTabId };
    window.localStorage.setItem(
      PROJECT_FILE_TABS_PREFIX + projectKey,
      JSON.stringify(payload),
    );
  } catch { /* storage is optional */ }
}

export function loadProjectFileTabs(
  projectKey: string,
): { tabs: Tab[]; activeTabId: string | null } | null {
  try {
    const raw = window.localStorage.getItem(PROJECT_FILE_TABS_PREFIX + projectKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { tabs?: Tab[]; activeTabId?: unknown };
    if (!Array.isArray(parsed.tabs)) return null;
    const tabs = parsed.tabs
      .filter((tab): tab is Tab =>
        Boolean(tab) && typeof tab.id === "string" && typeof tab.filePath === "string")
      .map((tab) => ({ ...tab, closing: false, viewerRevision: 0 }));
    const activeTabId = typeof parsed.activeTabId === "string"
      && tabs.some((tab) => tab.id === parsed.activeTabId)
      ? parsed.activeTabId
      : tabs[0]?.id ?? null;
    return { tabs, activeTabId };
  } catch {
    return null;
  }
}
