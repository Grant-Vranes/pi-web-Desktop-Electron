import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const switcherSource = await readFile(new URL("./WorktreeSwitcher.tsx", import.meta.url), "utf8");
const typesSource = await readFile(new URL("../lib/worktree-types.ts", import.meta.url), "utf8");

test("uses the server-resolved current worktree identity", () => {
  // The worktree state type still carries the server-resolved current path.
  assert.match(typesSource, /currentWorktreePath: string \| null/);
  // The sidebar delegates rendering to the shared WorktreeSwitcher, which
  // resolves the active checkout from the server-resolved currentWorktreePath
  // (never from the raw selectedCwd string).
  assert.match(source, /<WorktreeSwitcher[\s\S]*?currentWorktreePath=\{currentWorktreePath\}/);
  assert.match(
    switcherSource,
    /const currentWorktree = worktreeState\.worktrees\.find\(\(w\) => w\.path === currentWorktreePath\)/,
  );
  assert.match(
    switcherSource,
    /const isCurrent = wt\.path === currentWorktreePath/,
  );
  // Removing the active checkout falls back to the project root.
  assert.match(
    switcherSource,
    /currentWorktreePath === path \? worktreeState\.projectRoot/,
  );
});
