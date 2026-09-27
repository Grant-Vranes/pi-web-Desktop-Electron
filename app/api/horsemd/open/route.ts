import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { existsSync, statSync } from "fs";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
} from "@/lib/file-access";
import { toNativePath } from "@/lib/paths";
import { isApiRequestAllowed } from "@/lib/request-security";


interface SpawnResult {
  ok: boolean;
  error?: string;
}

/**
 * Spawn a detached process that opens `nativePath` in the machine-local
 * HorseMD app via macOS `open -a HorseMD`. A successful spawn with no early
 * error is the best we can verify — the app window itself is async.
 */
function openInHorseMDApp(nativePath: string): Promise<SpawnResult> {
  return new Promise((resolve) => {
    try {
      const child = spawn("open", ["-a", "HorseMD", nativePath], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", (err) => {
        resolve({ ok: false, error: err.message });
      });
      // Detach so HorseMD outlives the server process; unref so the server
      // can exit without waiting on it.
      child.unref();
      // `open -a` reports "unable to find application" asynchronously on
      // stderr but still exits 0; wait briefly for an early spawn error.
      setTimeout(() => resolve({ ok: true }), 250);
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// POST /api/horsemd/open  body: { path }  →  { ok }
//
// Opens an existing file in the local HorseMD app (any file type: code,
// images, .drawio, .excalidraw, …). The path must be an existing file and
// pass the allowed-roots gate (lexical check before any filesystem access,
// then a realpath check).
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => null) as { path?: string } | null;
    const targetPath = body?.path;
    if (!targetPath || typeof targetPath !== "string") {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }
    // Lexical allowed-roots check BEFORE any filesystem access, so the
    // 400 "Path does not exist" answer cannot be used to probe which paths
    // exist outside the boundary.
    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(targetPath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    if (!existsSync(targetPath)) {
      return NextResponse.json({ error: `Path does not exist: ${targetPath}` }, { status: 400 });
    }
    // Realpath-aware containment: reject symlink escapes. Runs after the
    // existence check because realpath requires an existing path.
    if (!isExistingFilePathAllowed(targetPath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let isDirectory: boolean;
    try {
      isDirectory = statSync(targetPath).isDirectory();
    } catch {
      return NextResponse.json({ error: `Path does not exist: ${targetPath}` }, { status: 400 });
    }
    if (isDirectory) {
      return NextResponse.json({ error: "Only files can be opened in HorseMD" }, { status: 400 });
    }

    if (process.platform !== "darwin") {
      return NextResponse.json({ error: "HorseMD open is only supported on macOS" }, { status: 501 });
    }

    const result = await openInHorseMDApp(toNativePath(targetPath));
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "Failed to open HorseMD" }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
