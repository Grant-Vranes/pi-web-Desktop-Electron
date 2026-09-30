import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./file-paths.ts");
}

test("Windows file paths compare without separator, case, or trailing slash differences", async () => {
  const { sameFilePath } = await loadSubject();
  assert.equal(sameFilePath("C:\\Repo\\src\\File.ts\\", "c:/repo/SRC/file.ts"), true);
});

test("POSIX file path comparison remains case-sensitive", async () => {
  const { sameFilePath } = await loadSubject();
  assert.equal(sameFilePath("/repo/src/File.ts", "/repo/src/file.ts"), false);
});
