import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("explorer nodes expose a native contextual mutation menu", () => {
  assert.match(source, /onContextMenu=\{\(event\) => onContextMenu\?\.\(node, event\)\}/);
  assert.match(source, /type: "create-file" \| "create-directory" \| "rename" \| "move" \| "copy" \| "delete"/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /role="menu"/);
});

test("destructive and drag-move controls enforce the agreed safeguards", () => {
  assert.match(source, /window\.confirm\(/);
  assert.match(source, /dataTransfer\.setData\("application\/x-pi-web-file-path", node\.fullPath\)/);
  assert.match(source, /onFileMutation\?\.\(\{ kind: "delete", sourcePath: target\.fullPath \}\)/);
  // Drag-move rejects dropping a folder onto itself or a descendant.
  assert.match(source, /sameFilePath\(target\.fullPath, sourcePath\) \|\| \(sourceIsDir && isPathWithin\(target\.fullPath, sourcePath\)\)/);
});

test("the contextual menu no longer offers a move-to picker", () => {
  assert.doesNotMatch(source, /openMovePicker/);
  assert.doesNotMatch(source, /files\.moveTo/);
  assert.doesNotMatch(source, /files\.selectDestination/);
});

test("mutation errors remain available inside the active name dialog", () => {
  assert.match(source, /pendingMutation && mutationError && \(\s*<div role="alert"/);
  assert.doesNotMatch(source, /fetchEntries\([^)]*\)\.then\(/);
});

test("context menu actions are disabled during mutations", () => {
  const menuSection = source.slice(source.indexOf("{contextMenu && (() => {"), source.indexOf("{pendingMutation && ("));
  // Sibling create-file/create-directory (2), copy, cut, rename and delete use
  // the shared busy guard; the dir-inside create pair and paste add their own.
  assert.equal((menuSection.match(/disabled=\{mutationBusy\}/g) ?? []).length, 8);
});

test("clipboard holds a single entry set from the context menu", () => {
  assert.match(source, /useState<\{ path: string; mode: "copy" \| "cut" \} \| null>\(null\)/);
  assert.match(source, /setLastContextEntry\(\{ path: target\.fullPath, isDir: target\.isDir \}\)/);
  assert.match(source, /setClipboard\(\{ path: target\.fullPath, mode: "copy" \}\)/);
  assert.match(source, /setClipboard\(\{ path: target\.fullPath, mode: "cut" \}\)/);
});

test("context menu offers sibling creation with icons and keeps delete last", () => {
  const menuSection = source.slice(source.indexOf("{contextMenu && (() => {"), source.indexOf("{pendingMutation && ("));
  const siblingCreate = menuSection.indexOf("files.newFileSibling");
  const deleteItem = menuSection.indexOf("files.delete");
  assert.ok(siblingCreate >= 0, "sibling create-file entry exists");
  assert.ok(deleteItem > siblingCreate, "delete renders after sibling create");
  assert.match(menuSection, /siblingDirectoryNode/);
  assert.match(menuSection, /MenuIconFilePlus/);
  assert.match(menuSection, /MenuIconFolderPlus/);
  assert.match(menuSection, /MenuIconTrash/);
  assert.match(menuSection, /MenuSeparator/);
});

test("context menu stays inside the viewport when opened near an edge", () => {
  assert.match(source, /const contextMenuRef = useRef<HTMLDivElement \| null>\(null\);/);
  assert.match(source, /useLayoutEffect\(\(\) => \{\s*if \(!contextMenu\) return;\s*const menu = contextMenuRef\.current;/);
  assert.match(source, /window\.innerWidth - rect\.width - margin/);
  assert.match(source, /window\.innerHeight - rect\.height - margin/);
  assert.match(source, /Math\.max\(margin, Math\.min\(contextMenu\.x, maxLeft\)\)/);
  assert.match(source, /Math\.max\(margin, Math\.min\(contextMenu\.y, maxTop\)\)/);
});

test("mutations reveal and select the resulting node", () => {
  assert.match(source, /const revealAndSelect = useCallback\(\(path: string \| null\) => \{/);
  assert.match(source, /if \(type === "delete"\) revealAndSelect\(getFileDirectory\(target\.fullPath\)\);/);
  assert.match(source, /else if \(result\.destinationPath\) revealAndSelect\(result\.destinationPath\);/);
  assert.match(source, /selectedPath=\{selectedPath\}/);
  assert.match(source, /onSelect=\{revealAndSelect\}/);
  assert.match(source, /: selected\s*\? "var\(--bg-selected\)"/);
});

test("entries held as cut render dimmed", () => {
  assert.match(source, /const isCut = cutPath !== null && cutPath !== undefined && sameFilePath\(cutPath, node\.fullPath\)/);
  assert.match(source, /opacity: isCut \? 0\.5 : 1/);
  assert.match(source, /cutPath=\{cutPath\}/);
});

test("copy and cut menu labels exist in every locale", async () => {
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const messages = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    assert.match(messages, /"files\.copy":/);
    assert.match(messages, /"files\.cut":/);
  }
});

test("name dialog handles Escape from the form and associates its label", () => {
  const dialogForm = source.slice(source.indexOf("<form onSubmit="), source.indexOf("</form>"));
  assert.match(dialogForm, /onKeyDown=\{\(event\) => \{ if \(event\.key === "Escape"\) setPendingMutation\(null\); \}\}/);
  assert.match(dialogForm, /<label htmlFor="file-mutation-name"/);
  assert.match(dialogForm, /<input id="file-mutation-name"/);
});

test("rejects malformed success responses with empty or whitespace paths", () => {
  const validationBlock = source.slice(
    source.indexOf("if (\n    !data"),
    source.indexOf("return data as MutationResponse;"),
  );
  assert.match(validationBlock, /data\.sourcePath\.trim\(\)\.length === 0/);
  assert.match(validationBlock, /data\.destinationPath\.trim\(\)\.length === 0/);
});

test("project switches clear clipboard and conflict state", () => {
  assert.match(source, /setClipboard\(null\);\s*setLastContextEntry\(null\);\s*setPasteConflict\(null\);/);
});

test("mutation server errors carry the HTTP status for conflict detection", () => {
  assert.match(source, /class FileMutationServerError extends Error \{/);
  assert.match(source, /public readonly status: number/);
  assert.match(source, /throw new FileMutationServerError\(data\.error, response\.status\)/);
  assert.match(source, /type === "rename" \|\| type === "move" \|\| type === "copy"/);
});

test("keyboard shortcuts scope copy, cut and paste to the explorer tree", () => {
  assert.match(source, /const handleExplorerKeyDown = useCallback\(\(event: React\.KeyboardEvent\) => \{/);
  assert.match(source, /if \(!\(event\.metaKey \|\| event\.ctrlKey\) \|\| event\.altKey \|\| event\.shiftKey\) return;/);
  assert.match(source, /target\.tagName === "INPUT" \|\| target\.tagName === "TEXTAREA" \|\| target\.isContentEditable/);
  assert.match(source, /selection\.toString\(\)\.length > 0/);
  assert.match(source, /tabIndex=\{0\}/);
  assert.match(source, /onKeyDown=\{handleExplorerKeyDown\}/);
});

test("paste resolves a smart destination and reports conflicts via dialog", () => {
  assert.match(source, /const pasteDestinationDirectory = useMemo\(/);
  assert.match(source, /cause\.status === 409 && conflict === "error"/);
  assert.match(source, /setPasteConflict\(\{ type, sourcePath, destinationDirectory, name: getFileName\(sourcePath\) \}\)/);
  assert.match(source, /t\("files\.conflictOverwrite"\)/);
  assert.match(source, /t\("files\.conflictKeepBoth"\)/);
  assert.match(source, /disabled=\{mutationBusy \|\| !clipboard\}/);
});
