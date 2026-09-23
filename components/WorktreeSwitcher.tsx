"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { WorktreeState } from "@/lib/worktree-types";
import { displayCwd } from "@/lib/cwd-display";
import { useI18n } from "@/hooks/useI18n";

const DROPDOWN_ANIMATION_MS = 140;

function AnimatedDropdown({ open, children, style }: { open: boolean; children: React.ReactNode; style: CSSProperties }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    let frame: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (open) {
      setMounted(true);
      setVisible(false);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      timeout = setTimeout(() => setMounted(false), DROPDOWN_ANIMATION_MS);
    }

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (timeout) clearTimeout(timeout);
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      style={{
        ...style,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0) scale(1)" : "translateY(-8px) scale(0.96)",
        transformOrigin: "top center",
        transition: `opacity ${DROPDOWN_ANIMATION_MS}ms ease, transform ${DROPDOWN_ANIMATION_MS}ms ease`,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}

function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...style }}>
      {text}
    </span>
  );
}

interface Props {
  worktreeState: WorktreeState;
  /** Canonical path of the currently active checkout (server-resolved). */
  currentWorktreePath: string | null;
  homeDir?: string;
  /**
   * Called after the user picks a worktree, creates one, or removes one.
   * The parent should update its selected cwd / refresh the worktree list.
   */
  onWorktreeChange?: (nextCwd: string, opts?: { created?: boolean; removed?: boolean }) => void;
  /** Compact trigger for embedding in a tight toolbar (e.g. the chat input bar). */
  compact?: boolean;
  /** Optional extra className/style for the root wrapper. */
  style?: CSSProperties;
}

export function WorktreeSwitcher({ worktreeState, currentWorktreePath, homeDir, onWorktreeChange, compact, style }: Props) {
  const { t } = useI18n();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  // Reset transient UI state whenever the dropdown closes.
  useEffect(() => {
    if (dropdownOpen) return;
    setNewOpen(false);
    setNewBranch("");
    setError(null);
    setConfirmRemove(null);
    setFilter("");
  }, [dropdownOpen]);

  // Close on outside click.
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  const currentWorktree = worktreeState.worktrees.find((w) => w.path === currentWorktreePath)
    ?? worktreeState.worktrees.find((w) => w.isMain)
    ?? null;

  const handleCreate = useCallback(async () => {
    const branch = newBranch.trim();
    if (!branch || busy || !worktreeState) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, branch }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string };
      if (!res.ok || data.error || !data.path) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setNewOpen(false);
      setNewBranch("");
      setDropdownOpen(false);
      onWorktreeChange?.(data.path, { created: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [newBranch, busy, worktreeState, onWorktreeChange]);

  const handleRemove = useCallback(async (path: string, force: boolean) => {
    if (!worktreeState || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, path, force }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!res.ok) {
        if (data.dirty && !force) {
          setConfirmRemove(path);
          return;
        }
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setConfirmRemove(null);
      // If we removed the active checkout, fall back to the main repo root.
      const fallback = currentWorktreePath === path ? worktreeState.projectRoot : currentWorktreePath ?? worktreeState.projectRoot;
      onWorktreeChange?.(fallback, { removed: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [worktreeState, busy, currentWorktreePath, onWorktreeChange]);

  const showFilter = worktreeState.worktrees.length >= 8;
  const visibleWorktrees = showFilter && filter.trim()
    ? worktreeState.worktrees.filter((w) =>
        (w.branch ?? displayCwd(w.path, homeDir)).toLowerCase().includes(filter.trim().toLowerCase()))
    : worktreeState.worktrees;

  const triggerLabel = currentWorktree
    ? (currentWorktree.branch ?? displayCwd(currentWorktree.path, homeDir))
    : "…";

  const triggerTitle = currentWorktree
    ? t("sidebar.switchWorktreeTitle", { path: currentWorktree.path })
    : t("sidebar.switchWorktree");

  const branchIcon = (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: currentWorktree && !currentWorktree.isMain ? "var(--accent)" : "var(--text-dim)" }}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );

  const chevron = (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: dropdownOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
      <polyline points="2 3.5 5 6.5 8 3.5" />
    </svg>
  );

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        // In the sidebar this is a full row. Make that explicit rather than
        // relying on the block-flex shrink-to-fit behavior of the button.
        width: compact ? undefined : "100%",
        minWidth: 0,
        ...style,
      }}
    >
      <button
        onClick={() => setDropdownOpen((v) => !v)}
        title={triggerTitle}
        aria-label={t("sidebar.switchWorktree")}
        aria-expanded={dropdownOpen}
        onMouseEnter={(e) => {
          if (compact) e.currentTarget.style.background = "var(--bg-hover)";
          else e.currentTarget.style.borderColor = "var(--text-dim)";
        }}
        onMouseLeave={(e) => {
          if (compact) e.currentTarget.style.background = dropdownOpen ? "var(--bg-selected)" : "none";
          else e.currentTarget.style.borderColor = "var(--border)";
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: compact ? 4 : 6,
          height: compact ? 32 : 29,
          padding: compact ? "0 10px" : "0 10px",
          // Compact mode is a ghost trigger that matches the chat-bar model
          // selector: no bordered box, just a subtle hover/open background.
          // Sidebar mode matches the project (CWD) picker above it: a bordered
          // box with a subtle background so it reads as a switcher button.
          background: compact ? (dropdownOpen ? "var(--bg-selected)" : "none") : "var(--bg-hover)",
          border: compact ? "none" : "1px solid var(--border)",
          borderRadius: compact ? 9 : 7,
          cursor: "pointer",
          fontSize: 12,
          lineHeight: 1.35,
          color: "var(--text-muted)",
          textAlign: "left",
          whiteSpace: "nowrap",
          minWidth: 0,
          width: compact ? undefined : "100%",
          maxWidth: compact ? undefined : "100%",
          boxSizing: "border-box",
          transition: compact ? undefined : "border-color 0.15s, background 0.15s",
        }}
      >
        {branchIcon}
        <PathLabel
          text={triggerLabel}
          style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", color: "var(--text)" }}
        />
        {currentWorktree?.isMain && !compact && (
          <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sidebar.main")}</span>
        )}
        {!compact && worktreeState.worktrees.length > 1 && (
          <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>
            {worktreeState.worktrees.length}
          </span>
        )}
        {chevron}
      </button>

      <AnimatedDropdown
        open={dropdownOpen}
        style={{
          position: "absolute",
          bottom: compact ? "calc(100% + 4px)" : undefined,
          top: compact ? undefined : "calc(100% + 4px)",
          left: 0,
          right: compact ? undefined : 0,
          minWidth: compact ? 240 : undefined,
          maxWidth: compact ? "min(80vw, 360px)" : undefined,
          zIndex: 600,
          background: "var(--bg-panel)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          boxShadow: "0 6px 20px rgba(0,0,0,0.12)",
          overflow: "hidden",
        }}
      >
        {showFilter && (
          <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setFilter("");
                  setDropdownOpen(false);
                }
              }}
              placeholder={t("sidebar.filterWorktrees")}
              autoFocus
              style={{
                width: "100%",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                padding: "5px 8px",
                border: "1px solid var(--border)",
                borderRadius: 5,
                outline: "none",
                background: "var(--bg)",
                color: "var(--text)",
                boxSizing: "border-box",
              }}
            />
          </div>
        )}
        <div style={{ maxHeight: "min(40vh, 300px)", overflowY: "auto" }}>
          {visibleWorktrees.map((wt) => {
            const isCurrent = wt.path === currentWorktreePath;
            if (confirmRemove === wt.path) {
              return (
                <div key={wt.path} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderBottom: "1px solid var(--border)", background: "rgba(239,68,68,0.06)" }}>
                  <span style={{ flex: 1, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t("sidebar.forceRemoveCheckout")}
                  </span>
                  <button
                    onClick={() => void handleRemove(wt.path, true)}
                    disabled={busy}
                    style={{ padding: "3px 9px", background: "#ef4444", border: "none", borderRadius: 5, color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
                  >
                    {t("sidebar.force")}
                  </button>
                  <button
                    onClick={() => setConfirmRemove(null)}
                    style={{ padding: "3px 9px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer", flexShrink: 0 }}
                  >
                    {t("sidebar.cancel")}
                  </button>
                </div>
              );
            }
            return (
              <div
                key={wt.path}
                style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}
              >
                <button
                  onClick={() => {
                    onWorktreeChange?.(wt.path);
                    setDropdownOpen(false);
                  }}
                  title={wt.path}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "8px 10px",
                    background: "var(--bg)",
                    border: "none",
                    color: isCurrent ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {isCurrent ? (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <polyline points="1.5 5 4 7.5 8.5 2.5" />
                    </svg>
                  ) : (
                    <span style={{ width: 10, flexShrink: 0 }} />
                  )}
                  <PathLabel text={wt.branch ?? displayCwd(wt.path, homeDir)} style={{ flex: 1 }} />
                  {wt.isMain && <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sidebar.main")}</span>}
                </button>
                {!wt.isMain && (
                  <button
                    onClick={() => void handleRemove(wt.path, false)}
                    disabled={busy}
                    title={t("sidebar.removeWorktreeTitle", { path: wt.path })}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "center",
                      width: 34, height: 28, padding: 0, marginRight: 4,
                      background: "none", border: "none",
                      color: "var(--text-dim)", cursor: "pointer",
                      borderRadius: 5, flexShrink: 0,
                      transition: "color 0.12s, background 0.12s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6M14 11v6" />
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
          {showFilter && visibleWorktrees.length === 0 && filter.trim() && (
            <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noMatchingWorktrees")}</div>
          )}
        </div>

        {!newOpen ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setNewOpen(true);
              setError(null);
              setTimeout(() => newInputRef.current?.focus(), 0);
            }}
            title={t("sidebar.createWorktreeTitle")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              width: "100%",
              padding: "8px 10px",
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              textAlign: "left",
              fontSize: 11,
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
              <line x1="5" y1="1" x2="5" y2="9" />
              <line x1="1" y1="5" x2="9" y2="5" />
            </svg>
            <span>{t("sidebar.newWorktree")}</span>
          </button>
        ) : (
          <div style={{ padding: "6px 8px" }}>
            <input
              ref={newInputRef}
              value={newBranch}
              onChange={(e) => {
                setNewBranch(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleCreate();
                }
                if (e.key === "Escape") {
                  setNewOpen(false);
                  setNewBranch("");
                  setError(null);
                }
              }}
              placeholder={t("sidebar.branchName")}
              style={{
                width: "100%",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                padding: "5px 8px",
                border: "1px solid var(--accent)",
                borderRadius: 5,
                outline: "none",
                background: "var(--bg)",
                color: "var(--text)",
                boxSizing: "border-box",
              }}
            />
            <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
              <button
                onClick={() => void handleCreate()}
                disabled={busy || !newBranch.trim()}
                style={{
                  flex: 1,
                  padding: "4px 0",
                  background: "var(--accent)",
                  border: "none",
                  borderRadius: 5,
                  color: "#fff",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: busy || !newBranch.trim() ? "not-allowed" : "pointer",
                  opacity: busy || !newBranch.trim() ? 0.65 : 1,
                }}
              >
                {busy ? t("sidebar.creating") : t("sidebar.create")}
              </button>
              <button
                onClick={() => { setNewOpen(false); setNewBranch(""); setError(null); }}
                style={{
                  flex: 1,
                  padding: "4px 0",
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                  borderRadius: 5,
                  color: "var(--text-muted)",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {t("sidebar.cancel")}
              </button>
            </div>
          </div>
        )}
        {error && (
          <div style={{
            padding: "5px 10px 8px",
            color: "#dc2626",
            fontSize: 11,
            lineHeight: 1.35,
            overflowWrap: "anywhere",
          }}>
            {error}
          </div>
        )}
      </AnimatedDropdown>
    </div>
  );
}
