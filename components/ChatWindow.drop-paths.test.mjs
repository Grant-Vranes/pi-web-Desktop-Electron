import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("partitions dropped images and path mentions without uploading path items", () => {
  assert.match(source, /const onDrop = useCallback\(\(\{ imageFiles, pathMentions, hasNonImageFiles, internalPaths, hasUnresolvedDirectory \}: DropPayload, dataTransfer: DataTransfer\) => \{/);
  assert.match(source, /if \(imageFiles\.length > 0\) chatInputRef\?\.current\?\.addImages\(imageFiles\);/);
  assert.match(source, /if \(pathMentions\) \{\s*chatInputRef\?\.current\?\.insertPathMentions\(pathMentions\);\s*return;\s*}/);
  assert.match(source, /if \(hasNonImageFiles\) addNotice\(\{ type: "warning", message: "Could not access the dropped item's local path in this browser" \}\);/);
});

test("rewrites internal file-explorer drags as relative @mentions", () => {
  assert.match(source, /internalPaths\.length > 0/);
  assert.match(source, /buildAtMentionText\(getRelativeFilePath\(path, cwd\), isDirectory\)/);
  assert.match(source, /chatInputRef\?\.current\?\.insertText\(mentions\)/);
  assert.match(source, /import \{ buildAtMentionText \} from "@\/lib\/file-fuzzy"/);
  assert.match(source, /import \{ getRelativeFilePath \} from "@\/lib\/file-paths"/);
});

test("imports an unresolvable OS folder into the project instead of showing a path error", () => {
  assert.match(source, /hasUnresolvedDirectory\) \{\s*void importDroppedFolder\(dataTransfer\);/);
  assert.match(source, /collectDroppedUploadEntries\(dataTransfer\)/);
  assert.match(source, /\?type=upload&conflict=overwrite/);
  assert.match(source, /uploaded\.map\(\(path\) => buildAtMentionText\(path, false\)\)/);
  assert.match(source, /import \{ collectDroppedUploadEntries \} from "@\/lib\/drop-collect"/);
});

test("uses a generic path-or-image drop affordance", () => {
  assert.match(source, /Drop files, folders, or images to add them to your message/);
});