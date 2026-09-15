import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./dropped-paths.ts");
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

test("buildDropPayload keeps images separate and formats Electron file and directory paths", async () => {
  const { buildDropPayload } = await loadSubject();
  withWindow({ piDesktop: { getPathForFile: (file) => file.nativePath ?? "" } }, () => {
    const payload = buildDropPayload({
      files: [
        { type: "image/png", name: "screen.png", nativePath: "/tmp/screen.png" },
        { type: "text/plain", name: "a file.ts", nativePath: "/work/a file.ts" },
        { type: "", name: "src", nativePath: "/work/src" },
      ],
      items: [
        { webkitGetAsEntry: () => ({ isDirectory: false }) },
        { webkitGetAsEntry: () => ({ isDirectory: false }) },
        { webkitGetAsEntry: () => ({ isDirectory: true }) },
      ],
      getData: () => "",
    });

    assert.equal(payload.imageFiles.length, 1);
    assert.equal(payload.hasNonImageFiles, true);
    assert.equal(payload.pathMentions, '@"/work/a file.ts" @"/work/src/" ');
  });
});

test("buildDropPayload uses file URLs only when Electron paths are unavailable", async () => {
  const { buildDropPayload } = await loadSubject();
  withWindow({}, () => {
    const payload = buildDropPayload({
      files: [{ type: "text/plain", name: "ignored.txt" }],
      getData: (type) => type === "text/uri-list"
        ? "# Finder\nfile:///Users/a%20b/project/readme.md\nhttps://example.test/nope"
        : "",
    });

    assert.equal(payload.pathMentions, '@"/Users/a b/project/readme.md" ');
  });
});

test("buildDropPayload removes duplicate and malformed paths", async () => {
  const { buildDropPayload } = await loadSubject();
  withWindow({}, () => {
    const payload = buildDropPayload({
      files: [{ type: "text/plain", name: "unknown.txt" }],
      getData: () => "file:///tmp/a.ts\nfile:///tmp/a.ts\nfile://%zz",
    });

    assert.equal(payload.pathMentions, '@"/tmp/a.ts" ');
    assert.equal(payload.hasNonImageFiles, true);
  });
});

test("buildDropPayload identifies an unresolvable non-image drop without touching images", async () => {
  const { buildDropPayload } = await loadSubject();
  withWindow({}, () => {
    const payload = buildDropPayload({
      files: [{ type: "application/pdf", name: "outside.pdf" }],
      getData: () => "",
    });

    assert.equal(payload.imageFiles.length, 0);
    assert.equal(payload.hasNonImageFiles, true);
    assert.equal(payload.pathMentions, "");
  });
});

test("buildDropPayload classifies an internal file-explorer drag as an @mention path", async () => {
  const { buildDropPayload } = await loadSubject();
  withWindow({}, () => {
    const payload = buildDropPayload({
      files: [],
      items: [],
      types: ["application/x-pi-web-file-path", "application/x-pi-web-file-is-directory"],
      getData: (type) => type === "application/x-pi-web-file-path"
        ? "/Users/me/project/src/index.ts"
        : type === "application/x-pi-web-file-is-directory" ? "false" : "",
    });

    assert.equal(payload.internalPaths.length, 1);
    assert.equal(payload.internalPaths[0].path, "/Users/me/project/src/index.ts");
    assert.equal(payload.internalPaths[0].isDirectory, false);
    assert.equal(payload.hasNonImageFiles, true);
  });
});

test("buildDropPayload flags an internal directory drag as a directory mention", async () => {
  const { buildDropPayload } = await loadSubject();
  withWindow({}, () => {
    const payload = buildDropPayload({
      files: [],
      items: [],
      types: ["application/x-pi-web-file-path", "application/x-pi-web-file-is-directory"],
      getData: (type) => type === "application/x-pi-web-file-path"
        ? "/Users/me/project/src"
        : type === "application/x-pi-web-file-is-directory" ? "true" : "",
    });

    assert.equal(payload.internalPaths.length, 1);
    assert.equal(payload.internalPaths[0].isDirectory, true);
  });
});

test("buildDropPayload ignores an internal drag without a path value", async () => {
  const { buildDropPayload } = await loadSubject();
  withWindow({}, () => {
    const payload = buildDropPayload({
      files: [],
      items: [],
      types: ["application/x-pi-web-file-path"],
      getData: () => "",
    });

    assert.equal(payload.internalPaths.length, 0);
    assert.equal(payload.hasNonImageFiles, false);
  });
});

test("buildDropPayload flags an OS folder dropped in a plain browser as an unresolved directory", async () => {
  const { buildDropPayload } = await loadSubject();
  // No window.piDesktop: the browser knows a folder was dropped but cannot
  // read its absolute path, so it must be surfaced for an upload fallback.
  withWindow({}, () => {
    const payload = buildDropPayload({
      files: [{ name: "assets", type: "" }],
      items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }],
      getData: () => "",
    });

    assert.equal(payload.pathMentions, "");
    assert.equal(payload.hasUnresolvedDirectory, true);
    assert.equal(payload.hasNonImageFiles, true);
  });
});

test("buildDropPayload does not flag a resolvable desktop folder as unresolved", async () => {
  const { buildDropPayload } = await loadSubject();
  withWindow({ piDesktop: { getPathForFile: (file) => file.nativePath ?? "" } }, () => {
    const payload = buildDropPayload({
      files: [{ name: "assets", type: "", nativePath: "/work/assets" }],
      items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }],
      getData: () => "",
    });

    assert.equal(payload.pathMentions, '@"/work/assets/" ');
    assert.equal(payload.hasUnresolvedDirectory, false);
  });
});
