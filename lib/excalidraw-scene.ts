import { fetchTextWithMetadata, type TextChunk } from "./chunked-file-read";

export type ExcalidrawElement = Record<string, unknown>;
export type BinaryFiles = Record<string, Record<string, unknown>>;
export type ExcalidrawAppState = Record<string, unknown>;

export type SceneChunk = {
  content?: string;
  nextOffset?: number;
  truncated?: boolean;
  size?: number;
  mtimeMs?: number;
  error?: string;
};

export type SceneText = {
  text: string;
  size: number;
  mtimeMs: number;
};

type SceneReadResponse = {
  json(): Promise<SceneChunk>;
};

/** appState fields persisted back into the scene file (no runtime UI state). */
export const SAVED_APP_STATE_KEYS = ["viewBackgroundColor", "gridSize", "gridModeEnabled"] as const;

/** appState fields describing the live viewport; never restored from disk. */
export const VIEWPORT_APP_STATE_KEYS = ["scrollX", "scrollY", "zoom", "offsetLeft", "offsetTop"] as const;

/**
 * Returns a copy of appState without viewport fields. Saved files can carry
 * stale scroll/zoom values that put the canvas content off-screen, so the
 * viewer always fits the viewport to the content instead.
 */
export function stripViewportState(appState: ExcalidrawAppState): ExcalidrawAppState {
  const next = { ...appState };
  for (const key of VIEWPORT_APP_STATE_KEYS) delete next[key];
  return next;
}

export async function fetchSceneText(
  fetchImpl: (url: string) => Promise<SceneReadResponse>,
  urlForOffset: (offset?: number) => string,
): Promise<SceneText> {
  return fetchTextWithMetadata(
    fetchImpl as unknown as (url: string) => Promise<{ json(): Promise<TextChunk> }>,
    urlForOffset,
    "Excalidraw scene",
  ) as Promise<SceneText>;
}

export function buildMergedScene(
  original: Record<string, unknown>,
  elements: ExcalidrawElement[],
  savedAppState: ExcalidrawAppState,
  files: BinaryFiles,
): Record<string, unknown> {
  const appState: Record<string, unknown> = {};
  for (const key of SAVED_APP_STATE_KEYS) {
    if (key in savedAppState) appState[key] = savedAppState[key];
  }

  return {
    ...original,
    elements,
    appState,
    files,
  };
}
