import { stat } from "fs/promises";
import { resolve } from "path";
import { createAgentSessionServices, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  isThinkingLevel,
  projectSettingsPath,
  writeProjectDefaultPreferences,
  type DefaultPreferencesEdit,
} from "@/lib/default-preferences";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { resolveVisibleModels } from "@/lib/model-scope";
import { withDeferredProviderModels } from "@/lib/deferred-provider-models";
import { invalidateModelsCache } from "@/lib/models-cache";
import { projectTrustReloadOptions } from "@/lib/project-trust";

export const dynamic = "force-dynamic";

interface DefaultPreferencesRequest {
  cwd?: unknown;
  provider?: unknown;
  modelId?: unknown;
  thinkingLevel?: unknown;
}

function parseEdit(body: DefaultPreferencesRequest): DefaultPreferencesEdit | null {
  const edit: DefaultPreferencesEdit = {};
  if (body.provider !== undefined || body.modelId !== undefined) {
    if (typeof body.provider !== "string" || !body.provider) return null;
    if (typeof body.modelId !== "string" || !body.modelId) return null;
    edit.model = { provider: body.provider, modelId: body.modelId };
  }
  if (body.thinkingLevel !== undefined) {
    if (!isThinkingLevel(body.thinkingLevel)) return null;
    edit.thinkingLevel = body.thinkingLevel;
  }
  return edit.model || edit.thinkingLevel ? edit : null;
}

/**
 * Save the model and/or reasoning level new sessions in this project start
 * with. Per-project on purpose: the star writes `<cwd>/.pi/settings.json`,
 * which pi merges over the global default, so each project keeps its own
 * choice and other projects are untouched.
 *
 * The cwd decides which project settings file is written and which models
 * are in scope, so it goes through the same allow-list as `/api/models`.
 */
export async function PUT(req: Request) {
  let body: DefaultPreferencesRequest;
  try {
    body = await req.json() as DefaultPreferencesRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const edit = parseEdit(body);
  if (!edit) {
    return Response.json({ error: "Expected provider and modelId, or a valid thinkingLevel" }, { status: 400 });
  }

  const cwd = resolve(typeof body.cwd === "string" && body.cwd ? body.cwd : process.cwd());
  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!cwdStat.isDirectory()) {
    return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    const agentDir = getAgentDir();
    const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
    });
    const { settingsManager } = services;

    // An untrusted project's settings are ignored on load, so a default
    // written there would silently never apply.
    if (!settingsManager.isProjectTrusted()) {
      return Response.json({
        error: `Project ${projectSettingsPath(cwd)} requires trust; trust this project before saving a default model for it.`,
        reason: "project-untrusted",
      }, { status: 403 });
    }

    if (edit.model) {
      // Only a model the selector can offer is a default that actually takes
      // effect: startup falls back to the first scoped model otherwise.
      const scope = await resolveVisibleModels(withDeferredProviderModels(services.modelRuntime), settingsManager.getEnabledModels());
      const { provider, modelId } = edit.model;
      if (!scope.visible.some((model) => model.provider === provider && model.id === modelId)) {
        return Response.json({ error: `Model not available: ${provider}/${modelId}` }, { status: 404 });
      }
    }

    await writeProjectDefaultPreferences(cwd, edit);
    invalidateModelsCache();
    return Response.json({
      ok: true,
      ...(edit.model ? { defaultModel: edit.model } : {}),
      ...(edit.thinkingLevel ? { defaultThinkingLevel: edit.thinkingLevel } : {}),
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
