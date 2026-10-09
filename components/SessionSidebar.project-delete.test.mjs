// Source-level coverage for the project-wide delete orchestration added to
// SessionSidebar: the rail card's delete action calls the batch route, drops
// the project from the persisted rail history, and delegates active-tab cleanup
// to the existing single-session delete path when the open chat is affected.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const deleteStart = source.indexOf("const handleDeleteProject = useCallback");
const deleteEnd = source.indexOf("const canCreateSession", deleteStart);
const deleteSource = source.slice(deleteStart, deleteEnd);

test("handleDeleteProject is defined next to rail construction", () => {
  assert.notEqual(deleteStart, -1, "handleDeleteProject callback exists");
  assert.notEqual(deleteEnd, -1);
  // It is handed to ProjectRail so the hover card can invoke it.
  assert.match(source, /onDeleteProject=\{handleDeleteProject\}/);
});

test("handleDeleteProject calls the batch route with the project root", () => {
  assert.match(deleteSource, /\/api\/sessions\?projectRoot=/);
  assert.match(deleteSource, /method: "DELETE"/);
});

test("handleDeleteProject maps the running block (409) to blocked-running", () => {
  assert.match(deleteSource, /res\.status === 409/);
  assert.match(deleteSource, /blocked-running/);
});

test("handleDeleteProject removes the project from persisted rail history", () => {
  assert.match(deleteSource, /setProjectRailHistory\(/);
  assert.match(deleteSource, /entry\.key !== project\.key/);
});

test("handleDeleteProject relocates away via onProjectDeleted when project is active", () => {
  assert.match(deleteSource, /currentProjectKey !== project\.key/);
  assert.match(deleteSource, /getRecentProjects\(/);
  assert.match(deleteSource, /onProjectDeleted\?\.\(nextRoot\)/);
  assert.match(deleteSource, /loadSessions\(false, true\)/);
});

test("active-project delete refreshes before dropping history and relocating", () => {
  // Relocating against the stale snapshot let the selectedProject history
  // effect re-append (and re-persist) the just-deleted project, so its rail
  // tile never disappeared — the delete looked like a no-op.
  const activeBranch = deleteSource.slice(deleteSource.indexOf("deletedProjectKeysRef.current.add"));
  const refreshIndex = activeBranch.indexOf("await loadSessions(false, true)");
  const historyIndex = activeBranch.indexOf("setProjectRailHistory(");
  const relocateIndex = activeBranch.indexOf("setSelectedCwd(nextRoot)");
  assert.ok(refreshIndex !== -1, "active branch refreshes the session list");
  assert.ok(historyIndex > refreshIndex, "rail history drop happens after the refresh");
  assert.ok(relocateIndex > historyIndex, "relocation happens after the history drop");
  assert.match(deleteSource, /deletedProjectKeysRef\.current\.add\(project\.key\)/);
});

test("active-project delete jumps to the first remaining project in rail order", () => {
  // The jump target is the topmost remaining rail tile (what the user sees as
  // the first project), not the most recently active one.
  assert.match(deleteSource, /railProjects\.find\(/);
  assert.match(deleteSource, /candidate\.key !== project\.key && candidate\.root !== project\.root/);
  assert.match(deleteSource, /setSelectedCwd\(nextRoot\)/);
});

test("history-append effect skips projects deleted this turn", () => {
  const effectStart = source.indexOf("deletedProjectKeysRef = useRef");
  const effectEnd = source.indexOf("}, [selectedProject]);", effectStart);
  assert.notEqual(effectStart, -1);
  assert.notEqual(effectEnd, -1);
  const effectSource = source.slice(effectStart, effectEnd);
  assert.match(effectSource, /deletedProjectKeysRef\.current\.has\(selectedProject\.key\)/);
});

test("explicit selection clears the deletion guard (rail, dropdown, custom path, default cwd)", () => {
  const selectStart = source.indexOf("const selectProject = useCallback");
  const selectEnd = source.indexOf("}, []);", selectStart);
  assert.notEqual(selectStart, -1, "selectProject callback exists");
  const selectSource = source.slice(selectStart, selectEnd);
  assert.match(selectSource, /deletedProjectKeysRef\.current\.delete\(project\.key\)/);
  assert.match(selectSource, /deletedProjectKeysRef\.current\.delete\(project\.root\)/);
  // Both entrances route through the shared callback.
  assert.match(source, /onSelect=\{selectProject\}/);
  assert.match(source, /selectProject\(project\);/);
  // Re-adding a directory through the custom-path picker clears the guard too,
  // otherwise the re-added session-less project drops out of the rail history
  // and disappears as soon as another project is selected.
  const commitStart = source.indexOf("const commitCustomPath = useCallback");
  const commitEnd = source.indexOf("}, [customPathValue", commitStart);
  assert.notEqual(commitEnd, -1);
  const commitSource = source.slice(commitStart, commitEnd);
  assert.match(commitSource, /deletedProjectKeysRef\.current\.delete\(data\.projectKey\)/);
  assert.match(commitSource, /deletedProjectKeysRef\.current\.delete\(data\.projectRoot\)/);
  assert.match(commitSource, /deletedProjectKeysRef\.current\.delete\(data\.cwd\)/);
});
