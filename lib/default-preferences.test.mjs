import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { isThinkingLevel, projectSettingsPath, writeProjectDefaultPreferences } = await createJiti(import.meta.url)
  .import("./default-preferences.ts");

async function withProject(run, { existing } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-default-preferences-"));
  const cwd = join(root, "cwd");
  await mkdir(cwd, { recursive: true });
  if (existing) {
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify(existing));
  }

  try {
    await run({ cwd, settingsPath: join(cwd, ".pi", "settings.json") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("writes the project default model into the project settings file", async () => {
  await withProject(async ({ cwd, settingsPath }) => {
    await writeProjectDefaultPreferences(cwd, { model: { provider: "deepseek", modelId: "deepseek-chat" } });

    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(saved.defaultProvider, "deepseek");
    assert.equal(saved.defaultModel, "deepseek-chat");
    assert.equal(saved.defaultThinkingLevel, undefined);
  });
});

test("preserves other project settings and merges the saved thinking level", async () => {
  await withProject(async ({ cwd, settingsPath }) => {
    await writeProjectDefaultPreferences(cwd, { thinkingLevel: "high" }, );

    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(saved.defaultThinkingLevel, "high");
    assert.equal(saved.packages.length, 1);
    assert.equal(saved.enabledModels, "anthropic/*");
  }, { existing: { packages: ["npm:@acme/tools"], enabledModels: "anthropic/*" } });
});

test("overwrites a previous project default without touching unrelated keys", async () => {
  await withProject(async ({ cwd, settingsPath }) => {
    await writeProjectDefaultPreferences(cwd, { model: { provider: "old", modelId: "old-model" }, thinkingLevel: "low" });
    await writeProjectDefaultPreferences(cwd, { model: { provider: "new", modelId: "new-model" } });

    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(saved.defaultProvider, "new");
    assert.equal(saved.defaultModel, "new-model");
    assert.equal(saved.defaultThinkingLevel, "low");
  });
});

test("creates the .pi directory when the project has no settings yet", async () => {
  await withProject(async ({ cwd, settingsPath }) => {
    await writeProjectDefaultPreferences(cwd, { model: { provider: "a", modelId: "b" } });

    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(saved.defaultModel, "b");
    const leftovers = (await import("node:fs/promises")).readdir(join(cwd, ".pi"));
    assert.deepEqual((await leftovers).filter((name) => name.startsWith("settings.json.tmp")), []);
  });
});

test("refuses to clobber a project settings file it cannot parse", async () => {
  await withProject(async ({ cwd, settingsPath }) => {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(settingsPath, "{ not json");

    await assert.rejects(
      writeProjectDefaultPreferences(cwd, { thinkingLevel: "high" }),
      /could not be read as a settings object/,
    );
    assert.equal(await readFile(settingsPath, "utf8"), "{ not json");
  });
});

test("refuses to clobber a project settings file that is not an object", async () => {
  await withProject(async ({ cwd, settingsPath }) => {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(settingsPath, "[1, 2]");

    await assert.rejects(writeProjectDefaultPreferences(cwd, { thinkingLevel: "high" }));
    assert.equal(await readFile(settingsPath, "utf8"), "[1, 2]");
  });
});

test("projectSettingsPath points at <cwd>/.pi/settings.json", () => {
  assert.equal(projectSettingsPath("/repo"), join("/repo", ".pi", "settings.json"));
});

test("accepts only pi thinking levels", () => {
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(isThinkingLevel(level), true);
  }
  assert.equal(isThinkingLevel("auto"), false);
  assert.equal(isThinkingLevel(undefined), false);
});
