/** Result of asking the server to open `path` in the local HorseMD app. */
export interface OpenInHorseMDResult {
  ok: boolean;
  error?: string;
}

/**
 * Ask the Pi Web server to open `path` with the machine-local HorseMD app
 * (macOS `open -a HorseMD`). Only meaningful for Markdown files; the server
 * enforces that. Never throws — callers surface `error` themselves.
 */
export async function openInHorseMD(path: string): Promise<OpenInHorseMDResult> {
  try {
    const response = await fetch("/api/horsemd/open", {
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
 * Whether the HorseMD open button should be shown for this entry. Any
 * existing file qualifies (code, images, .drawio, .excalidraw, …);
 * directories never do.
 */
export function canOpenInHorseMD(name: string, isDirectory: boolean): boolean {
  return !isDirectory;
}
