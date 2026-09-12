import { NextResponse } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { deleteSessionsForProject } from "@/lib/project-session-delete";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const persistedSessionsPromise = listAllSessions({ force });
    // Capture before awaiting: mutations during the scan still require a later refresh.
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, runtimeSessions] = await Promise.all([
      persistedSessionsPromise,
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    const sessions = mergeSessionLists(persistedSessions, runtimeSessions);
    return jsonResponse(
      req,
      {
        sessions,
        sessionListVersion,
        runningSessionIds: getRunningRpcSessionIds(),
        completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

// DELETE /api/sessions?projectRoot=<absolute path>
// Delete every session that belongs to a project, including their on-disk
// .jsonl files. Refuses (409) while any of the project's sessions is running.
export async function DELETE(req: Request) {
  try {
    const root = new URL(req.url).searchParams.get("projectRoot")?.trim();
    if (!root) {
      return NextResponse.json({ ok: false, error: "missing-project-root" }, { status: 400 });
    }
    const result = await deleteSessionsForProject(root);
    if (result.status === "blocked-running") {
      return NextResponse.json(
        { ok: false, error: "blocked-running", runningCount: result.runningCount },
        { status: 409 },
      );
    }
    if (result.status === "not-found") {
      return NextResponse.json({ ok: false, error: "not-found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, deleted: result.deleted });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
