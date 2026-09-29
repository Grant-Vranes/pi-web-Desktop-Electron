/**
 * Desktop shell bridge — single adapter over the two supported shells
 * (Electron: window.piDesktop via preload.cjs; Tauri: window.__TAURI__ via
 * withGlobalTauri) and the plain browser fallback.
 *
 * The frontend never references window.piDesktop / window.__TAURI__ directly;
 * it goes through these helpers so both shells keep working during the
 * migration window.
 */

export type DesktopShell = "electron" | "tauri" | "browser";

export interface DesktopTerminalResult {
  ok: boolean;
  error?: string;
}

interface PiDesktopLike {
  openTerminal?: (payload: { cwd: string; branch?: string | null }) => Promise<DesktopTerminalResult>;
  getPathForFile?: (file: File) => string;
}

interface TauriGlobal {
  core?: {
    invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
}

/** Detect the active desktop shell (SSR-safe). */
export function detectDesktopShell(): DesktopShell {
  if (typeof window === "undefined") return "browser";
  if (window.piDesktop) return "electron";
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (tauri?.core?.invoke) return "tauri";
  return "browser";
}

function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> | null {
  if (typeof window === "undefined") return null;
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri?.core?.invoke) return null;
  return tauri.core.invoke(cmd, args) as Promise<T>;
}

/**
 * Open a native terminal window at cwd (checking out branch when given).
 * Prefers the shell-native path — the desktop main process runs in the full
 * graphical session, so terminal emulators launched there actually appear
 * (the embedded Next.js server's process context often cannot open windows
 * on Wayland GNOME). Falls back to the HTTP API for browser access.
 */
export async function openDesktopTerminal(payload: {
  cwd: string;
  branch?: string | null;
}): Promise<DesktopTerminalResult> {
  const desktop = typeof window !== "undefined" ? (window as unknown as { piDesktop?: PiDesktopLike }).piDesktop : undefined;
  if (desktop?.openTerminal) {
    return desktop.openTerminal(payload);
  }
  if (detectDesktopShell() === "tauri") {
    const result = await tauriInvoke<{ ok: boolean; error?: string }>("open_terminal", {
      cwd: payload.cwd,
      branch: payload.branch ?? null,
    });
    if (result) return result;
  }
  const response = await fetch("/api/terminal/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.ok) return { ok: true };
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: data.error ?? `HTTP ${response.status}` };
}

/**
 * Native delete-confirmation dialog. Returns true when the user confirmed.
 * Electron resolves this inside the session-row context menu handler in
 * preload.cjs; Tauri invokes the Rust dialog command directly.
 */
export async function confirmDeleteSession(name?: string, id?: string): Promise<boolean> {
  if (detectDesktopShell() === "tauri") {
    const confirmed = await tauriInvoke<boolean>("confirm_delete_session", { name: name ?? null, id: id ?? null });
    return confirmed === true;
  }
  // Electron / browser: native confirm via the shell is handled elsewhere;
  // fall back to window.confirm for browser parity.
  return window.confirm(name ? `删除会话“${name}”？删除后无法恢复。` : "删除该会话？删除后无法恢复。");
}

/**
 * Tauri bootstrap: install the session-row context-menu listener that
 * Electron provides via preload.cjs (SESSION_ROW_CONTEXT_MENU_EVENT). Called
 * once on client mount; a no-op outside the Tauri shell.
 */
export function installTauriSessionRowContextMenu(): void {
  if (typeof window === "undefined" || detectDesktopShell() !== "tauri") return;
  const w = window as unknown as {
    __piTauriMenuInstalled?: boolean;
  };
  if (w.__piTauriMenuInstalled) return;
  w.__piTauriMenuInstalled = true;

  window.addEventListener(
    "pi-web:session-row-contextmenu",
    (event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      if (!detail || typeof detail.refresh !== "function") return;

      event.preventDefault();

      void (async () => {
        const invoke = tauriInvoke<string | null>("session_row_context_menu", {
          id: detail.id,
          path: detail.path,
          cwd: detail.cwd,
          name: detail.name ?? null,
        });
        if (!invoke) return;
        const action = await invoke;
        if (action !== "delete") return;

        const confirmed = await confirmDeleteSession(detail.name, detail.id);
        if (!confirmed) return;

        const response = await fetch(`/api/sessions/${encodeURIComponent(detail.id)}`, {
          method: "DELETE",
        });
        if (response.ok) {
          detail.refresh();
          return;
        }
        const body = await response.text().catch(() => "");
        const message = body ? `删除失败：${response.status} ${body}` : `删除失败：HTTP ${response.status}`;
        window.alert(message);
      })();
    },
    true,
  );
}
