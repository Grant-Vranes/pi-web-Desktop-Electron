import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { displaySettingsPath } from "./enabled-models-runtime";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel);
}

/** What the model and reasoning selectors' "save as default" action writes. */
export interface DefaultPreferencesEdit {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
}

export function projectSettingsPath(cwd: string): string {
  return displaySettingsPath(join(cwd, ".pi", "settings.json"));
}

/**
 * Persist the project-scoped defaults new sessions in this project start
 * with, so each project can keep its own model and reasoning level.
 *
 * `SettingsManager` has no public project-scope setter for these fields (it
 * only ever writes the global file), so the project settings file is edited
 * directly. The merge still goes through pi: a project `.pi/settings.json`
 * value wins over the global default, and a fresh session's
 * `SettingsManager` picks the project value up on load.
 *
 * The write is atomic and refuses to clobber a file it cannot parse: a
 * default that would silently drop the project's other settings must not
 * report success.
 */
export async function writeProjectDefaultPreferences(
  cwd: string,
  edit: DefaultPreferencesEdit,
): Promise<void> {
  const settingsPath = join(cwd, ".pi", "settings.json");
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("settings must be a JSON object");
    }
    current = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `${displaySettingsPath(settingsPath)} could not be read as a settings object (${error instanceof Error ? error.message : String(error)}); fix or remove it before saving a project default.`,
      );
    }
  }

  const next = { ...current };
  if (edit.model) {
    next.defaultProvider = edit.model.provider;
    next.defaultModel = edit.model.modelId;
  }
  if (edit.thinkingLevel) next.defaultThinkingLevel = edit.thinkingLevel;

  await mkdir(dirname(settingsPath), { recursive: true });
  const tmpPath = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tmpPath, settingsPath);
}
