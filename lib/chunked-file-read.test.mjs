import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./chunked-file-read.ts");
}

function fakeResponse(chunk) {
  return { async json() { return chunk; } };
}

test("concatenates multi-chunk content and returns read metadata", async () => {
  const { fetchTextWithMetadata } = await loadSubject();
  const calls = [];
  const chunks = [
    { content: "hello ", nextOffset: 6, truncated: true, size: 12, mtimeMs: 100 },
    { content: "world", truncated: false, size: 12, mtimeMs: 100 },
  ];
  const result = await fetchTextWithMetadata(
    (url) => { calls.push(url); return Promise.resolve(fakeResponse(chunks[calls.length - 1])); },
    (offset) => `/api/files/x?offset=${offset ?? 0}`,
    "drawio file",
  );
  assert.equal(result.text, "hello world");
  assert.equal(result.size, 12);
  assert.equal(result.mtimeMs, 100);
  assert.equal(calls.length, 2);
});

test("error messages use the provided subject", async () => {
  const { fetchTextWithMetadata } = await loadSubject();
  await assert.rejects(
    fetchTextWithMetadata(
      () => Promise.resolve(fakeResponse({ mtimeMs: 1 })), // 缺 size → Missing ... read metadata
      () => "/api/files/x",
      "drawio file",
    ),
    (error) => error.message === "Missing drawio file read metadata",
  );
});

test("restarts when file mutates between chunks", async () => {
  const { fetchTextWithMetadata } = await loadSubject();
  let call = 0;
  const responses = [
    { content: "a", nextOffset: 1, truncated: true, size: 2, mtimeMs: 100 },
    { content: "b", truncated: true, size: 3, mtimeMs: 200 }, // mtime 变化 → 重来
    { content: "xy", nextOffset: 2, truncated: true, size: 3, mtimeMs: 200 },
    { content: "z", truncated: false, size: 3, mtimeMs: 200 },
  ];
  const result = await fetchTextWithMetadata(
    () => Promise.resolve(fakeResponse(responses[call++])),
    (offset) => `/api/files/x?offset=${offset ?? 0}`,
    "drawio file",
  );
  assert.equal(result.text, "xyz");
  assert.equal(result.mtimeMs, 200);
});
