import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./dropped-folders.ts");
}

function withWindow(value, callback) {
  const previous = globalThis.window;
  globalThis.window = value;
  try {
    return callback();
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
}

test("collectDroppedFolders resolves directory paths through the desktop runtime", async () => {
  const { collectDroppedFolders } = await loadSubject();
  withWindow({ piDesktop: { getPathForFile: (file) => file.nativePath ?? "" } }, () => {
    const result = collectDroppedFolders({
      files: [
        { name: "src", nativePath: "/work/src" },
        { name: "notes.txt", nativePath: "/work/notes.txt" },
      ],
      items: [
        { webkitGetAsEntry: () => ({ isDirectory: true }) },
        { webkitGetAsEntry: () => ({ isDirectory: false }) },
      ],
    });
    assert.deepEqual(result, { paths: ["/work/src"], hasDirectories: true });
  });
});

test("collectDroppedFolders reports unresolvable directories for plain browsers", async () => {
  const { collectDroppedFolders } = await loadSubject();
  // No window.piDesktop: the browser knows a folder was dropped but cannot
  // read its absolute path.
  withWindow({}, () => {
    const result = collectDroppedFolders({
      files: [{ name: "src" }],
      items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }],
    });
    assert.deepEqual(result, { paths: [], hasDirectories: true });
  });
});

test("collectDroppedFolders ignores plain file drops and deduplicates paths", async () => {
  const { collectDroppedFolders } = await loadSubject();
  withWindow({ piDesktop: { getPathForFile: (file) => file.nativePath ?? "" } }, () => {
    const filesOnly = collectDroppedFolders({
      files: [{ name: "a.ts", nativePath: "/work/a.ts" }],
      items: [{ webkitGetAsEntry: () => ({ isDirectory: false }) }],
    });
    assert.deepEqual(filesOnly, { paths: [], hasDirectories: false });

    const deduped = collectDroppedFolders({
      files: [
        { name: "src", nativePath: "/work/src" },
        { name: "src", nativePath: "/work/src" },
      ],
      items: [
        { webkitGetAsEntry: () => ({ isDirectory: true }) },
        { webkitGetAsEntry: () => ({ isDirectory: true }) },
      ],
    });
    assert.deepEqual(deduped, { paths: ["/work/src"], hasDirectories: true });
  });
});

test("isFileDrag only matches drags carrying OS filesystem entries", async () => {
  const { isFileDrag } = await loadSubject();
  assert.equal(isFileDrag(null), false);
  assert.equal(isFileDrag({ types: ["text/plain"] }), false);
  assert.equal(isFileDrag({ types: ["text/plain", "Files"] }), true);
  assert.equal(isFileDrag({ types: ["Files"] }), true);
});
