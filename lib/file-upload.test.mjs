import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  // Loaded through jiti so the module's own extensionless imports (e.g.
  // "./path-security") resolve the way the app resolves them (tsconfig
  // moduleResolution: "bundler"); bare `import("./file-upload.ts")` only
  // works while that file has no local imports.
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./file-upload.ts");
}

test("validates upload names, accepting relative paths, rejecting traversal", async () => {
  const { validateUploadFileNames } = await loadSubject();

  // accepted
  assert.equal(validateUploadFileNames(["one.txt", "two file.md"]), null);
  assert.equal(validateUploadFileNames(["a/b/c.txt"]), null);
  assert.equal(validateUploadFileNames(["dir/sub/file.ts"]), null);

  // rejected: traversal / absolute / backslash / empty
  assert.match(validateUploadFileNames(["../secret.txt"]), /must not contain a path/);
  assert.match(validateUploadFileNames(["a/../b"]), /must not contain a path/);
  assert.match(validateUploadFileNames(["folder\\secret.txt"]), /backslashes/);
  assert.match(validateUploadFileNames(["/abs/path.txt"]), /absolute paths/);
  assert.match(validateUploadFileNames(["C:\\x"]), /backslashes/);
  assert.match(validateUploadFileNames(["C:/x"]), /absolute paths/);
  assert.match(validateUploadFileNames(["d:/folder/file.txt"]), /absolute paths/);
  assert.match(validateUploadFileNames(["a//b"]), /must not contain a path/);
  assert.match(validateUploadFileNames([""]), /Invalid file name/);

  // rejected: duplicates and empty array
  assert.match(validateUploadFileNames(["same.txt", "same.txt"]), /Duplicate/);
  assert.match(validateUploadFileNames([]), /No files/);
});

test("finds conflicts and prevents replacing directories", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  fs.mkdirSync(path.join(root, "directory"));

  assert.deepEqual(
    inspectUploadTargets(root, ["new.txt", "file.txt", "directory"]),
    {
      conflicts: ["file.txt", "directory"],
      nonReplaceable: ["directory"],
    },
  );
});

test("prevents replacing symbolic links", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  try {
    fs.symlinkSync("file.txt", path.join(root, "link.txt"));
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  assert.deepEqual(
    inspectUploadTargets(root, ["link.txt"]),
    {
      conflicts: ["link.txt"],
      nonReplaceable: ["link.txt"],
    },
  );
});

test("parses only supported conflict strategies", async () => {
  const { parseUploadConflictStrategy } = await loadSubject();

  assert.equal(parseUploadConflictStrategy(null), "error");
  assert.equal(parseUploadConflictStrategy("overwrite"), "overwrite");
  assert.equal(parseUploadConflictStrategy("skip"), "skip");
  assert.equal(parseUploadConflictStrategy("rename"), null);
});

test("writeUploadFiles writes flat files and returns uploaded names", async () => {
  const { writeUploadFiles } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-write-flat-"));
  try {
    const result = await writeUploadFiles(root, [
      { name: "a.txt", bytes: Buffer.from("hi") },
      { name: "b.txt", bytes: Buffer.from("yo") },
    ], { conflicts: [], nonReplaceable: [] }, "error");
    assert.deepEqual(result, { uploaded: ["a.txt", "b.txt"], skipped: [], errors: [] });
    assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "hi");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeUploadFiles creates subdirectories for relative paths", async () => {
  const { writeUploadFiles } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-write-rel-"));
  try {
    const result = await writeUploadFiles(root, [
      { name: "sub/dir/f.txt", bytes: Buffer.from("x") },
    ], { conflicts: [], nonReplaceable: [] }, "error");
    assert.deepEqual(result.uploaded, ["sub/dir/f.txt"]);
    assert.equal(fs.readFileSync(path.join(root, "sub", "dir", "f.txt"), "utf8"), "x");
    assert.ok(fs.statSync(path.join(root, "sub", "dir")).isDirectory());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeUploadFiles merge: overwrite writes into an existing directory", async () => {
  const { writeUploadFiles, inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-write-merge-"));
  try {
    fs.mkdirSync(path.join(root, "existing"));
    fs.writeFileSync(path.join(root, "existing", "keep.txt"), "old");
    const targets = ["existing/new.txt"];
    const inspection = inspectUploadTargets(root, targets);
    assert.deepEqual(inspection, { conflicts: [], nonReplaceable: [] });
    const result = await writeUploadFiles(root, [
      { name: "existing/new.txt", bytes: Buffer.from("new") },
    ], inspection, "overwrite");
    assert.deepEqual(result.uploaded, ["existing/new.txt"]);
    assert.equal(fs.readFileSync(path.join(root, "existing", "new.txt"), "utf8"), "new");
    assert.equal(fs.readFileSync(path.join(root, "existing", "keep.txt"), "utf8"), "old");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeUploadFiles overwrite replaces a conflicting file", async () => {
  const { writeUploadFiles, inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-write-over-"));
  try {
    fs.writeFileSync(path.join(root, "f.txt"), "old");
    const inspection = inspectUploadTargets(root, ["f.txt"]);
    assert.deepEqual(inspection.conflicts, ["f.txt"]);
    const result = await writeUploadFiles(root, [
      { name: "f.txt", bytes: Buffer.from("new") },
    ], inspection, "overwrite");
    assert.deepEqual(result.uploaded, ["f.txt"]);
    assert.equal(fs.readFileSync(path.join(root, "f.txt"), "utf8"), "new");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeUploadFiles skip skips conflicting items only", async () => {
  const { writeUploadFiles, inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-write-skip-"));
  try {
    fs.writeFileSync(path.join(root, "old.txt"), "old");
    const inspection = inspectUploadTargets(root, ["old.txt", "new.txt"]);
    const result = await writeUploadFiles(root, [
      { name: "old.txt", bytes: Buffer.from("x") },
      { name: "new.txt", bytes: Buffer.from("y") },
    ], inspection, "skip");
    assert.deepEqual(result.uploaded, ["new.txt"]);
    assert.deepEqual(result.skipped, ["old.txt"]);
    assert.equal(fs.readFileSync(path.join(root, "old.txt"), "utf8"), "old");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeUploadFiles non-replaceable conflict under overwrite writes inside existing dir, does not delete it", async () => {
  const { writeUploadFiles, inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-write-nr-"));
  try {
    fs.mkdirSync(path.join(root, "d"));
    const inspection = inspectUploadTargets(root, ["d"]);
    assert.deepEqual(inspection, { conflicts: ["d"], nonReplaceable: ["d"] });
    const result = await writeUploadFiles(root, [
      { name: "d", bytes: Buffer.from("x") },
    ], inspection, "overwrite");
    assert.equal(result.uploaded.length, 0);
    assert.equal(result.errors.length, 1);
    assert.ok(fs.statSync(path.join(root, "d")).isDirectory());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeUploadFiles error strategy leaves non-replaceable conflicts as errors without writing", async () => {
  const { writeUploadFiles, inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-write-err-"));
  try {
    fs.mkdirSync(path.join(root, "d"));
    const inspection = inspectUploadTargets(root, ["d"]);
    const result = await writeUploadFiles(root, [
      { name: "d", bytes: Buffer.from("x") },
    ], inspection, "error");
    assert.equal(result.uploaded.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /Cannot replace/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeUploadFiles rejects a relative path whose parent symlink escapes the upload root", async (t) => {
  const { writeUploadFiles, inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-write-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-write-outside-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  try {
    fs.symlinkSync(outside, path.join(root, "link"), "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  const names = ["link/file.txt"];
  const result = await writeUploadFiles(root, [
    { name: names[0], bytes: Buffer.from("outside") },
  ], inspectUploadTargets(root, names), "overwrite");

  assert.deepEqual(result.uploaded, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /path escapes upload directory/);
  assert.equal(fs.existsSync(path.join(outside, "file.txt")), false);
});
