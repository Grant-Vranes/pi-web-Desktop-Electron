import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("fetches worktree state for active cwd and passes branch/switcher data to ChatInput", () => {
  assert.match(source, /fetch\(`\/api\/worktrees\?cwd=\$\{encodeURIComponent\(activeCwd\)\}`/);
  // ChatWindow now loads the full worktree payload (not just currentBranch)
  // and stores it in a WorktreeState, so the chat-input bar can render an
  // interactive WorktreeSwitcher that matches the sidebar.
  assert.match(source, /setWorktreeState\(/);
  assert.match(source, /currentBranch=\{currentBranch\}/);
  assert.match(source, /worktreeState=\{showWorktreeSwitcher && !worktreeSwitcherLocked \? worktreeState : null\}/);
  assert.match(source, /onCwdChange=\{handleWorktreeSwitch\}/);
});

test("refreshes branch on visibility, focus, online, and visible polling", () => {
  assert.match(source, /document\.addEventListener\("visibilitychange", handleVisibility\)/);
  assert.match(source, /window\.addEventListener\("focus", handleWindowRefresh\)/);
  assert.match(source, /window\.addEventListener\("online", handleWindowRefresh\)/);
  assert.match(source, /if \(document\.visibilityState !== "visible"\) return;[\s\S]*?setInterval\(/);
});
