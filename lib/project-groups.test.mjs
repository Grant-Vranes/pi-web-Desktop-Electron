import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { projectIdentityKey } = await jiti.import("./project-identity.ts");
const {
  getProjectActivity,
  getRecentProjects,
  mergeProjectLists,
  sessionsForProject,
} = await jiti.import("./project-groups.ts");

function session(id, projectRoot, modified) {
  return {
    id,
    path: `${id}.jsonl`,
    cwd: projectRoot,
    projectRoot,
    projectKey: projectIdentityKey(projectRoot, "win32"),
    created: modified,
    modified,
    messageCount: 1,
    firstMessage: id,
  };
}

test("Windows path variants form one recent project using the newest display path", () => {
  const older = session("older", "C:\\Users\\Alex\\Project\\Study\\ELM", "2026-08-12T00:00:00.000Z");
  const newer = session("newer", "c:/users/ALEX/project/study/elm", "2026-08-13T00:00:00.000Z");

  assert.deepEqual(getRecentProjects([older, newer]), [{
    key: older.projectKey,
    root: newer.projectRoot,
  }]);
});

test("running and unread counts aggregate under the stable project identity", () => {
  const first = session("first", "C:\\Users\\Alex\\Project", "2026-08-12T00:00:00.000Z");
  const second = session("second", "c:/users/alex/project/", "2026-08-13T00:00:00.000Z");

  const activity = getProjectActivity(
    [first, second],
    new Set(["first", "second"]),
    new Set(["second"]),
  );

  assert.deepEqual(activity.get(first.projectKey), { running: 2, unread: 1 });
  assert.equal(activity.size, 1);
});

test("rail and dropdown share one merged list: fresh browser renders the server list verbatim", () => {
  const server = [
    { root: "/w/alpha", key: "k-alpha" },
    { root: "/w/beta", key: "k-beta" },
  ];

  assert.deepEqual(mergeProjectLists([], server, null), server);
});

test("remembered empty directory stays listed so both UIs keep showing it", () => {
  const remembered = { root: "/w/empty", key: "/w/empty" };

  assert.deepEqual(mergeProjectLists([remembered], [], null), [remembered]);
});

test("a remembered slot upgrades in place to server identity once sessions exist", () => {
  const remembered = { root: "C:\\Users\\Alex\\Proj", key: "C:\\Users\\Alex\\Proj" };
  const server = { root: "c:/users/alex/proj", key: projectIdentityKey("c:/users/alex/proj", "win32") };

  assert.deepEqual(mergeProjectLists([remembered], [server], null), [server]);
});

test("same key with a moved root shows the server-reported root", () => {
  const remembered = { root: "/old/path", key: "k-shared" };
  const server = { root: "/new/path", key: "k-shared" };

  assert.deepEqual(mergeProjectLists([remembered], [server], null), [server]);
});

test("history order leads and unknown server projects append in recency order", () => {
  const a = { root: "/w/a", key: "k-a" };
  const b = { root: "/w/b", key: "k-b" };
  const c = { root: "/w/c", key: "k-c" };

  assert.deepEqual(
    mergeProjectLists([b, a], [c, a, b], null).map((project) => project.key),
    ["k-b", "k-a", "k-c"],
  );
});

test("selected project refreshes its key's root and appends when unknown", () => {
  const a = { root: "/w/a", key: "k-a" };
  const selected = { root: "/w/selected", key: "k-a" };

  assert.deepEqual(mergeProjectLists([], [a], selected), [selected]);

  const fresh = { root: "/w/fresh", key: "k-fresh" };
  assert.deepEqual(
    mergeProjectLists([], [a], fresh),
    [a, fresh],
  );
});

test("one directory never yields two entries even under two server keys", () => {
  const first = { root: "C:\\W\\Proj", key: "k-old" };
  const second = { root: "c:/w/proj/", key: projectIdentityKey("c:/w/proj/", "win32") };

  const merged = mergeProjectLists([], [first, second], null);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].key, "k-old");
});
