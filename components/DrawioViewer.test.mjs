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
