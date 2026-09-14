import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

const readMessageFile = (name) =>
  readFile(new URL(`../lib/i18n/messages/${name}.ts`, import.meta.url), "utf8");

test("the project rail accepts OS folder drops via rail-level handlers", () => {
  // The rail nav wires the folder-drop handlers and highlights while a drag
  // hovers it.
  assert.match(source, /className=\{`project-rail\$\{folderDragActive \? " is-folder-drag" : ""\}`\}/);
  assert.match(source, /onDragEnter=\{handleFolderDragEnter\}/);
  assert.match(source, /onDragOver=\{handleFolderDragOver\}/);
  assert.match(source, /onDragLeave=\{handleFolderDragLeave\}/);
  assert.match(source, /onDrop=\{handleFolderDrop\}/);
  assert.match(source, /onAddDroppedFolders=\{handleDroppedProjectFolders\}/);
});

test("a prominent ready-to-receive overlay covers the rail during the drag", () => {
  assert.match(source, /className="project-rail-drop-overlay"/);
  // The overlay must not swallow drag events aimed at the rail handlers.
  assert.match(source, /project-rail-drop-overlay" aria-hidden="true"/);
  assert.match(source, /\{t\("sidebar\.dropToAddProject"\)\}/);
});

test("external file drags bypass the per-tile reorder handlers", () => {
  // Without this guard, dropping a folder on a tile would show reorder
  // insertion markers and the rail-level drop handler would never run.
  const tileDragOver = source.match(/onDragOver=\{\(event\) => \{[\s\S]*?isFileDrag[\s\S]*?\}\}/);
  assert.ok(tileDragOver, "tile onDragOver must ignore file drags");
  assert.match(
    source,
    /onDrop=\{\(event\) => \{\s*\n\s*if \(isFileDrag\(event\.dataTransfer\)\) return;\s*\n\s*event\.preventDefault\(\);/,
    "tile onDrop must ignore file drags",
  );
});

test("dropped folders are added through the same validate flow as manual selection", () => {
  assert.match(
    source,
    /for \(const path of dropped\.paths\) \{\s*\n\s*await commitCustomPath\(path\);/,
  );
});

test("a browser drop that cannot resolve paths shows a notice instead of opening a dialog", () => {
  // The dialog must not open on its own after a drop — the user complained
  // about being surprised by the picker. The notice explains the browser
  // limitation and offers an explicit button for the manual picker.
  assert.match(source, /if \(dropped\.hasDirectories\) showFolderDropNotice\(\);/);
  assert.doesNotMatch(
    source,
    /hasDirectories\) \s*\n\s*handleCustomPathClick\(\)/,
    "fallback must not auto-open the directory picker",
  );
  assert.match(source, /className="project-rail-drop-notice"/);
  assert.match(source, /onClick=\{\(\) => \{\s*\n\s*onDismissFolderDropNotice\(\);\s*\n\s*onAddProject\(\);\s*\n\s*\}\}/);
});

test("the drop hint string exists in every locale", async () => {
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const messages = await readMessageFile(locale);
    assert.match(messages, /"sidebar\.dropToAddProject"/, `${locale} is missing sidebar.dropToAddProject`);
    assert.match(messages, /"sidebar\.dropPathUnavailable"/, `${locale} is missing sidebar.dropPathUnavailable`);
  }
});
