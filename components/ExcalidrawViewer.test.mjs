import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ExcalidrawViewer.tsx", import.meta.url), "utf8");
const fileViewerSource = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

test("loads the Excalidraw canvas lazily, client-only", () => {
  assert.match(source, /dynamic\(\s*\(\)\s*=>\s*[\s\S]*?import\("@excalidraw\/excalidraw"\)/s);
  assert.match(source, /\{\s*ssr:\s*false/);
});

test("shows loading placeholders for both lazy boundaries", () => {
  assert.match(source, /function LoadingPlaceholder\(\)/);
  assert.match(source, /t\("i18n\.loading"\)/);
  assert.match(source, /loading:\s*\(\) => <LoadingPlaceholder \/>/);
  assert.match(fileViewerSource, /function FileViewerLoadingPlaceholder\(\)/);
  assert.match(fileViewerSource, /loading:\s*\(\) => <FileViewerLoadingPlaceholder \/>/);
});

test("renders view-only canvas in view mode", () => {
  assert.match(source, /viewModeEnabled=\{mode === "view"\}/);
});

test("strips saved viewport state and scrolls the canvas back to content", () => {
  assert.match(source, /appState: stripViewportState\(scene\.appState\)/);
  assert.match(source, /excalidrawAPI=\{handleExcalidrawApi\}/);
  assert.match(source, /Api\.scrollToContent\(\s*undefined,\s*\{ fitToViewport: true/);
  assert.match(source, /requestAnimationFrame\(\(\) => \{[\s\S]*?scrollToContent/s);
});

test("disables the edit button until the scene is loaded", () => {
  assert.match(source, /<button type="button" style=\{ICON_BUTTON_STYLE\} disabled=\{!scene\} onClick=\{enterEdit\}>/);
});

test("persists only scene fields via shared merge helper", () => {
  assert.match(source, /buildMergedScene\(/);
  assert.doesNotMatch(source, /type:\s*"excalidraw"/);
  assert.doesNotMatch(source, /version:\s*typeof original\.version/);
});

test("loads scene text and save baseline from the chunked read helper", () => {
  assert.match(source, /const \{ text, mtimeMs, size: readSize \} = await fetchSceneText\(fetch, \(offset\) =>/);
  assert.match(source, /getFileApiUrl\(filePath, "read", sourceSessionId, \{ offset \}\)/);
  assert.match(source, /baseMtimeMsRef\.current = mtimeMs;/);
  assert.match(source, /setSize\(readSize\);/);
  assert.doesNotMatch(source, /meta\?\.mtimeMs/);
});

test("clears stale scene on load failures and hides the canvas while an error is shown", () => {
  assert.match(source, /catch \(loadError\) \{[\s\S]*?setScene\(null\);[\s\S]*?setError\(loadError instanceof Error \? loadError\.message : String\(loadError\)\);/);
  assert.match(source, /\{scene && !error && !saveConflict && \(/);
});

test("save sends baseMtimeMs and handles 409 conflicts", () => {
  assert.match(source, /baseMtimeMs:\s*options\.force\s*\?\s*null\s*:\s*baseMtimeMsRef\.current/);
  assert.match(source, /response\.status === 409/);
  assert.match(source, /setSaveConflict\(true\)/);
});

test("asks before discarding unsaved edits and always reloads after confirmed exit", () => {
  assert.match(source, /window\.confirm\(t\("i18n\.confirmDiscard"\)\)/);
  assert.match(source, /const exitEdit = useCallback[\s\S]*?setMode\("view"\);[\s\S]*?setDirty\(false\);[\s\S]*?void loadScene\(\);/);
  assert.doesNotMatch(source, /if \(dirty\) loadScene\(\)/);
});

test("entering edit mode invalidates in-flight scene reads", () => {
  assert.match(source, /const enterEdit = useCallback[\s\S]*?sceneRequestRef\.current \+= 1;[\s\S]*?setMode\("edit"\);/);
});

test("external file changes reload the scene only outside edit mode", () => {
  assert.match(source, /modeRef\.current === "view"[\s\S]*?void loadScene\(\)/);
});

test("save errors render above the canvas without unmounting it", () => {
  assert.match(source, /saveError && !error && !saveConflict/);
  assert.match(source, /zIndex:\s*2/);
  assert.match(source, /position:\s*"absolute", inset: 0, zIndex: 1/);
});

test("offers a text-viewer fallback when the scene cannot be parsed", () => {
  assert.match(source, /onFallbackToText\(\)/);
});

test("FileViewer dispatches .excalidraw files to ExcalidrawViewer before the text viewer", () => {
  assert.match(fileViewerSource, /isExcalidrawPath\(filePath\)/);
  assert.match(fileViewerSource, /<ExcalidrawViewer/);
  assert.match(fileViewerSource, /onFallbackToText=\{\(\) => setTextFallback\(true\)\}/);
});
