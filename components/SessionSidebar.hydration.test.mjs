import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("new session button disabled state is derived from selected cwd, not hydration", () => {
  assert.doesNotMatch(
    source,
    /const newSessionDisabled = hydrated \? !selectedCwd : undefined;/,
    "omitting disabled before hydration makes server HTML differ from the client when no cwd is selected",
  );
  assert.match(source, /const newSessionDisabled = !selectedCwd;/);
});
