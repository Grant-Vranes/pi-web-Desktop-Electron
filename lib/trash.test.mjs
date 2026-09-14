import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

const source = (await readFile(new URL("./file-mutations.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("the delete mutation moves entries to the trash instead of removing them", () => {
  const deleteBranch = source.slice(
    source.indexOf('if (mutation.type === "delete")'),
    source.indexOf('const destinationDirectory = mutation.type === "rename"'),
  );
  assert.match(deleteBranch, /moveToTrash\(mutation\.sourcePath\)/);
  assert.doesNotMatch(deleteBranch, /rmSync/);
});

(test.platform === "win32" ? test.skip : test)("the trash module targets the OS-native trash per platform", async () => {
  const trashSource = (await readFile(new URL("./trash.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(trashSource, /case "darwin":\s*\n\s*trashWithFinder/);
  assert.match(trashSource, /case "linux":\s*\n\s*trashWithGio/);
  assert.match(trashSource, /case "win32":\s*\n\s*trashWithWindowsRecycleBin/);
});

(test.platform === "win32" ? test.skip : test)("moveToHomeTrash moves entries into $HOME/.Trash with conflict-safe names", async () => {
  const { moveToHomeTrash } = await jiti.import("./trash.ts");
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-trash-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-trash-src-"));
    const target = path.join(sourceDir, "note.txt");
    fs.writeFileSync(target, "hello");

    moveToHomeTrash(target);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.readFileSync(path.join(fakeHome, ".Trash", "note.txt"), "utf-8"), "hello");

    // A second entry with the same name lands under a unique name.
    fs.writeFileSync(target, "second");
    moveToHomeTrash(target);
    assert.equal(fs.readFileSync(path.join(fakeHome, ".Trash", "note 2.txt"), "utf-8"), "second");
    fs.rmSync(sourceDir, { recursive: true, force: true });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

(test.platform === "win32" ? test.skip : test)("moveToXdgHomeTrash writes an XDG trashinfo record", async () => {
  const { moveToXdgHomeTrash } = await jiti.import("./trash.ts");
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-trash-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-trash-src-"));
    const target = path.join(sourceDir, "report.log");
    fs.writeFileSync(target, "log");

    moveToXdgHomeTrash(target);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.readFileSync(path.join(fakeHome, ".local/share/Trash/files/report.log"), "utf-8"), "log");
    const trashInfo = fs.readFileSync(path.join(fakeHome, ".local/share/Trash/info/report.log.trashinfo"), "utf-8");
    assert.match(trashInfo, /^\[Trash Info\]\n/);
    assert.match(trashInfo, new RegExp(`^Path=${target.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}$`, "m"));
    assert.match(trashInfo, /DeletionDate=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    fs.rmSync(sourceDir, { recursive: true, force: true });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
