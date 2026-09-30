import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const {
  applyFileTabMutation,
  getNextActiveFileTabId,
  openFileTab,
  saveFileViewerState,
} = await createJiti(import.meta.url).import("./file-tab-state.ts");

const tabA = {
  id: "file:/repo/a.ts",
  label: "a.ts",
  filePath: "/repo/a.ts",
  viewerRevision: 0,
  viewerState: {
    displayMode: "source",
    wrapLines: true,
    scrollTop: 240,
    scrollLeft: 16,
  },
};

const tabB = {
  id: "file:/repo/b.ts",
  label: "b.ts",
  filePath: "/repo/b.ts",
  viewerRevision: 0,
};

const openA = {
  fileName: "a.ts",
  filePath: "/repo/a.ts",
  tabId: "file:/repo/a.ts",
};

test("saving viewer state updates only the matching revision", () => {
  const tabs = [tabA, tabB];
  const nextState = { ...tabA.viewerState, scrollTop: 480 };
  const saved = saveFileViewerState(tabs, tabA.id, 0, nextState);

  assert.notStrictEqual(saved, tabs);
  assert.deepEqual(saved[0].viewerState, nextState);
  assert.strictEqual(saved[1], tabB);

  const stale = saveFileViewerState(saved, tabA.id, 9, tabA.viewerState);
  assert.strictEqual(stale, saved);
});

test("opening an existing tab normally preserves its state and revision", () => {
  const tabs = [tabA, tabB];
  assert.strictEqual(openFileTab(tabs, openA), tabs);
});

test("changing the source session remounts the viewer without losing its state", () => {
  const [next] = openFileTab([tabA], { ...openA, sourceSessionId: "session-2" });
  assert.equal(next.sourceSessionId, "session-2");
  assert.equal(next.viewerRevision, 1);
  assert.strictEqual(next.viewerState, tabA.viewerState);
});

test("opening from the same source session preserves the viewer revision", () => {
  const tab = { ...tabA, sourceSessionId: "session-1" };
  const tabs = [tab];
  assert.strictEqual(
    openFileTab(tabs, { ...openA, sourceSessionId: "session-1" }),
    tabs,
  );
});

test("changing source while forcing diff increments the revision once", () => {
  const [next] = openFileTab([tabA], {
    ...openA,
    sourceSessionId: "session-2",
    modeHint: "diff",
  });
  assert.equal(next.sourceSessionId, "session-2");
  assert.equal(next.viewerRevision, 1);
  assert.equal(next.viewerState.displayMode, "diff");
});

test("every explicit diff activation resets the mode and increments the revision", () => {
  const first = openFileTab([tabA, tabB], { ...openA, modeHint: "diff" });
  assert.equal(first[0].viewerRevision, 1);
  assert.deepEqual(first[0].viewerState, {
    displayMode: "diff",
    wrapLines: true,
    scrollTop: 0,
    scrollLeft: 0,
  });

  const returnedToSource = saveFileViewerState(first, tabA.id, 1, tabA.viewerState);
  const second = openFileTab(returnedToSource, { ...openA, modeHint: "diff" });
  assert.equal(second[0].viewerRevision, 2);
  assert.equal(second[0].viewerState.displayMode, "diff");
});

test("explicit diff activation preserves draft and base mtime while resetting scroll", () => {
  const editingTab = {
    ...tabA,
    viewerState: {
      ...tabA.viewerState,
      draft: "edited text",
      baseMtimeMs: 1234.5,
    },
  };
  const [next] = openFileTab([editingTab], { ...openA, modeHint: "diff" });

  assert.deepEqual(next.viewerState, {
    displayMode: "diff",
    wrapLines: true,
    scrollTop: 0,
    scrollLeft: 0,
    draft: "edited text",
    baseMtimeMs: 1234.5,
  });

  const [withoutDraft] = openFileTab([tabB], {
    fileName: "b.ts",
    filePath: "/repo/b.ts",
    tabId: "file:/repo/b.ts",
    modeHint: "diff",
  });
  assert.deepEqual(withoutDraft.viewerState, {
    displayMode: "diff",
    wrapLines: false,
    scrollTop: 0,
    scrollLeft: 0,
  });
  assert.equal(Object.hasOwn(withoutDraft.viewerState, "draft"), false);
  assert.equal(Object.hasOwn(withoutDraft.viewerState, "baseMtimeMs"), false);
});

test("a remounted viewer ignores the previous revision's late cleanup", () => {
  const reopened = openFileTab([tabA], { ...openA, modeHint: "diff" });
  const stale = saveFileViewerState(reopened, tabA.id, 0, tabA.viewerState);
  assert.strictEqual(stale, reopened);
  assert.equal(stale[0].viewerState.displayMode, "diff");
});


test("renaming or moving an open tab replaces its path, id, and label", () => {
  const mutation = { kind: "move", sourcePath: "/repo/a.ts", destinationPath: "/repo/src/b.ts" };
  const next = applyFileTabMutation([tabA, tabB], mutation);

  assert.deepEqual(next[0], {
    ...tabA,
    id: "file:/repo/src/b.ts",
    filePath: "/repo/src/b.ts",
    label: "b.ts",
  });
  assert.strictEqual(next[0].viewerState, tabA.viewerState);
  assert.strictEqual(next[1], tabB);
  assert.equal(getNextActiveFileTabId([tabA, tabB], tabA.id, mutation), "file:/repo/src/b.ts");
});

test("deleting the active tab selects the final surviving tab", () => {
  const mutation = { kind: "delete", sourcePath: "/repo/a.ts" };
  const next = applyFileTabMutation([tabA, tabB], mutation);

  assert.deepEqual(next, [tabB]);
  assert.equal(getNextActiveFileTabId([tabA, tabB], tabA.id, mutation), tabB.id);
});

test("renaming a directory updates every descendant tab and preserves viewer state", () => {
  const descendant = {
    ...tabA,
    id: "file:/repo/src/nested/a.ts",
    filePath: "/repo/src/nested/a.ts",
  };
  const mutation = {
    kind: "rename",
    sourcePath: "/repo/src",
    destinationPath: "/repo/lib",
  };
  const next = applyFileTabMutation([descendant, tabB], mutation);

  assert.deepEqual(next[0], {
    ...descendant,
    id: "file:/repo/lib/nested/a.ts",
    filePath: "/repo/lib/nested/a.ts",
  });
  assert.strictEqual(next[0].viewerState, descendant.viewerState);
  assert.strictEqual(next[1], tabB);
  assert.equal(
    getNextActiveFileTabId([descendant, tabB], descendant.id, mutation),
    "file:/repo/lib/nested/a.ts",
  );
});

test("moving a directory replaces only the source path prefix", () => {
  const directChild = { ...tabA, id: "file:/repo/src/a.ts", filePath: "/repo/src/a.ts" };
  const nestedChild = { ...tabB, id: "file:/repo/src/nested/b.ts", filePath: "/repo/src/nested/b.ts" };
  const similarlyNamed = { ...tabB, id: "file:/repo/src-old/b.ts", filePath: "/repo/src-old/b.ts" };
  const mutation = {
    kind: "move",
    sourcePath: "/repo/src",
    destinationPath: "/repo/packages/src",
  };
  const next = applyFileTabMutation([directChild, nestedChild, similarlyNamed], mutation);

  assert.equal(next[0].filePath, "/repo/packages/src/a.ts");
  assert.equal(next[1].filePath, "/repo/packages/src/nested/b.ts");
  assert.strictEqual(next[2], similarlyNamed);
});

test("deleting a directory closes descendant tabs and selects the final survivor", () => {
  const directChild = { ...tabA, id: "file:/repo/src/a.ts", filePath: "/repo/src/a.ts" };
  const nestedChild = { ...tabB, id: "file:/repo/src/nested/b.ts", filePath: "/repo/src/nested/b.ts" };
  const survivor = { ...tabB, id: "file:/repo/src-old/b.ts", filePath: "/repo/src-old/b.ts" };
  const mutation = { kind: "delete", sourcePath: "/repo/src" };

  assert.deepEqual(applyFileTabMutation([directChild, survivor, nestedChild], mutation), [survivor]);
  assert.equal(
    getNextActiveFileTabId([directChild, survivor, nestedChild], nestedChild.id, mutation),
    survivor.id,
  );
});

test("a delayed mutation callback reconciles the current tab snapshot", async () => {
  const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const mutationHandler = appShellSource.slice(
    appShellSource.indexOf("const handleFileMutation"),
    appShellSource.indexOf("const handleOpenLinkedFile"),
  );
  assert.match(mutationHandler, /const currentTabs = fileTabsRef\.current/);
  assert.match(mutationHandler, /activeFileTabIdRef\.current/);
  assert.match(mutationHandler, /\}, \[\]\);/);
  assert.doesNotMatch(mutationHandler, /applyFileTabMutation\(fileTabs,/);

  const mutation = { kind: "delete", sourcePath: "/repo/src" };
  const deletedTab = { ...tabA, id: "file:/repo/src/a.ts", filePath: "/repo/src/a.ts" };
  const openedMidFlight = { ...tabB, id: "file:/repo/new.ts", filePath: "/repo/new.ts" };
  let currentTabs = [deletedTab];
  let currentActiveId = deletedTab.id;
  const completeDelayedMutation = () => {
    currentActiveId = getNextActiveFileTabId(currentTabs, currentActiveId, mutation);
    currentTabs = applyFileTabMutation(currentTabs, mutation);
  };

  currentTabs = [...currentTabs, openedMidFlight];
  currentActiveId = openedMidFlight.id;
  completeDelayedMutation();

  assert.deepEqual(currentTabs, [openedMidFlight]);
  assert.equal(currentActiveId, openedMidFlight.id);
});

test("Windows-style path separator and case differences still identify the mutated tab", () => {
  const windowsTab = {
    ...tabA,
    id: "file:C:\\Repo\\src\\File.ts",
    filePath: "C:\\Repo\\src\\File.ts",
  };
  const mutation = {
    kind: "move",
    sourcePath: "c:/repo/SRC/file.ts/",
    destinationPath: "C:/Repo/destination.ts",
  };

  const [next] = applyFileTabMutation([windowsTab], mutation);
  assert.equal(next.filePath, mutation.destinationPath);
  assert.equal(getNextActiveFileTabId([windowsTab], windowsTab.id, mutation), `file:${mutation.destinationPath}`);
});

test("a mutation for another path preserves tabs and the active id", () => {
  const tabs = [tabA, tabB];
  const mutation = { kind: "delete", sourcePath: "/repo/other.ts" };

  assert.strictEqual(applyFileTabMutation(tabs, mutation), tabs);
  assert.equal(getNextActiveFileTabId(tabs, tabA.id, mutation), tabA.id);
});


test("a PDF page link remounts the viewer so the document jumps", () => {
  const [next] = openFileTab([tabA], { ...openA, page: 12 });
  assert.equal(next.page, 12);
  assert.equal(next.viewerRevision, 1);
  assert.strictEqual(next.viewerState, tabA.viewerState);
});

test("reopening the same PDF page keeps the viewer mounted", () => {
  const tabs = [{ ...tabA, page: 12 }];
  assert.strictEqual(openFileTab(tabs, { ...openA, page: 12 }), tabs);
});

test("opening another page of the same PDF increments the revision", () => {
  const [next] = openFileTab([{ ...tabA, page: 12 }], { ...openA, page: 13 });
  assert.equal(next.page, 13);
  assert.equal(next.viewerRevision, 1);
});

test("opening a PDF without a page fragment clears a previous jump", () => {
  const [next] = openFileTab([{ ...tabA, page: 12 }], openA);
  assert.equal(next.page, undefined);
  assert.equal(next.viewerRevision, 1);
});
