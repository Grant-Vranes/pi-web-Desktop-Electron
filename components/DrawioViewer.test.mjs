import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./DrawioViewer.tsx", import.meta.url), "utf8");

test("pins every drawio asset base to the vendored copy — no network defaults", () => {
  assert.doesNotMatch(source, /viewer\.diagrams\.net/);
  for (const key of ["STYLE_PATH", "SHAPES_PATH", "STENCIL_PATH", "GRAPH_IMAGE_PATH", "mxImageBasePath", "mxBasePath", "RESOURCE_BASE", "DRAW_MATH_URL"]) {
    assert.match(source, new RegExp(`${key}: \`\\$\{DRAWIO_APP_BASE\}`), `missing local override for ${key}`);
  }
});

test("checks vendored assets before rendering and falls back on failure", () => {
  assert.match(source, /DRAWIO_VERSION/);
  assert.match(source, /onFallbackToText\(\)/);
});

test("view mode constructs a read-only GraphViewer from the file XML", () => {
  assert.match(source, /GraphViewer\?: GraphViewerCtor/); // 取到全局构造器
  assert.match(source, /new ctor\(host, parsed/);
  assert.match(source, /new DOMParser\(\)\.parseFromString\(xml, "text\/xml"\)/);
  assert.doesNotMatch(source, /edit:\s*["'_]/); // 查看模式不提供编辑入口
});

test("reads the file through the shared chunked reader with the drawio subject", () => {
  assert.match(source, /fetchTextWithMetadata\(/);
  assert.match(source, /"drawio file"/);
  assert.match(source, /isValidDrawioXml\(/);
});

test("external file changes reload only outside edit mode", () => {
  assert.match(source, /modeRef\.current === "view"[\s\S]*?void loadFile\(\)/s);
});

test("edit mode validates iframe messages by source and same origin", () => {
  assert.match(source, /event\.source !== frameRef\.current\?\.contentWindow/);
  assert.match(source, /event\.origin !== window\.location\.origin/);
  assert.match(source, /action: "load", xml: initialEditXml \?\? undefined, autosave: 1/);
});

test("first observed save is a baseline, not an edit", () => {
  assert.match(source, /if \(lastBaselineRef\.current === null\) \{[\s\S]*?lastBaselineRef\.current = record\.xml;/s);
});

test("saves are debounced and flushed on exit and unmount", () => {
  assert.match(source, /CHANGE_DEBOUNCE_MS = 500/);
  assert.match(source, /const exitEdit = useCallback[\s\S]*?flushPending\(\)/s);
  assert.match(source, /useEffect\(\s*\(\) => \(\) => \{[\s\S]*?flushPendingRef\.current\(\)/s);
});

test("write sends baseMtimeMs and handles 409 conflicts with force overwrite", () => {
  assert.match(source, /baseMtimeMs:\s*options\.force\s*\?\s*null\s*:\s*baseMtimeMsRef\.current/);
  assert.match(source, /response\.status === 409/);
  assert.match(source, /setSaveConflict\(true\)/);
  assert.match(source, /writeXml\(content, \{ force: true \}\)/);
});

test("edit iframe is same-origin with embed protocol params", () => {
  assert.match(source, /embed: "1",\s*proto: "json",\s*ui: "kennedy",\s*noExitBtn: "1",\s*spin: "1"/s);
  assert.match(source, /DRAWIO_APP_BASE\}\/index\.html/);
});

test("entering edit mode invalidates in-flight reads and resets baselines", () => {
  assert.match(source, /const enterEdit = useCallback[\s\S]*?readRequestRef\.current \+= 1;/s);
  assert.match(source, /lastBaselineRef\.current = null;/);
});

test("conflict UI is an overlay, not an iframe-replacing branch", () => {
  assert.match(source, /saveConflict && \(/);
  assert.doesNotMatch(source, /\) : saveConflict \?/);
});

test("exitEdit is blocked while the conflict overlay is up", () => {
  assert.match(source, /const exitEdit = useCallback\(\(\) => \{\s*\n[\s\S]{0,200}?if \(saveConflict\) return;/s);
});
