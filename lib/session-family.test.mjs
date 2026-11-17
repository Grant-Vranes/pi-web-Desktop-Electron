import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { getAgentStripMembers, getAgentsBadge, getSessionFamily, groupFamiliesByDay, listSessionFamilies } = await createJiti(import.meta.url).import("./session-family.ts");

function session(id, modified, relation) {
  return {
    path: `/tmp/${id}.jsonl`,
    id,
    cwd: "/tmp",
    created: modified,
    modified,
    messageCount: 1,
    firstMessage: id,
    ...(relation ? { relation } : {}),
  };
}

test("groups nested subagents under their main session and uses family activity for sorting", () => {
  const main = session("main", "2026-01-01T00:00:00.000Z");
  const child = session("child", "2026-01-04T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "main", profile: "explore", description: "Explore", status: "completed",
  });
  const grandchild = session("grandchild", "2026-01-03T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "child", profile: "review", description: "Review", status: "running",
  });
  const newerRoot = session("newer-root", "2026-01-02T00:00:00.000Z");

  const families = listSessionFamilies([main, child, grandchild, newerRoot]);
  assert.deepEqual(families.map((family) => family.root.id), ["main", "newer-root"]);
  assert.deepEqual(families[0].subagents.map((item) => item.id), ["child", "grandchild"]);
  assert.equal(getSessionFamily([main, child, grandchild], "grandchild")?.root.id, "main");
});

test("does not promote orphaned or cyclic subagent metadata into the main session list", () => {
  const orphan = session("orphan", "2026-01-03T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "missing", profile: "explore", description: "Explore", status: "interrupted",
  });
  const a = session("a", "2026-01-01T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "b", profile: "a", description: "A", status: "interrupted",
  });
  const b = session("b", "2026-01-02T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "a", profile: "b", description: "B", status: "interrupted",
  });

  assert.deepEqual(listSessionFamilies([orphan, a, b]), []);
  assert.equal(getSessionFamily([orphan, a, b], "orphan"), null);
});

test("groupFamiliesByDay buckets sorted families by local calendar day", () => {
  // Use local-time constructed dates so the test is timezone-independent:
  // the grouping uses local calendar days just like the relative-time UI.
  const day = (y, m, d, h = 12) => new Date(y, m, d, h, 0, 0).toISOString();
  const families = [
    { root: session("today1", day(2026, 0, 3, 10)), subagents: [], latestModified: day(2026, 0, 3, 10) },
    { root: session("today2", day(2026, 0, 3, 1)), subagents: [], latestModified: day(2026, 0, 3, 1) },
    { root: session("yesterday", day(2026, 0, 2, 22)), subagents: [], latestModified: day(2026, 0, 2, 22) },
    { root: session("older", day(2025, 11, 20, 0)), subagents: [], latestModified: day(2025, 11, 20, 0) },
  ];
  const groups = groupFamiliesByDay(families);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((group) => group.families.map((family) => family.root.id)), [
    ["today1", "today2"],
    ["yesterday"],
    ["older"],
  ]);
  // dateKey format is YYYY-MM-DD derived from the session's local date
  assert.match(groups[0].dateKey, /^\d{4}-\d{2}-\d{2}$/);
  // The first family in a group carries the latest modified time for the label
  assert.equal(groups[0].latestModified, day(2026, 0, 3, 10));
});

test("a fork is a family of its own, and its subagents fold into it, not into its origin", () => {
  const origin = session("origin", "2026-01-01T00:00:00.000Z");
  const fork = session("fork", "2026-01-01T00:00:00.000Z", { kind: "fork", originSessionId: "origin" });
  const forkAgent = session("fork-agent", "2026-01-02T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "fork", profile: "explore", description: "Explore", status: "completed",
  });

  const families = listSessionFamilies([fork, origin, forkAgent]);
  assert.deepEqual(families.map((family) => family.root.id), ["fork", "origin"]);
  assert.deepEqual(families[0].subagents.map((item) => item.id), ["fork-agent"]);
  assert.deepEqual(families[1].subagents, []);
  assert.equal(getSessionFamily([fork, origin, forkAgent], "fork-agent")?.root.id, "fork");
});

test("the Agents badge counts running subagents while any runs, else all of them", () => {
  const subagents = ["a", "b", "c"].map((id) => session(id, "2026-01-01T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "main", profile: "explore", description: id, status: "completed",
  }));

  assert.deepEqual(getAgentsBadge(subagents, new Set()), { count: 3, running: false });
  // The main session and other families' runs do not count.
  assert.deepEqual(getAgentsBadge(subagents, new Set(["main", "elsewhere"])), { count: 3, running: false });
  assert.deepEqual(getAgentsBadge(subagents, new Set(["b"])), { count: 1, running: true });
  assert.deepEqual(getAgentsBadge(subagents, new Set(["a", "c", "main"])), { count: 2, running: true });
});

test("the Agents strip shows while the main chat holds a non-root member, listing members by creation", () => {
  const main = session("main", "2026-01-01T00:00:00.000Z");
  const later = session("later", "2026-01-03T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "main", profile: "explore", description: "Later", status: "running",
  });
  const side = session("side", "2026-01-02T00:00:00.000Z", { kind: "side", parentSessionId: "main" });
  const nested = session("nested", "2026-01-04T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "later", profile: "plan", description: "Nested", status: "completed",
  });
  const sessions = [main, later, side, nested];

  // The root and sessions outside the family show no strip.
  assert.equal(getAgentStripMembers(getSessionFamily(sessions, "main"), "main"), null);
  assert.equal(getAgentStripMembers(null, "later"), null);
  assert.equal(getAgentStripMembers(getSessionFamily(sessions, "main"), "elsewhere"), null);
  assert.equal(getAgentStripMembers(getSessionFamily(sessions, "main"), null), null);

  // A subagent, a nested one or a side chat in the main chat: every member, oldest first.
  for (const id of ["later", "side", "nested"]) {
    assert.deepEqual(getAgentStripMembers(getSessionFamily(sessions, id), id)?.map((item) => item.id), ["side", "later", "nested"]);
    // The lock changes nothing there.
    assert.deepEqual(getAgentStripMembers(getSessionFamily(sessions, id), id, true)?.map((item) => item.id), ["side", "later", "nested"]);
  }
});

test("a locked Agents strip shows on the root too, once the family has a member", () => {
  const main = session("main", "2026-01-01T00:00:00.000Z");
  const child = session("child", "2026-01-02T00:00:00.000Z", {
    kind: "subagent", parentSessionId: "main", profile: "explore", description: "Child", status: "completed",
  });
  const alone = session("alone", "2026-01-03T00:00:00.000Z");
  const sessions = [main, child, alone];

  assert.deepEqual(getAgentStripMembers(getSessionFamily(sessions, "main"), "main", true)?.map((item) => item.id), ["child"]);
  // A session with no member has nothing to list, locked or not.
  assert.equal(getAgentStripMembers(getSessionFamily(sessions, "alone"), "alone", true), null);
  assert.equal(getAgentStripMembers(getSessionFamily(sessions, "main"), "elsewhere", true), null);
});
