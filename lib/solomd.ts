/** Result of asking the server to open `path` in the local SoloMD app. */
export interface OpenInSoloMDResult {
  ok: boolean;
  error?: string;
}

/**
 * Ask the Pi Web server to open `path` with the machine-local SoloMD app
 * (macOS `open -a SoloMD`). Only meaningful for Markdown files; the server
 * enforces that. Never throws — callers surface `error` themselves.
 */
export async function openInSoloMD(path: string): Promise<OpenInSoloMDResult> {
  try {
    const response = await fetch("/api/solomd/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (response.ok) return { ok: true };
    const data = await response.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: data.error ?? `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Whether the SoloMD open button should be shown for this entry. Any
 * existing file qualifies (code, images, .drawio, .excalidraw, …);
 * directories never do.
 */
export function canOpenInSoloMD(name: string, isDirectory: boolean): boolean {
  return !isDirectory;
}