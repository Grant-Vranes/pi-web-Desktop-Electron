"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { type SessionInfo } from "@/lib/types";
import { listSessionFamilies, groupFamiliesByDay, type SessionDayGroup } from "@/lib/session-family";
import { loadExplorerOpen, saveExplorerOpen } from "@/lib/file-explorer-state";
import { loadCollapsedDayGroups, saveCollapsedDayGroups, hasCollapseBeenSeeded, markCollapseSeeded } from "@/lib/session-day-collapse";
import { dispatchSessionRowContextMenu } from "@/lib/session-row-context-menu";
import { skillExpansionToCommand } from "@/lib/slash-display";
import { getProjectActivity, getRecentProjects, mergeProjectLists, sessionsForProject, type ProjectSelection } from "@/lib/project-groups";
import { loadProjectAliases, projectDisplayName, projectFolderName, setProjectAlias, type ProjectAliasMap } from "@/lib/project-alias";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import { collectDroppedFolders, isFileDrag, type DroppedFolderPaths } from "@/lib/dropped-folders";
import { displayCwd } from "@/lib/cwd-display";
import { openInFileBrowser } from "@/lib/file-browser";
import type { WorktreeEntry, WorktreeState } from "@/lib/worktree-types";
import type { RunningRpcSessionDetail } from "@/lib/rpc-manager";
import { calendarDaysAgo, formatSessionTimestamp, formatDayLabel } from "@/lib/i18n/format";
import { useI18n } from "@/hooks/useI18n";
import { DirectoryPicker } from "./DirectoryPicker";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import type { FileTabMutation } from "./file-tab-state";
import { WorktreeSwitcher } from "./WorktreeSwitcher";
import { SessionSearch } from "./SessionSearch";

// Fixed row height for the session list. SessionItem renders at exactly this
// height, so the list can be windowed (only the visible slice is mounted).
const SESSION_LIST_ITEM_HEIGHT = 54;

export function getSessionListIndices(count: number, scrollTop: number, viewportHeight: number, focusedIndex = -1): number[] {
  const overscan = 8;
  const visibleCount = Math.ceil((viewportHeight || 600) / SESSION_LIST_ITEM_HEIGHT) + overscan * 2;
  const start = Math.max(0, Math.min(Math.floor(scrollTop / SESSION_LIST_ITEM_HEIGHT) - overscan, count - visibleCount));
  const end = Math.min(count, start + visibleCount);
  const indices = Array.from({ length: end - start }, (_, offset) => start + offset);
  // Keep a focused row mounted so scrolling cannot discard an inline rename.
  if (focusedIndex >= 0 && focusedIndex < start) indices.unshift(focusedIndex);
  if (focusedIndex >= end && focusedIndex < count) indices.push(focusedIndex);
  return indices;
}

/** Shared display title for a session: stored name, else the first message
 *  (SDK-expanded skill blocks collapsed back to /skill commands), else a
 *  short id fallback. Used by the session row and the project-rail tooltip
 *  so both surfaces label a session the same way. */
function sessionDisplayName(session: SessionInfo): string {
  const displayFirstMessage = skillExpansionToCommand(session.firstMessage) ?? session.firstMessage;
  return session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12);
}

function ToolbarIconButton({
  onClick,
  title,
  disabled,
  skipHover,
  color,
  background = "none",
  marginRight,
  ariaPressed,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  skipHover?: boolean;
  color: string;
  background?: string;
  marginRight?: number;
  ariaPressed?: boolean;
  children: ReactNode;
}) {
  const enter = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = "var(--text-muted)";
    e.currentTarget.style.background = "var(--bg-hover)";
  };
  const leave = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = color;
    e.currentTarget.style.background = background;
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={ariaPressed}
      style={{
        position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, padding: 0, marginRight,
        background,
        border: "none",
        color,
        cursor: disabled ? "default" : "pointer",
        borderRadius: 5,
        flexShrink: 0,
        opacity: disabled ? 0.6 : 1,
        transition: "color 0.3s, background 0.3s",
      }}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      {children}
    </button>
  );
}

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean, entryId?: string, blockIndex?: number) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  /** After a project's sessions are deleted when that project is the active
   *  one, relocate the open composer to the given next project root (null to
   *  start empty). Lets the shell remount so the deleted rail tile disappears. */
  onProjectDeleted?: (nextRoot: string | null) => void;
  selectedCwd?: string | null;
  onCwdChange?: (
    cwd: string | null,
    projectRoot?: string | null,
    projectKey?: string | null,
  ) => void;
  onOpenFile?: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff" }) => void;
  onFileMutation?: (mutation: FileTabMutation) => void;
  onOpenTerminal?: (cwd: string) => void;
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  /** Fired when a session that is not currently selected finishes running.
   *  Lets the app play a cross-workspace completion tone. */
  onBackgroundTaskDone?: () => void;
  onRunningSessionIdsChange?: (ids: Set<string>) => void;
  onSessionsChange?: (sessions: SessionInfo[]) => void;
}


interface ValidatedProject {
  cwd: string;
  root: string;
  key: string;
}

const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
const PROJECT_RAIL_STORAGE_KEY = "pi-web:project-rail-history";
/** How long the browser-cannot-resolve-paths notice stays after a folder drop. */
const FOLDER_DROP_NOTICE_MS = 8000;
const LAST_CUSTOM_CWD_STORAGE_KEY = "pi-web:last-custom-cwd";
const RUNNING_SESSIONS_POLL_MS = 2500;
// Grace period before the rail tooltip closes after the pointer leaves the
// tile/card, so crossing the gap between them never blinks the card.
const PROJECT_RAIL_TOOLTIP_HIDE_DELAY_MS = 160;

function loadLastCustomCwd(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(LAST_CUSTOM_CWD_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastCustomCwd(cwd: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_CUSTOM_CWD_STORAGE_KEY, cwd);
  } catch {
    // Persistence is best-effort.
  }
}

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

/** Unlike session-backed projects, an opened empty directory has no JSONL file
 * to rediscover on the next selection. Keep a small local history so it stays
 * a first-class project in the rail. */
function loadProjectRailHistory(): ProjectSelection[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PROJECT_RAIL_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is ProjectSelection => (
        typeof item === "object" && item !== null
        && typeof (item as ProjectSelection).root === "string"
        && typeof (item as ProjectSelection).key === "string"
      ))
      .slice(0, 30);
  } catch {
    return [];
  }
}


/**
 * Path label that ellipsizes on the LEFT, keeping the (most relevant) trailing
 * segments visible: "…orkspace/pi-web". Shows as much of the path as fits
 * instead of a fixed number of segments. The rtl container moves the ellipsis
 * to the left edge; the inner plaintext bidi isolation keeps the path itself
 * rendered strictly left-to-right (no punctuation reordering).
 */
function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

const DROPDOWN_ANIMATION_MS = 140;

function AnimatedDropdown({ open, children, style }: { open: boolean; children: ReactNode; style: CSSProperties }) {
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

/**
 * Hover tooltip for a session row that shows the full (untruncated) title.
 * Unlike the native `title` attribute, this supports wrapping and a vertical
 * scrollbar when the title is very long, so the user can read the whole
 * thing. Anchored above the row (or below if there isn't room), clamped to
 * the viewport, and shown after a short hover delay so quick mouse passes
 * don't flicker it on.
 */
const SESSION_TITLE_TOOLTIP_DELAY_MS = 450;
const SESSION_TITLE_TOOLTIP_MAX_WIDTH = 360;
const SESSION_TITLE_TOOLTIP_MAX_HEIGHT = 220;

function SessionTitleTooltip({
  anchorEl,
  open,
  title,
  messageCount,
  timestamp,
  t,
}: {
  anchorEl: HTMLElement | null;
  open: boolean;
  title: string;
  messageCount: number;
  timestamp: string;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  // `open` is true while the row is hovered; we add a short delay before the
  // card actually appears so a quick mouse pass doesn't flicker it on, and
  // hide immediately on leave.
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setVisible(false);
      return;
    }
    const showTimer = setTimeout(() => setVisible(true), SESSION_TITLE_TOOLTIP_DELAY_MS);
    return () => { if (showTimer) clearTimeout(showTimer); };
  }, [open]);

  // Measure + position the card. Runs whenever it becomes visible, when the
  // anchor changes, when the title changes (height can change), and on scroll/
  // resize so the card stays pinned to the row while the user reads it.
  const measure = useCallback(() => {
    if (!anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const card = cardRef.current;
    const cardW = card?.offsetWidth ?? SESSION_TITLE_TOOLTIP_MAX_WIDTH;
    const cardH = card?.offsetHeight ?? 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Center horizontally on the row, clamped to the viewport.
    let left = rect.left + rect.width / 2 - cardW / 2;
    left = Math.max(8, Math.min(left, vw - cardW - 8));
    // Prefer above the row; fall back to below when there isn't room.
    const gap = 8;
    let top: number;
    if (rect.top - gap - cardH >= 8) {
      top = rect.top - gap - cardH;
    } else {
      top = rect.bottom + gap;
      if (top + cardH > vh - 8) top = Math.max(8, vh - cardH - 8);
    }
    setPos({ left, top });
  }, [anchorEl]);

  useLayoutEffect(() => {
    if (!visible) return;
    measure();
  }, [visible, measure, title]);

  useEffect(() => {
    if (!visible) return;
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [visible, measure]);

  if (!visible) return null;

  return createPortal(
    <div
      ref={cardRef}
      role="tooltip"
      className="session-title-tooltip"
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        zIndex: 9999,
        maxWidth: SESSION_TITLE_TOOLTIP_MAX_WIDTH,
        maxHeight: SESSION_TITLE_TOOLTIP_MAX_HEIGHT,
      }}
    >
      <div className="session-title-tooltip-body">{title}</div>
      <div className="session-title-tooltip-meta">
        <span>{timestamp}</span>
        <span aria-hidden="true">·</span>
        <span>{t("sidebar.messagesCount", { count: messageCount })}</span>
      </div>
    </div>,
    document.body,
  );
}


const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

function useScramble(target: string, running: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  useEffect(() => {
    if (!running) {
      setDisplay(target);
      return;
    }
    iterRef.current = 0;
    const totalFrames = target.length * 4;

    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);

      setDisplay(
        target
          .split("")
          .map((char, i) => {
            if (char === " ") return " ";
            if (i < resolved) return char;
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join("")
      );

      if (iterRef.current < totalFrames) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [target, running]);

  return display;
}

function PiWebTitle({ projectName }: { projectName: string | null }) {
  const [showVersion, setShowVersion] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const brandName = projectName ?? "Pi Web";
  const target = showVersion ? `${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}p${process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}` : brandName;
  const display = useScramble(target, scrambling);

  const triggerScramble = useCallback((toVersion: boolean) => {
    setShowVersion(toVersion);
    setScrambling(true);
    setTimeout(() => setScrambling(false), (toVersion ? 6 : 8) * 4 * (1000 / 60) + 100);
  }, []);

  const handleClick = useCallback(() => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);

    const next = !showVersion;
    triggerScramble(next);

    if (next) {
      revertTimerRef.current = setTimeout(() => triggerScramble(false), 3000);
    }
  }, [showVersion, triggerScramble]);

  useEffect(() => () => { if (revertTimerRef.current) clearTimeout(revertTimerRef.current); }, []);

  return (
    <button
      onClick={handleClick}
      style={{
        background: "none", border: "none", padding: 0, cursor: "default",
        fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em",
        color: showVersion ? "var(--accent)" : "var(--text)",
        fontFamily: "var(--font-mono)",
        minWidth: "6ch",
        maxWidth: "100%",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {display}
    </button>
  );
}

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, onProjectDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, onOpenTerminal, onFileMutation, explorerRefreshKey, onExplorerRefresh, onAtMention, onAtMentions, onBackgroundTaskDone, onRunningSessionIdsChange, onSessionsChange }: Props) {
  const { t, locale } = useI18n();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [sessionListVersion, setSessionListVersion] = useState<number | null>(null);
  const sessionListVersionRef = useRef<number | null>(null);
  const sessionLoadIdRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState(loadLastCustomCwd);
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  // Shown after a folder drop the browser recognizes but cannot resolve to an
  // absolute path (a browser security rule — only the desktop shell maps File
  // objects to real paths). Explains the limitation instead of surprising the
  // user with the picker dialog.
  const [folderDropNotice, setFolderDropNotice] = useState(false);
  const folderDropNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [validatedProject, setValidatedProject] = useState<ValidatedProject | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Worktree switcher state
  const [worktreeState, setWorktreeState] = useState<WorktreeState | null>(null);
  const [worktreeLoadingCwd, setWorktreeLoadingCwd] = useState<string | null>(null);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerKey, setExplorerKey] = useState(0);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [fileBrowserOpening, setFileBrowserOpening] = useState(false);
  const [changesCount, setChangesCount] = useState(0);
  const [changesCollapsed, setChangesCollapsed] = useState(true);
  const [collapsedDayGroups, setCollapsedDayGroups] = useState<Set<string>>(() => loadCollapsedDayGroups());
  const [conversationsTab, setConversationsTab] = useState<"active" | "archived">("active");
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  // Per-running-session model/cwd/state snapshot, refreshed by the running
  // poller. Feeds the project-rail indicator tooltip without per-session
  // get_state round trips.
  const [runningSessionDetails, setRunningSessionDetails] = useState<RunningRpcSessionDetail[]>([]);
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const [projectRailHistory, setProjectRailHistory] = useState<ProjectSelection[]>(() => loadProjectRailHistory());
  // Per-project display names ("rename project") from the rail tooltip.
  // Read once on mount; updates go straight to localStorage (best-effort).
  const [projectAliases, setProjectAliases] = useState<ProjectAliasMap>(() => loadProjectAliases());
  const handleRenameProject = useCallback((project: ProjectSelection, name: string) => {
    setProjectAlias(project.key, name);
    setProjectAliases((previous) => {
      const trimmed = name.trim();
      if (trimmed && previous[project.key] === trimmed) return previous;
      const next = { ...previous };
      if (trimmed) next[project.key] = trimmed;
      else delete next[project.key];
      return next;
    });
  }, []);
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  const currentSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  const previousSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  // Once polling has delivered a snapshot it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const runningPollAuthoritativeRef = useRef(false);
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);

  // NOTE: upstream's virtualized session-list window (listScrollRef,
  // listViewportH/listScrollTop, focusedSessionId, handleListScroll and
  // virtualIndices) was dropped in favor of HEAD's day-group rendering.
  // getSessionListIndices stays exported for its unit tests.

  const loadSessions = useCallback(async (showLoading = false, force = false) => {
    const loadId = ++sessionLoadIdRef.current;
    try {
      if (showLoading) setLoading(true);
      const res = await fetch(force ? "/api/sessions?force=1" : "/api/sessions", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as {
        sessions: SessionInfo[];
        sessionListVersion: number;
        runningSessionIds?: string[];
        completionNotificationSuppressedSessionIds?: string[];
      };
      if (loadId !== sessionLoadIdRef.current) return;
      sessionListVersionRef.current = data.sessionListVersion;
      setSessionListVersion(data.sessionListVersion);
      setAllSessions(data.sessions);
      // Treat the fetched running set as an initial fallback only. Once the
      // lightweight poll is live, a slow session-list fetch cannot overwrite it.
      if (!runningPollAuthoritativeRef.current) {
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      }
      // Drop markers for deleted sessions and for subagents, whose completion
      // is intentionally silent even if an older client marked them unread.
      const unreadEligibleIds = new Set(
        data.sessions
          .filter((session) => session.relation?.kind !== "subagent")
          .map((session) => session.id),
      );
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => unreadEligibleIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setError(null);
      if (!showLoading) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
    } catch (e) {
      if (loadId === sessionLoadIdRef.current) setError(String(e));
    } finally {
      if (loadId === sessionLoadIdRef.current) setLoading(false);
    }
  }, []);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst, !isFirst);
  }, [loadSessions, refreshKey]);

  // Browser storage is unavailable during server rendering. Restore the panel
  // preference after hydration so a collapsed explorer stays collapsed on reload.
  useEffect(() => {
    setExplorerOpen(loadExplorerOpen());
  }, []);

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  useEffect(() => {
    saveCollapsedDayGroups(collapsedDayGroups);
  }, [collapsedDayGroups]);

  useEffect(() => {
    try {
      if (projectRailHistory.length === 0) window.localStorage.removeItem(PROJECT_RAIL_STORAGE_KEY);
      else window.localStorage.setItem(PROJECT_RAIL_STORAGE_KEY, JSON.stringify(projectRailHistory));
    } catch {
      // ignore storage quota / privacy-mode errors
    }
  }, [projectRailHistory]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS);
    };

    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const current = new AbortController();
      controller?.abort();
      controller = current;
      try {
        const res = await fetch("/api/agent/running", {
          cache: "no-store",
          signal: current.signal,
        });
        if (!res.ok) return;
        const data = await res.json() as {
          sessionListVersion: number;
          runningSessionIds?: string[];
          runningSessionDetails?: RunningRpcSessionDetail[];
          completionNotificationSuppressedSessionIds?: string[];
        };
        if (stopped || controller !== current) return;
        runningPollAuthoritativeRef.current = true;
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
        setRunningSessionDetails(data.runningSessionDetails ?? []);
        if (data.sessionListVersion !== sessionListVersionRef.current) {
          // Reuse the invalidated cache; forcing a scan would change the version again.
          await loadSessions();
        }
      } catch {
        // Keep the last known state; the next visible-tab poll retries.
      } finally {
        if (controller === current) controller = null;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
        return;
      }
      clearTimer();
      controller?.abort();
      controller = null;
    };

    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadSessions]);

  useEffect(() => {
    onRunningSessionIdsChange?.(runningSessionIds);
  }, [onRunningSessionIdsChange, runningSessionIds]);

  useEffect(() => {
    onSessionsChange?.(allSessions);
  }, [allSessions, onSessionsChange]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const knownSubagentIds = new Set(
      allSessions
        .filter((session) => session.relation?.kind === "subagent")
        .map((session) => session.id),
    );
    const completedWithNotifications = completedInBackground.filter(
      (id) => !previousSuppressedCompletionSessionIdsRef.current.has(id) && !knownSubagentIds.has(id),
    );
    const newlyRunning = [...runningSessionIds].filter((id) => !previous.has(id));

    if (completedWithNotifications.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        runningSessionIds.forEach((id) => next.delete(id));
        completedWithNotifications.forEach((id) => next.add(id));
        return next;
      });
    }
    const hasUnlistedRunningSession = newlyRunning.some(
      (id) => !allSessions.some((session) => session.id === id),
    );
    if (completedInBackground.length > 0 || hasUnlistedRunningSession) {
      loadSessions(false, true);
    }
    if (completedWithNotifications.length > 0) {
      onBackgroundTaskDone?.();
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
    previousSuppressedCompletionSessionIdsRef.current = new Set(
      [...runningSessionIds].filter(
        (id) => currentSuppressedCompletionSessionIdsRef.current.has(id) || knownSubagentIds.has(id),
      ),
    );
  }, [runningSessionIds, selectedSessionId, allSessions, loadSessions, onBackgroundTaskDone]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((k) => k + 1);
  }, [explorerRefreshKey]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  const restoredRef = useRef(false);

  const projectSelection = useCallback((root: string, key: string): ProjectSelection => ({
    root,
    key,
  }), []);

  /** Resolve both display root and stable identity from server-provided data. */
  const projectFor = useCallback((cwd: string | null): ProjectSelection | null => {
    if (!cwd) return null;
    // /api/cwd/validate resolves identity before a custom path becomes active,
    // preventing one render with a raw path key from looking like a switch.
    if (validatedProject?.cwd === cwd) {
      return projectSelection(validatedProject.root, validatedProject.key);
    }
    if (worktreeState && worktreeState.forCwd === cwd) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    // Any path in the loaded worktree list belongs to that project — covers
    // worktrees without sessions, so switching to them keeps the row mounted.
    if (worktreeState?.worktrees.some((w) => w.path === cwd)) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    const match = allSessions.find((session) => (
      session.cwd === cwd || (session.projectRoot ?? session.cwd) === cwd
    ));
    return match
      ? projectSelection(match.projectRoot ?? match.cwd, workspaceKeyOf(match))
      : projectSelection(cwd, cwd);
  }, [validatedProject, worktreeState, allSessions, projectSelection]);

  // A worktree/session refresh can hydrate the stable key without changing
  // cwd, so notify when either changes. The parent treats same-cwd key changes
  // as identity hydration rather than a workspace switch.
  const lastNotifiedProjectRef = useRef<{ cwd: string | null; key: string | null } | null>(null);
  useEffect(() => {
    const project = projectFor(selectedCwd);
    const previous = lastNotifiedProjectRef.current;
    if (previous?.cwd === selectedCwd && previous.key === (project?.key ?? null)) return;
    lastNotifiedProjectRef.current = { cwd: selectedCwd, key: project?.key ?? null };
    onCwdChange?.(
      selectedCwd,
      project?.root ?? null,
      project?.key ?? null,
    );
  }, [selectedCwd, onCwdChange, projectFor]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
    }
  }, [selectedCwdProp]);

  // Load worktrees for the current effective cwd
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  useLayoutEffect(() => {
    if (!selectedCwd) {
      setWorktreeState(null);
      setWorktreeLoadingCwd(null);
      return;
    }
    let cancelled = false;
    setWorktreeLoadingCwd(selectedCwd);
    fetch(`/api/worktrees?cwd=${encodeURIComponent(selectedCwd)}`)
      .then((r) => r.json())
      .then((d: { projectRoot?: string; projectKey?: string; isGit?: boolean; isTopLevel?: boolean; currentWorktreePath?: string | null; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (cancelled) return;
        setWorktreeLoadingCwd(null);
        if (d.error || !d.projectRoot) {
          setWorktreeState(null);
          return;
        }
        setWorktreeState({
          forCwd: selectedCwd,
          projectRoot: d.projectRoot,
          projectKey: d.projectKey ?? d.projectRoot,
          isGit: d.isGit ?? false,
          isTopLevel: d.isTopLevel ?? false,
          currentWorktreePath: d.currentWorktreePath ?? null,
          worktrees: d.worktrees ?? [],
        });
      })
      .catch(() => {
        if (!cancelled) {
          setWorktreeLoadingCwd(null);
          setWorktreeState(null);
        }
      });
    return () => { cancelled = true; };
  }, [selectedCwd, wtRefreshKey, refreshKey]);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (allSessions.length === 0 || skipInitialProjectSelection) return;

    if (selectedCwd === null) {
      // If restoring a session, set cwd to match that session
      if (initialSessionId && !restoredRef.current) {
        restoredRef.current = true;
        const target = allSessions.find((s) => s.id === initialSessionId);
        if (target) {
          setSelectedCwd(target.cwd);
          onSelectSession(target, true);
          return;
        }
        // Session not found — notify parent so it can show the placeholder
        onInitialRestoreDone?.();
      }
      const projects = getRecentProjects(allSessions);
      if (projects.length > 0) setSelectedCwd(projects[0].root);
    }
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone]);

  // Prefer an exact UI selection while a refetch is in flight. Once the
  // response catches up, the server-resolved path handles Windows case and
  // separator differences without teaching the browser OS path semantics.
  const currentWorktree = worktreeState
    ? worktreeState.worktrees.find((worktree) => worktree.path === selectedCwd)
      ?? (worktreeState.forCwd === selectedCwd && worktreeState.currentWorktreePath
        ? worktreeState.worktrees.find((worktree) => worktree.path === worktreeState.currentWorktreePath)
        : undefined)
      ?? worktreeState.worktrees.find((worktree) => worktree.isMain)
    : undefined;
  const currentWorktreePath = currentWorktree?.path ?? null;

  const commitCustomPath = useCallback(async (candidate?: string) => {
    const path = (candidate ?? customPathValue).trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json().catch(() => ({})) as {
        cwd?: string;
        projectRoot?: string;
        projectKey?: string;
        error?: string;
      };
      if (!res.ok || data.error || !data.cwd || !data.projectRoot || !data.projectKey) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setValidatedProject({
        cwd: data.cwd,
        root: data.projectRoot,
        key: data.projectKey,
      });
      // An explicitly re-added directory may have been deleted earlier in this
      // session; clear the deletion guard so it re-enters the persisted rail
      // history instead of vanishing again on the next project switch.
      deletedProjectKeysRef.current.delete(data.projectKey);
      deletedProjectKeysRef.current.delete(data.projectRoot);
      deletedProjectKeysRef.current.delete(data.cwd);
      saveLastCustomCwd(data.cwd);
      setCustomPathValue(data.cwd);
      setSelectedCwd(data.cwd);
      setCustomPathOpen(false);
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating]);

  const handleCustomPathClick = useCallback(() => {
    setFolderDropNotice(false);
    setCustomPathOpen(true);
    setCustomPathError(null);
    setDropdownOpen(false);
  }, []);

  const showFolderDropNotice = useCallback(() => {
    setFolderDropNotice(true);
    if (folderDropNoticeTimer.current !== null) clearTimeout(folderDropNoticeTimer.current);
    folderDropNoticeTimer.current = setTimeout(() => {
      folderDropNoticeTimer.current = null;
      setFolderDropNotice(false);
    }, FOLDER_DROP_NOTICE_MS);
  }, []);
  useEffect(() => () => {
    if (folderDropNoticeTimer.current !== null) clearTimeout(folderDropNoticeTimer.current);
  }, []);

  // Dropping folders from the OS onto the project rail adds them to the
  // workspace. Resolved paths (desktop runtime) go through the same
  // /api/cwd/validate flow as a manual selection, so identity, allow-roots
  // registration, and deletion guards behave identically. A plain browser
  // cannot read absolute paths from an OS drag, so a drop it recognizes as
  // directories shows an inline notice with a manual-pick shortcut instead
  // of being ignored or popping a dialog on its own.
  const handleDroppedProjectFolders = useCallback(async (dropped: DroppedFolderPaths) => {
    if (dropped.paths.length > 0) {
      for (const path of dropped.paths) {
        await commitCustomPath(path);
      }
      return;
    }
    if (dropped.hasDirectories) showFolderDropNotice();
  }, [commitCustomPath, showFolderDropNotice]);

  // Shared by the rail tiles and the workspace dropdown so both entrances
  // behave identically. Explicit re-selection clears the deletion guard so a
  // directory the user deliberately deleted and re-added can re-enter the
  // persisted rail history instead of vanishing on the next project switch.
  const selectProject = useCallback((project: ProjectSelection) => {
    deletedProjectKeysRef.current.delete(project.key);
    deletedProjectKeysRef.current.delete(project.root);
    setSelectedCwd(project.root);
    setProjectFilter("");
    setCustomPathOpen(false);
    setCustomPathValue("");
    setCustomPathError(null);
    setDropdownOpen(false);
  }, []);
  const handleDefaultCwd = useCallback(async () => {
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json() as { cwd?: string; error?: string };
      if (data.cwd) {
        // Explicit selection clears any deletion guard for this directory so
        // it can re-enter the persisted rail history.
        deletedProjectKeysRef.current.delete(data.cwd);
        setSelectedCwd(data.cwd);
        setCustomPathOpen(false);
        setCustomPathError(null);
        setDropdownOpen(false);
      }
    } catch {
      // ignore
    }
  }, []);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setProjectFilter("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Shared callback for the worktree switcher (sidebar + chat input):
  // move the effective cwd to the chosen/created checkout and refresh the
  // worktree list. Removing the active checkout falls back to the main root.
  const handleWorktreeSwitch = useCallback((nextCwd: string) => {
    setSelectedCwd(nextCwd);
    setWtRefreshKey((k) => k + 1);
  }, []);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees.
  const handleSelectSessionFromList = useCallback((s: SessionInfo, entryId?: string, blockIndex?: number) => {
    setAllSessions((current) => current.some((session) => session.id === s.id) ? current : [s, ...current]);
    if (s.cwd) setSelectedCwd(s.cwd);
    onSelectSession(s, false, entryId, blockIndex);
  }, [onSelectSession]);

  const handleSelectSessionFromRail = useCallback((s: SessionInfo) => {
    setScrollTargetSessionId(s.id);
    handleSelectSessionFromList(s);
  }, [handleSelectSessionFromList]);

  const handleNewSession = useCallback(() => {
    if (!selectedCwd) return;
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    onNewSession?.(tempId, selectedCwd);
  }, [selectedCwd, onNewSession]);

  // Open the OS native file browser at the explorer's current root. Disabled
  // briefly while a request is in flight so the button never looks dead
  // (same pattern as terminalOpening).
  const handleOpenInFileBrowser = useCallback(async () => {
    const targetCwd = selectedCwd ?? selectedCwdProp;
    if (!targetCwd || fileBrowserOpening) return;
    setFileBrowserOpening(true);
    const result = await openInFileBrowser(targetCwd);
    if (!result.ok) {
      window.alert(`${t("files.openInFileBrowserFailed")}: ${result.error ?? ""}`);
    }
    setTimeout(() => setFileBrowserOpening(false), 600);
  }, [selectedCwd, selectedCwdProp, fileBrowserOpening, t]);

  const recentProjects = useMemo(() => getRecentProjects(allSessions), [allSessions]);

  // Sessions of every worktree in the selected project are shown together
  const selectedProject = projectFor(selectedCwd);

  // Per-project activity counts (running / unread) for the workspace selector.
  // Uses the same stable server key as the project list and filtering.
  const projectActivity = useMemo(
    () => getProjectActivity(allSessions, runningSessionIds, unreadSessionIds),
    [allSessions, runningSessionIds, unreadSessionIds],
  );

  // Any activity in a project other than the one currently selected — shown as
  // a dot on the (collapsed) selector button so it is visible without opening
  // the dropdown.
  const hasOtherWorkspaceActivity = useMemo(
    () => [...projectActivity.entries()].some(
      ([key, { running, unread }]) => key !== selectedProject?.key && (running > 0 || unread > 0),
    ),
    [projectActivity, selectedProject],
  );

  const filteredSessions = selectedProject
    ? sessionsForProject(allSessions, selectedProject.key)
    : allSessions;

  // Split by archive flag so each sidebar tab renders its own day groups.
  const activeSessions = conversationsTab === "active"
    ? filteredSessions.filter((session) => !session.archived)
    : [];
  const archivedSessions = conversationsTab === "archived"
    ? filteredSessions.filter((session) => session.archived)
    : [];
  const tabSessions = conversationsTab === "active" ? activeSessions : archivedSessions;

  // Remember every project that has been selected, including directories with
  // no session file yet. Without this, an empty project disappears as soon as
  // the user clicks elsewhere because getRecentProjects() is session-backed.
  // Deliberately append rather than promote: selecting a rail item must never
  // make the project icons reshuffle underneath the pointer.
  //
  // Projects deleted via the rail are excluded (deletedProjectKeysRef):
  // between the DELETE succeeding and the refreshed session list landing,
  // projectFor(selectedCwd) can still resolve to the deleted project from a
  // stale snapshot, and appending it here would re-persist a tile the user
  // just removed — the delete would look like a no-op. Clicking the tile
  // again clears the guard, so re-adding a directory still works.
  const deletedProjectKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!selectedProject) return;
    if (deletedProjectKeysRef.current.has(selectedProject.key) || deletedProjectKeysRef.current.has(selectedProject.root)) return;
    setProjectRailHistory((previous) => {
      const index = previous.findIndex((project) => project.key === selectedProject.key);
      if (index === -1) return [...previous, selectedProject].slice(-30);
      if (previous[index].root === selectedProject.root) return previous;
      const next = [...previous];
      next[index] = selectedProject;
      return next;
    });
  }, [selectedProject]);

  // One shared list for the rail tiles and the workspace dropdown so the two
  // always render the same projects in the same order. Server-derived
  // projects own identity; the persisted rail history contributes ordering
  // and keeps remembered session-less directories visible.
  const railProjects = useMemo(
    () => mergeProjectLists(projectRailHistory, recentProjects, selectedProject),
    [projectRailHistory, recentProjects, selectedProject],
  );
  // The dropdown renders the same shared list as the rail, with an optional
  // text filter on the displayed root.
  const showProjectFilter = railProjects.length > 8;
  // Filter matches the display alias too, so a renamed project stays findable
  // by its new name (the root path still matches as before).
  const projectFilterText = projectFilter.trim().toLowerCase();
  const visibleProjects = projectFilterText
    ? railProjects.filter((project) => (
        project.root.toLowerCase().includes(projectFilterText)
        || (projectAliases[project.key] ?? "").toLowerCase().includes(projectFilterText)
      ))
    : railProjects;
  const handleDeleteProject = useCallback(async (project: ProjectSelection): Promise<ProjectDeleteOutcome> => {
    let res: Response;
    try {
      res = await fetch(`/api/sessions?projectRoot=${encodeURIComponent(project.root)}`, { method: "DELETE" });
    } catch {
      return { ok: false, reason: "failed" };
    }
    let payload: { ok?: boolean } | undefined;
    try {
      payload = (await res.json().catch(() => undefined)) as { ok?: boolean } | undefined;
    } catch {
      /* ignore */
    }
    if (!res.ok && res.status !== 404) {
      if (res.status === 409) return { ok: false, reason: "blocked-running" };
      // A payload with blocked-running should already be handled above; any
      // other non-2xx is a hard failure.
      if (payload?.ok) return { ok: true };
      return { ok: false, reason: "failed" };
    }

    // Determine whether the folder under the open tab/composer is the one being
    // deleted so we can relocate instead of leaving its icon as the selection.
    const active = selectedSessionId
      ? allSessions.find((session) => session.id === selectedSessionId)
      : undefined;
    const currentProjectKey = active
      ? workspaceKeyOf(active)
      : selectedProject?.key ?? null;

    // Not currently inside the deleted project: removing it from the persisted
    // rail history is enough — refresh and the tile disappears.
    if (currentProjectKey !== project.key) {
      setProjectRailHistory((previous) =>
        previous.filter((entry) => entry.key !== project.key && entry.root !== project.root),
      );
      await loadSessions(false, true);
      return { ok: true };
    }

    // The deleted project was the active one. Block the history-append effect
    // for this identity (key, displayed root, and the exact cwd under the open
    // composer — for worktree sessions that cwd differs from the project root)
    // before any state can change, so no stale render between now and the
    // refreshed session list can re-append the deleted tile.
    deletedProjectKeysRef.current.add(project.key);
    deletedProjectKeysRef.current.add(project.root);
    if (selectedCwd) deletedProjectKeysRef.current.add(selectedCwd);

    // Refresh first, then drop the rail-history entry and relocate in one
    // batch: once allSessions no longer lists the deleted project, the
    // selectedProject effect, rail merge, and (when nothing remains) the
    // auto-select effect all read post-deletion data and cannot resurrect it.
    await loadSessions(false, true);
    setProjectRailHistory((previous) =>
      previous.filter((entry) => entry.key !== project.key && entry.root !== project.root),
    );

    // Auto-jump to the first remaining project in rail order — the topmost
    // tile the user actually sees — falling back to session recency when the
    // rail has nothing else (or only the deleted entry) to offer.
    const nextRoot = railProjects.find(
      (candidate) => candidate.key !== project.key && candidate.root !== project.root,
    )?.root
      ?? getRecentProjects(
        allSessions.filter((session) => workspaceKeyOf(session) !== project.key),
      )[0]?.root
      ?? null;
    setSelectedCwd(nextRoot);
    onProjectDeleted?.(nextRoot);
    return { ok: true };
  }, [allSessions, selectedCwd, selectedSessionId, selectedProject, railProjects, onProjectDeleted, setProjectRailHistory, loadSessions]);

  const canCreateSession = Boolean(selectedCwd);
  const newSessionDisabled = !selectedCwd;
  const showWorktreeSwitcher = Boolean(
    worktreeState?.isGit
    && worktreeState.isTopLevel
    && selectedCwd
    && selectedProject?.key === worktreeState.projectKey
  );
  const worktreeGuide = selectedCwd
    && worktreeState
    && selectedProject?.key === worktreeState.projectKey
    && !showWorktreeSwitcher
    ? (worktreeState.isGit
        ? {
             label: t("sidebar.openRepoRoot"),
             title: t("sidebar.openRepoRootTitle"),
          }
        : {
             label: t("sidebar.gitRepoRootOnly"),
             title: t("sidebar.gitRepoRootOnlyTitle"),
          })
    : null;
  const worktreeLoading = Boolean(selectedCwd && worktreeLoadingCwd === selectedCwd);
  const inactiveWorktreeSelector = worktreeGuide
    ?? (worktreeLoading && !showWorktreeSwitcher
      ? {
           label: t("sidebar.worktrees"),
           title: t("sidebar.checkingWorktrees"),
        }
      : null);

  const sessionFamilies = listSessionFamilies(tabSessions);
  const sessionDayGroups = useMemo<SessionDayGroup[]>(
    () => groupFamiliesByDay(sessionFamilies),
    [sessionFamilies],
  );

  // Bulk expand/collapse for every day group of the current tab. Mirrors the
  // per-group toggle: while any group is collapsed the button offers
  // "expand all"; once everything is expanded it offers "collapse all".
  const anyDayGroupCollapsed = sessionDayGroups.some((group) => collapsedDayGroups.has(group.dateKey));
  const toggleAllDayGroups = useCallback(() => {
    setCollapsedDayGroups((prev) => {
      const next = new Set(prev);
      for (const group of sessionDayGroups) {
        if (anyDayGroupCollapsed) next.delete(group.dateKey);
        else next.add(group.dateKey);
      }
      return next;
    });
  }, [sessionDayGroups, anyDayGroupCollapsed]);

  // 首次使用（或清空存储后）默认折叠除“今天”以外的所有分组；
  // 一旦应用过一次就标记为已初始化，后续以用户显式选择为准，避免重新加载时覆盖。
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    if (hasCollapseBeenSeeded()) {
      seededRef.current = true;
      return;
    }
    if (sessionDayGroups.length === 0) return;
    const toCollapse = new Set<string>();
    for (const group of sessionDayGroups) {
      if (calendarDaysAgo(group.latestModified) !== 0) toCollapse.add(group.dateKey);
    }
    if (toCollapse.size === 0) {
      markCollapseSeeded();
      seededRef.current = true;
      return;
    }
    setCollapsedDayGroups(toCollapse);
    markCollapseSeeded();
    seededRef.current = true;
  }, [sessionDayGroups]);

  const [scrollTargetSessionId, setScrollTargetSessionId] = useState<string | null>(null);
  const conversationsListRef = useRef<HTMLDivElement>(null);
  // Jumping to a session from the project-rail tooltip: expand the day group
  // holding it (if collapsed), then scroll its row to the top of the visible
  // list so the selected record is always in view.
  useEffect(() => {
    if (!scrollTargetSessionId) return;
    const group = sessionDayGroups.find((g) =>
      g.families.some((f) => [f.root.id, ...f.subagents.map((s) => s.id)].includes(scrollTargetSessionId)),
    );
    if (group && collapsedDayGroups.has(group.dateKey)) {
      setCollapsedDayGroups((prev) => {
        const next = new Set(prev);
        next.delete(group.dateKey);
        return next;
      });
      return; // re-run after the group renders expanded
    }
    const raf = requestAnimationFrame(() => {
      const row = conversationsListRef.current?.querySelector(`[data-session-id="${scrollTargetSessionId}"]`);
      row?.scrollIntoView({ block: "start" });
      setScrollTargetSessionId(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [scrollTargetSessionId, sessionDayGroups, collapsedDayGroups]);

  return (
    <div className="project-sidebar-shell" style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      {customPathOpen && (
        <DirectoryPicker
          initialPath={customPathValue}
          busy={customPathValidating}
          error={customPathError}
          onCancel={() => {
            setCustomPathOpen(false);
            setCustomPathError(null);
          }}
          onSelect={(path) => void commitCustomPath(path)}
        />
      )}
      <ProjectRail
        projects={railProjects}
        selectedProjectKey={selectedProject?.key ?? null}
        selectedSessionId={selectedSessionId}
        activity={projectActivity}
        allSessions={allSessions}
        runningSessionIds={runningSessionIds}
        runningSessionDetails={runningSessionDetails}
        unreadSessionIds={unreadSessionIds}
        onSelect={selectProject}
        onSelectSession={handleSelectSessionFromRail}
        onAddProject={handleCustomPathClick}
        onAddDroppedFolders={handleDroppedProjectFolders}
        folderDropNotice={folderDropNotice}
        onDismissFolderDropNotice={() => setFolderDropNotice(false)}
        onReorder={(keys) => {
          const byKey = new Map(railProjects.map((project) => [project.key, project]));
          setProjectRailHistory(keys.flatMap((key) => {
            const project = byKey.get(key);
            return project ? [project] : [];
          }));
        }}
        onDeleteProject={handleDeleteProject}
        projectAliases={projectAliases}
        onRenameProject={handleRenameProject}
      />
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, overflow: "hidden" }}>
      {/* Workspace module */}
      <div className="sidebar-workspace-section">
        <div className="sidebar-brand-row">
          <PiWebTitle projectName={selectedProject ? projectDisplayName(selectedProject.root, projectAliases[selectedProject.key]) : null} />
          <span className="sidebar-module-kicker">{t("sidebar.workspace")}</span>
        </div>

        {/* CWD picker */}
        <div ref={dropdownRef} style={{ position: "relative" }}>
          <button
            onClick={() => setDropdownOpen((v) => !v)}
            title={selectedProject?.root ?? selectedCwd ?? ""}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              padding: "6px 10px",
              background: selectedCwd ? "var(--bg-hover)" : "rgba(37,99,235,0.06)",
              border: selectedCwd ? "1px solid var(--border)" : "1px solid rgba(37,99,235,0.4)",
              borderRadius: 7,
              cursor: "pointer",
              fontSize: 12,
              color: "var(--text)",
              textAlign: "left",
              transition: "border-color 0.15s, background 0.15s",
            }}
          >
            {selectedCwd ? (
              <PathLabel
                text={displayCwd(selectedProject?.root ?? selectedCwd, homeDir)}
                style={{
                  flex: 1,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text)",
                }}
              />
            ) : (
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text-dim)",
                }}
              >
                 {initialSessionId && !restoredRef.current ? "" : t("sidebar.selectProject")}
              </span>
            )}
            {hasOtherWorkspaceActivity && (
              <span
                title={t("sidebar.newActivity")}
                aria-label={t("sidebar.newActivity")}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  flexShrink: 0,
                  marginLeft: 6,
                  background: "var(--accent)",
                }}
              />
            )}
          </button>

          <AnimatedDropdown
            open={dropdownOpen}
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              right: 0,
              zIndex: 100,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
              overflow: "hidden",
            }}
          >
              {showProjectFilter && (
                <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                  <input
                    value={projectFilter}
                    onChange={(e) => setProjectFilter(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setProjectFilter("");
                        setDropdownOpen(false);
                      }
                    }}
                     placeholder={t("sidebar.filterProjects")}
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
              <div style={{ maxHeight: "min(50vh, 380px)", overflowY: "auto" }}>
                {visibleProjects.map((project) => (
                  <button
                    key={project.key}
                    onClick={() => {
                      selectProject(project);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      width: "100%",
                      padding: "8px 10px",
                      background: "var(--bg)",
                      border: "none",
                      borderBottom: "1px solid var(--border)",
                      color: project.key === selectedProject?.key ? "var(--text)" : "var(--text-muted)",
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={project.root}
                  >
                    {project.key === selectedProject?.key && (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <polyline points="1.5 5 4 7.5 8.5 2.5" />
                      </svg>
                    )}
                    {project.key !== selectedProject?.key && <span style={{ width: 10, flexShrink: 0 }} />}
                    {/* Renamed projects show their alias in place of the path;
                    unchanged projects keep the full display path. */}
                    <PathLabel
                      text={projectAliases[project.key]?.trim() || displayCwd(project.root, homeDir)}
                      style={{ flex: 1, fontWeight: projectAliases[project.key]?.trim() ? 600 : undefined }}
                    />
                    {showProjectActivity(projectActivity.get(project.key), t)}
                  </button>
                ))}
                {visibleProjects.length === 0 && projectFilter.trim() && (
                   <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noMatchingProjects")}</div>
                )}
              </div>

              {/* Default cwd shortcut */}
              {!customPathOpen && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleDefaultCwd(); }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    padding: "8px 10px",
                    background: "none",
                    border: "none",
                    borderTop: visibleProjects.length > 0 ? "1px solid var(--border)" : "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
                  </svg>
                   <span>{t("sidebar.useDefaultDirectory")}</span>
                </button>
              )}

              {/* Custom path directory picker */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleCustomPathClick();
                }}
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
                <span>{t("sidebar.customPath")}</span>
              </button>
          </AnimatedDropdown>
        </div>

        {sessionSearchOpen && (
          <input
            id="session-search-input"
            type="search"
            autoFocus
            value={sessionSearchQuery}
            maxLength={200}
            aria-label={t("sidebar.searchSessions")}
            placeholder={t("sidebar.searchSessions")}
            onChange={(event) => setSessionSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setSessionSearchQuery("");
              }
            }}
            className="mt-[6px] block h-[29px] w-full min-w-0 rounded-[7px] border border-border bg-bg px-[10px] text-xs text-text focus:outline-2 focus:outline-accent"
          />
        )}

        {/* Worktree switcher — shown only for git projects at a checkout top
            level (repo subdirs keep their own project identity, so switching
            from them would jump projects). Rendered whenever the selected cwd
            belongs to the loaded project (not just when forCwd matches), so
            switching between worktrees of one project keeps the row mounted
            instead of flickering while data refetches: all worktrees of a
            project share the same list anyway. */}
        {!sessionSearchOpen && showWorktreeSwitcher && worktreeState && (
          <WorktreeSwitcher
            worktreeState={worktreeState}
            currentWorktreePath={currentWorktreePath}
            homeDir={homeDir}
            onWorktreeChange={handleWorktreeSwitch}
            style={{ marginTop: 6 }}
          />
        )}
        {!sessionSearchOpen && inactiveWorktreeSelector && (
          <button
            type="button"
            aria-disabled="true"
            tabIndex={-1}
            title={inactiveWorktreeSelector.title}
            style={{
              width: "100%",
              height: 29,
              boxSizing: "border-box",
              marginTop: 6,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 10px",
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--bg-hover)",
              color: "var(--text-dim)",
              fontSize: 11,
              lineHeight: 1.35,
              whiteSpace: "nowrap",
              textAlign: "left",
              cursor: "default",
              opacity: 0.82,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{inactiveWorktreeSelector.label}</span>
          </button>
        )}
      </div>

      {/* Conversations module */}
      <div
        className="sidebar-conversations-section"
        style={{
          flex: explorerOpen && (selectedCwdProp || selectedCwd) ? "1 1 0" : "1 1 auto",
          minHeight: 80,
        }}
      >
      <div className="sidebar-section-heading">
        <ConversationsTabs
          tab={conversationsTab}
          onChange={setConversationsTab}
          activeCount={filteredSessions.filter((session) => !session.archived).length}
          archivedCount={filteredSessions.filter((session) => session.archived).length}
          t={t}
        />
        <div className="sidebar-section-actions">
          <button
            className="sidebar-new-session"
            onClick={handleNewSession}
            disabled={newSessionDisabled || conversationsTab === "archived"}
            title={canCreateSession ? t("sidebar.newSessionTitle", { path: selectedCwd ?? "" }) : t("sidebar.selectProject")}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><line x1="6" y1="1" x2="6" y2="11" /><line x1="1" y1="6" x2="11" y2="6" /></svg>
            {t("sidebar.new")}
          </button>
          <ToolbarIconButton
            onClick={toggleAllDayGroups}
            disabled={sessionDayGroups.length === 0}
            color="var(--text-dim)"
            title={t(anyDayGroupCollapsed ? "sidebar.expandAllGroups" : "sidebar.collapseAllGroups")}
          >
            {anyDayGroupCollapsed ? (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 6 5 5 5-5" /><path d="m7 13 5 5 5-5" /></svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m17 11-5-5-5 5" /><path d="m17 18-5-5-5 5" /></svg>
            )}
          </ToolbarIconButton>
          <ToolbarIconButton
            onClick={() => loadSessions(false, true)}
            title={t("sidebar.refresh")}
            skipHover={sessionRefreshDone}
            color={sessionRefreshDone ? "#4ade80" : "var(--text-dim)"}
            background={sessionRefreshDone ? "rgba(74,222,128,0.15)" : "none"}
          >
            {sessionRefreshDone ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg> : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>}
          </ToolbarIconButton>
          <ToolbarIconButton
            onClick={() => setSessionSearchOpen((open) => !open)}
            color={sessionSearchOpen ? "var(--accent)" : "var(--text-dim)"}
            background={sessionSearchOpen ? "rgba(37,99,235,0.12)" : "none"}
            title={t("sidebar.toggleSessionSearch")}
            ariaPressed={sessionSearchOpen}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
            </svg>
          </ToolbarIconButton>
        </div>
      </div>
      <div ref={conversationsListRef} className="sidebar-conversations-list" style={{ flex: "1 1 auto", overflowY: "auto", padding: "0", minHeight: 0 }}>
      <SessionSearch open={sessionSearchOpen} query={sessionSearchQuery} refreshKey={sessionListVersion} selectedSessionId={selectedSessionId} onSelectSession={handleSelectSessionFromList}>
        {loading && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("sidebar.loading")}
          </div>
        )}
        {error && (
          <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>
            {error}
          </div>
        )}
        {!loading && !error && sessionFamilies.length === 0 && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {conversationsTab === "archived" ? t("sidebar.noArchivedSessions") : t("sidebar.noSessions")}
          </div>
        )}
        {sessionDayGroups.map((group) => {
          const collapsed = collapsedDayGroups.has(group.dateKey);
          const labels = {
            today: t("sidebar.today"),
            daysAgo: (n: number) => t("sidebar.daysAgo", { count: n }),
          };
          const groupLabel = formatDayLabel(group.latestModified, locale, new Date(), labels);
          return (
            <SessionDayGroupSection
              key={group.dateKey}
              group={group}
              collapsed={collapsed}
              label={groupLabel}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              unreadSessionIds={unreadSessionIds}
              archivedView={conversationsTab === "archived"}
              onSelectSession={handleSelectSessionFromList}
              onRenamed={loadSessions}
              onArchivedChange={loadSessions}
              onSessionDeleted={(id) => {
                onSessionDeleted?.(id);
                loadSessions();
              }}
              onToggleCollapse={() => {
                setCollapsedDayGroups((prev) => {
                  const next = new Set(prev);
                  if (next.has(group.dateKey)) next.delete(group.dateKey);
                  else next.add(group.dateKey);
                  return next;
                });
              }}
              t={t}
            />
          );
        })}
      </SessionSearch>
      </div>
      </div>

      {/* File Explorer section */}
      {(selectedCwdProp || selectedCwd) && (
        <div
          className="sidebar-explorer-section"
          style={{
            display: "flex",
            flexDirection: "column",
            flex: explorerOpen ? "1 1 0" : "0 0 auto",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <div className="sidebar-explorer-heading">
            <button
              className="sidebar-explorer-toggle"
              onClick={() => setExplorerOpen((open) => {
                const next = !open;
                saveExplorerOpen(next);
                return next;
              })}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flex: 1,
                padding: "8px 10px",
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                textAlign: "left",
              }}
            >
              <svg
                width="9" height="9" viewBox="0 0 10 10" fill="none"
                stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: explorerOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
              >
                <polyline points="3 2 7 5 3 8" />
              </svg>
              {t("files.explorer")}
            </button>
            {onOpenTerminal && (
              <ToolbarIconButton
                onClick={() => onOpenTerminal(selectedCwd ?? selectedCwdProp!)}
                title={t("terminal.openWorkspace")}
                color="var(--text-dim)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
                </svg>
              </ToolbarIconButton>
            )}
            {explorerOpen && changesCount > 0 && (
              <ToolbarIconButton
                onClick={() => setChangesCollapsed((v) => !v)}
                title={t("sidebar.changedFiles", { count: changesCount })}
                ariaPressed={!changesCollapsed}
                color={changesCollapsed ? "var(--text-dim)" : "var(--accent)"}
                background={changesCollapsed ? "none" : "var(--bg-selected)"}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M3 12h6" />
                  <path d="M15 12h6" />
                </svg>
              </ToolbarIconButton>
            )}
            {explorerOpen && (
              <ToolbarIconButton
                onClick={() => {
                  setFileSearchOpen((open) => !open);
                }}
                title={t("sidebar.searchFiles")}
                ariaPressed={fileSearchOpen}
                color={fileSearchOpen ? "var(--accent)" : "var(--text-dim)"}
                background={fileSearchOpen ? "var(--bg-selected)" : "none"}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
                </svg>
              </ToolbarIconButton>
            )}
            {explorerOpen && (
              <ToolbarIconButton
                onClick={() => fileExplorerRef.current?.openUploadPicker()}
                disabled={explorerUploadBusy}
                title={t("sidebar.uploadFilesTitle")}
                color="var(--text-dim)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="m17 8-5-5-5 5" />
                  <path d="M12 3v12" />
                </svg>
              </ToolbarIconButton>
            )}
            {explorerOpen && (
              <ToolbarIconButton
                onClick={() => void handleOpenInFileBrowser()}
                disabled={fileBrowserOpening}
                title={t("sidebar.openNativeFileBrowser")}
                color="var(--text-dim)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </ToolbarIconButton>
            )}
            <ToolbarIconButton
              onClick={() => {
                if (onExplorerRefresh) onExplorerRefresh();
                else setExplorerKey((k) => k + 1);
                setExplorerRefreshDone(true);
                if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
                explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
              }}
              title={t("sidebar.refreshExplorer")}
              skipHover={explorerRefreshDone}
              color={explorerRefreshDone ? "#4ade80" : "var(--text-dim)"}
              background={explorerRefreshDone ? "rgba(74,222,128,0.18)" : "none"}
              marginRight={6}
            >
              {explorerRefreshDone ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </ToolbarIconButton>
          </div>
          {explorerOpen && (
            <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
              <FileExplorer
                ref={fileExplorerRef}
                cwd={selectedCwd ?? selectedCwdProp!}
                onOpenFile={onOpenFile ?? (() => {})}
                onFileMutation={onFileMutation}
                refreshKey={explorerKey}
                onAtMention={onAtMention}
                onAtMentions={onAtMentions}
                onUploadBusyChange={setExplorerUploadBusy}
                changesCollapsed={changesCollapsed}
                onChangesCountChange={setChangesCount}
                fileSearchOpen={fileSearchOpen}
                onFileSearchOpenChange={setFileSearchOpen}
              />
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

function ConversationsTabButton({
  isActive,
  onClick,
  label,
  count,
}: {
  isActive: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "4px 8px",
        border: "none",
        background: isActive ? "var(--bg-selected)" : "none",
        color: isActive ? "var(--text)" : "var(--text-dim)",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 600,
        fontFamily: "var(--font-mono)",
        borderRadius: 6,
        transition: "background 0.12s, color 0.12s",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => {
        if (isActive) return;
        e.currentTarget.style.background = "var(--bg-hover)";
        e.currentTarget.style.color = "var(--text-muted)";
      }}
      onMouseLeave={(e) => {
        if (isActive) return;
        e.currentTarget.style.background = "none";
        e.currentTarget.style.color = "var(--text-dim)";
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
        <span className="sidebar-section-marker" aria-hidden="true" style={isActive ? {} : { opacity: 0.4 }} />
        <span>{label}</span>
      </span>
      {count > 0 && <span className="sidebar-section-count">{count}</span>}
    </button>
  );
}

/** Two-tab switcher (Conversations | Archive) that replaces the single
 *  sidebar-section-title inside the conversations heading. */
function ConversationsTabs({
  tab,
  onChange,
  activeCount,
  archivedCount,
  t,
}: {
  tab: "active" | "archived";
  onChange: (tab: "active" | "archived") => void;
  activeCount: number;
  archivedCount: number;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 2,
      minWidth: 0,
      padding: "2px",
      background: "var(--bg)",
      borderRadius: 8,
      border: "1px solid var(--border)",
      flexShrink: 1,
      overflow: "hidden",
    }}>
      <ConversationsTabButton
        isActive={tab === "active"}
        onClick={() => onChange("active")}
        label={t("sidebar.tabConversations")}
        count={activeCount}
      />
      <ConversationsTabButton
        isActive={tab === "archived"}
        onClick={() => onChange("archived")}
        label={t("sidebar.tabArchive")}
        count={archivedCount}
      />
    </div>
  );
}

/** A persistent, compact workspace rail. It mirrors the dropdown's project
 * selection state while making cross-project activity visible at a glance.
 * Hovering a project tile surfaces a right-side floating card with the
 * project's running sessions, their git branch, and current model. */
/** Outcome reported back to the rail card after a project delete attempt. */
type ProjectDeleteOutcome =
  | { ok: true }
  | { ok: false; reason: "blocked-running" | "failed" };

function ProjectRail({
  projects,
  selectedProjectKey,
  selectedSessionId,
  activity,
  allSessions,
  runningSessionIds,
  runningSessionDetails,
  unreadSessionIds,
  onSelect,
  onSelectSession,
  onAddProject,
  onAddDroppedFolders,
  folderDropNotice,
  onDismissFolderDropNotice,
  onReorder,
  onDeleteProject,
  projectAliases,
  onRenameProject,
}: {
  projects: readonly ProjectSelection[];
  selectedProjectKey: string | null;
  /** Highlights the currently open session's card in the tooltip list. */
  selectedSessionId: string | null;
  activity: ReadonlyMap<string, { running: number; unread: number }>;
  allSessions: readonly SessionInfo[];
  runningSessionIds: ReadonlySet<string>;
  runningSessionDetails: readonly RunningRpcSessionDetail[];
  unreadSessionIds: ReadonlySet<string>;
  onSelect: (project: ProjectSelection) => void;
  /** Jump straight to a session from the tooltip card. */
  onSelectSession: (s: SessionInfo) => void;
  onAddProject: () => void;
  /** Handles OS folder drops on the rail; see handleDroppedProjectFolders. */
  onAddDroppedFolders: (dropped: DroppedFolderPaths) => void;
  /** True after a browser drop that recognized folders but could not resolve
   *  their absolute paths; renders an inline explanation beside the rail. */
  folderDropNotice: boolean;
  onDismissFolderDropNotice: () => void;
  onReorder: (keys: string[]) => void;
  onDeleteProject?: (project: ProjectSelection) => Promise<ProjectDeleteOutcome>;
  projectAliases: ProjectAliasMap;
  onRenameProject: (project: ProjectSelection, name: string) => void;
}) {
  const { t } = useI18n();
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ key: string; after: boolean } | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  // OS folder drags highlight the whole rail; a depth counter keeps the
  // highlight stable while the pointer crosses tile boundaries.
  const [folderDragActive, setFolderDragActive] = useState(false);
  const folderDragDepthRef = useRef(0);
  const resetFolderDrag = useCallback(() => {
    folderDragDepthRef.current = 0;
    setFolderDragActive(false);
  }, []);
  const handleFolderDragEnter = useCallback((event: React.DragEvent) => {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    folderDragDepthRef.current += 1;
    setFolderDragActive(true);
  }, []);
  const handleFolderDragOver = useCallback((event: React.DragEvent) => {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);
  const handleFolderDragLeave = useCallback((event: React.DragEvent) => {
    if (!isFileDrag(event.dataTransfer)) return;
    folderDragDepthRef.current -= 1;
    if (folderDragDepthRef.current <= 0) resetFolderDrag();
  }, [resetFolderDrag]);
  const handleFolderDrop = useCallback((event: React.DragEvent) => {
    if (!isFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    resetFolderDrag();
    onAddDroppedFolders(collectDroppedFolders(event.dataTransfer));
  }, [onAddDroppedFolders, resetFolderDrag]);
  // The hovered tile element, captured in onMouseEnter so the tooltip has a
  // stable anchor regardless of ref-callback timing.
  const [hoveredEl, setHoveredEl] = useState<HTMLElement | null>(null);
  // The card stays open while the pointer is over the tile OR the card
  // itself. Leaving either schedules a short-delay close so the pointer can
  // cross the tile→card gap without the card blinking (each remount replays
  // the entrance slide, which reads as jitter).
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  const openTooltip = useCallback((key: string, el: HTMLElement) => {
    cancelScheduledClose();
    setHoveredKey(key);
    setHoveredEl(el);
  }, [cancelScheduledClose]);
  const closeTooltip = useCallback(() => {
    cancelScheduledClose();
    setHoveredKey(null);
    setHoveredEl(null);
  }, [cancelScheduledClose]);
  const scheduleTooltipClose = useCallback(() => {
    cancelScheduledClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setHoveredKey(null);
      setHoveredEl(null);
    }, PROJECT_RAIL_TOOLTIP_HIDE_DELAY_MS);
  }, [cancelScheduledClose]);
  useEffect(() => cancelScheduledClose, [cancelScheduledClose]);

  // Index running-session model/state snapshots by id for O(1) lookup.
  const detailById = useMemo(() => {
    const map = new Map<string, RunningRpcSessionDetail>();
    for (const detail of runningSessionDetails) map.set(detail.id, detail);
    return map;
  }, [runningSessionDetails]);

  return (
    <nav
      className={`project-rail${folderDragActive ? " is-folder-drag" : ""}`}
      aria-label={t("sidebar.selectProject")}
      title={folderDragActive ? t("sidebar.dropToAddProject") : undefined}
      onDragEnter={handleFolderDragEnter}
      onDragOver={handleFolderDragOver}
      onDragLeave={handleFolderDragLeave}
      onDrop={handleFolderDrop}
    >
      <div className="project-rail-mark" aria-hidden="true">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h4l1.7 2H18.5A1.5 1.5 0 0 1 20 7.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z" />
        </svg>
      </div>
      <div className="project-rail-list">
        {projects.map((project) => {
          const active = project.key === selectedProjectKey;
          const state = activity.get(project.key);
          const name = projectDisplayName(project.root, projectAliases[project.key]);
          const isDragging = draggingKey === project.key;
          const showTooltip = hoveredKey === project.key && !isDragging && !dropTarget;
          return (
            <div
              key={project.key}
              className="project-rail-tile"
              onMouseEnter={(event) => openTooltip(project.key, event.currentTarget as HTMLElement)}
              onMouseLeave={scheduleTooltipClose}
            >
              <button
                type="button"
                className={`project-rail-item${active ? " is-active" : ""}${isDragging ? " is-dragging" : ""}${dropTarget?.key === project.key ? (dropTarget.after ? " is-drop-after" : " is-drop-before") : ""}`}
                draggable
                onDragStart={(event) => {
                  setDraggingKey(project.key);
                  setDropTarget(null);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", project.key);
                }}
                onDragEnd={() => {
                  setDraggingKey(null);
                  setDropTarget(null);
                }}
                onDragOver={(event) => {
                  // External OS drags (folder drop to add) must fall through
                  // to the rail-level handlers instead of showing reorder
                  // insertion markers.
                  if (isFileDrag(event.dataTransfer)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  const rect = event.currentTarget.getBoundingClientRect();
                  setDropTarget({ key: project.key, after: event.clientY > rect.top + rect.height / 2 });
                }}
                onDrop={(event) => {
                  if (isFileDrag(event.dataTransfer)) return;
                  event.preventDefault();
                  const sourceKey = event.dataTransfer.getData("text/plain") || draggingKey;
                  const after = dropTarget?.key === project.key ? dropTarget.after : false;
                  setDraggingKey(null);
                  setDropTarget(null);
                  if (!sourceKey || sourceKey === project.key) return;
                  const keys = projects.map((item) => item.key);
                  const sourceIndex = keys.indexOf(sourceKey);
                  const targetIndex = keys.indexOf(project.key);
                  if (sourceIndex < 0 || targetIndex < 0) return;
                  keys.splice(sourceIndex, 1);
                  const insertionIndex = (sourceIndex < targetIndex ? targetIndex - 1 : targetIndex) + (after ? 1 : 0);
                  keys.splice(insertionIndex, 0, sourceKey);
                  onReorder(keys);
                }}
                onClick={() => onSelect(project)}
                aria-label={project.root}
                aria-current={active ? "page" : undefined}
              >
                <span className="project-rail-monogram" aria-hidden="true">{name.slice(0, 2).toUpperCase()}</span>
                {state?.running ? <span className="project-rail-running" /> : null}
                {!state?.running && state?.unread ? <span className="project-rail-unread" /> : null}
              </button>
              {showTooltip ? (
                <ProjectRailTooltip
                  project={project}
                  allSessions={allSessions}
                  selectedSessionId={selectedSessionId}
                  runningSessionIds={runningSessionIds}
                  detailById={detailById}
                  unreadSessionIds={unreadSessionIds}
                  anchorEl={hoveredEl}
                  onSelectSession={onSelectSession}
                  onClose={closeTooltip}
                  onDeleteProject={onDeleteProject}
                  displayName={name}
                  onRenameProject={onRenameProject}
                  onMouseEnter={cancelScheduledClose}
                  onMouseLeave={scheduleTooltipClose}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <button type="button" className="project-rail-add" onClick={onAddProject} title={t("sidebar.selectProject")} aria-label={t("sidebar.selectProject")}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
      </button>
      {folderDragActive ? (
        // Prominent "ready to receive" state covering the whole rail. The
        // tiles dim behind it; pointer-events stay off so drag events keep
        // flowing to the nav handlers above.
        <div className="project-rail-drop-overlay" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h4l1.7 2H18.5A1.5 1.5 0 0 1 20 7.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z" />
            <line x1="12" y1="10.5" x2="12" y2="15.5" />
            <line x1="9.5" y1="13" x2="14.5" y2="13" />
          </svg>
          <span className="project-rail-drop-text">{t("sidebar.dropToAddProject")}</span>
        </div>
      ) : null}
      {folderDropNotice ? (
        // Browser limitation notice: the drop carried folders but the browser
        // cannot turn them into absolute paths. Offer the manual picker
        // instead of having opened it automatically.
        <div className="project-rail-drop-notice" role="status">
          <span>{t("sidebar.dropPathUnavailable")}</span>
          <button
            type="button"
            className="project-rail-drop-notice-action"
            onClick={() => {
              onDismissFolderDropNotice();
              onAddProject();
            }}
          >
            {t("sidebar.selectProject")}
          </button>
        </div>
      ) : null}
    </nav>
  );
}

/** Right-side floating card for a project tile. Lists the project's running
 *  sessions (title + branch + model) and any sessions that finished in the
 *  background and are waiting for the user to check them (unread). Rendered
 *  through a portal at the document root with position:fixed so it escapes
 *  the rail's overflow:hidden ancestors and always stacks on top. `anchorEl`
 *  is the hovered tile element; the card measures it via useLayoutEffect and
 *  tracks it on scroll/resize. */
function ProjectRailTooltip({
  project,
  allSessions,
  selectedSessionId,
  runningSessionIds,
  detailById,
  unreadSessionIds,
  anchorEl,
  onSelectSession,
  onClose,
  onDeleteProject,
  displayName,
  onRenameProject,
  onMouseEnter,
  onMouseLeave,
}: {
  project: ProjectSelection;
  allSessions: readonly SessionInfo[];
  selectedSessionId: string | null;
  runningSessionIds: ReadonlySet<string>;
  detailById: Map<string, RunningRpcSessionDetail>;
  unreadSessionIds: ReadonlySet<string>;
  anchorEl: HTMLElement | null | undefined;
  /** Opens the clicked session (same as clicking its row in the tree). */
  onSelectSession: (s: SessionInfo) => void;
  /** Closes the tooltip immediately (after a card click). */
  onClose: () => void;
  onDeleteProject?: (project: ProjectSelection) => Promise<ProjectDeleteOutcome>;
  /** Alias-aware project name (matches the rail tile's monogram). */
  displayName: string;
  onRenameProject?: (project: ProjectSelection, name: string) => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const { t } = useI18n();
  const name = displayName;

  // Sessions that belong to this project (by stable workspace key) and are
  // currently running. allSessions already carries branch + cwd from the
  // server; detailById supplies the live in-memory model.
  const running = useMemo(() => {
    const list: Array<{ session: SessionInfo; detail: RunningRpcSessionDetail | undefined }> = [];
    for (const session of allSessions) {
      if (workspaceKeyOf(session) !== project.key) continue;
      if (!runningSessionIds.has(session.id)) continue;
      list.push({ session, detail: detailById.get(session.id) });
    }
    // Most recently active first.
    list.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    return list;
  }, [allSessions, project.key, runningSessionIds, detailById]);

  // Sessions that finished in the background and haven't been viewed yet
  // ("waiting for check"). allSessions carries branch + cwd; the model is no
  // longer in memory once idle, so we show a completed badge instead.
  const unread = useMemo(() => {
    const list: SessionInfo[] = [];
    for (const session of allSessions) {
      if (workspaceKeyOf(session) !== project.key) continue;
      if (!unreadSessionIds.has(session.id)) continue;
      list.push(session);
    }
    list.sort((a, b) => b.modified.localeCompare(a.modified));
    return list;
  }, [allSessions, project.key, unreadSessionIds]);

  // Two-step destructive delete of the whole project. `armed` swaps the footer
  // ``btn into an inline confirm; `busy` throttles the in-flight call; the
  // parent reports blocked-running/failed back so the card can surface it.
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<"blocked-running" | "failed" | null>(null);

  // Inline rename of the project's display name. `cancelledRef` guards the
  // blur handler so Escape (cancel) never commits a half-typed name; blur and
  // Enter both commit. Committing the folder's own name clears the alias so
  // the storage never holds a redundant entry.
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renameCancelledRef = useRef(false);
  const startRename = useCallback(() => {
    renameCancelledRef.current = false;
    setRenameValue(name);
    setRenaming(true);
  }, [name]);
  const commitRename = useCallback(() => {
    if (!onRenameProject) return;
    const trimmed = renameValue.trim();
    onRenameProject(project, trimmed === projectFolderName(project.root) ? "" : trimmed);
    setRenaming(false);
  }, [onRenameProject, project, renameValue]);
  // Focus + select the whole name once the input mounts, matching the
  // session-row rename behavior.
  const focusRenameInput = useCallback((el: HTMLInputElement | null) => {
    el?.focus();
    el?.select();
  }, []);
  const busyCount = running.length;
  const projectSessionsCount = useMemo(() => {
    let count = 0;
    for (const session of allSessions) {
      if (workspaceKeyOf(session) === project.key) count += 1;
    }
    return count;
  }, [allSessions, project.key]);

  // Measure the anchor tile and keep the fixed card aligned on scroll/resize.
  // useLayoutEffect so the rect is current before paint (no flicker).
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [cardSize, setCardSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useLayoutEffect(() => {
    if (!anchorEl) return;
    const measure = () => {
      setAnchorRect(anchorEl.getBoundingClientRect());
      const el = cardRef.current;
      if (el) setCardSize({ w: el.offsetWidth, h: el.offsetHeight });
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [anchorEl]);

  // Position the fixed card to the right of the tile, vertically centered,
  // clamped on all four sides so it never overflows the viewport.
  const style: CSSProperties = useMemo(() => {
    if (!anchorRect) return { visibility: "hidden" as const };
    const gap = 10;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cardW = cardSize.w || 300;
    const cardH = cardSize.h || 0;
    // Horizontal: prefer to the right of the tile; if it would overflow the
    // right edge, fall back to the left of the tile; clamp the fallback too.
    let left = anchorRect.right + gap;
    if (left + cardW > vw - 8) {
      const leftSide = anchorRect.left - gap - cardW;
      left = leftSide >= 8 ? leftSide : Math.max(8, Math.min(left, vw - cardW - 8));
    }
    // Vertical: center on the tile, then clamp within the viewport.
    let top = anchorRect.top + anchorRect.height / 2 - cardH / 2;
    top = Math.max(8, Math.min(top, vh - cardH - 8));
    return { left, top };
  }, [anchorRect, cardSize]);

  return createPortal(
    <div
      className="project-rail-tooltip"
      role="tooltip"
      style={style}
      ref={cardRef}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="project-rail-tooltip-head">
        <div className="project-rail-tooltip-name-row">
          {renaming ? (
            <input
              ref={focusRenameInput}
              className="project-rail-tooltip-rename-input"
              value={renameValue}
              maxLength={80}
              spellCheck={false}
              autoComplete="off"
              aria-label={t("sidebar.renameProject")}
              onChange={(event) => setRenameValue(event.target.value)}
              onBlur={() => {
                if (renameCancelledRef.current) return;
                commitRename();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  renameCancelledRef.current = true;
                  setRenaming(false);
                }
              }}
            />
          ) : (
            <>
              <span className="project-rail-tooltip-name" title={name}>{name}</span>
              {onRenameProject ? (
                <button
                  type="button"
                  className="project-rail-tooltip-rename-btn"
                  title={t("sidebar.renameProject")}
                  aria-label={t("sidebar.renameProject")}
                  onClick={(event) => {
                    event.stopPropagation();
                    startRename();
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
                </button>
              ) : null}
            </>
          )}
        </div>
        <span className="project-rail-tooltip-path">{displayCwd(project.root)}</span>
      </div>
      {running.length > 0 ? (
        <div className="project-rail-tooltip-section">
          <div className="project-rail-tooltip-label">
            {t("sidebar.projectRunningCount", { count: running.length })}
          </div>
          <ul className="project-rail-tooltip-list">
            {running.map(({ session, detail }) => {
              const modelText = detail?.model ? `${detail.model.provider}/${detail.model.id}` : t("sidebar.modelUnknown");
              const sessionTitle = sessionDisplayName(session);
              return (
              <li
                key={session.id}
                className={`project-rail-tooltip-card is-clickable${session.id === selectedSessionId ? " is-selected" : ""}`}
                role="button"
                tabIndex={0}
                title={sessionTitle}
                onClick={() => {
                  onSelectSession(session);
                  onClose();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectSession(session);
                    onClose();
                  }
                }}
              >
                <span className={`project-rail-tooltip-dot${detail?.streaming ? " is-streaming" : detail?.compacting ? " is-compacting" : detail?.bashRunning ? " is-bash" : ""}`} aria-hidden="true" />
                <span className="project-rail-tooltip-card-body">
                  <span className="project-rail-tooltip-card-title" title={sessionTitle}>{sessionTitle}</span>
                  <span className="project-rail-tooltip-card-row">
                    <svg className="project-rail-tooltip-branch-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>
                    <span className="project-rail-tooltip-branch-text" title={session.branch ?? ""}>{session.branch ?? t("sidebar.noBranch")}</span>
                  </span>
                  <span className="project-rail-tooltip-card-row project-rail-tooltip-card-meta">
                    {detail?.model ? modelText : <span className="project-rail-tooltip-muted">{modelText}</span>}
                  </span>
                </span>
              </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {unread.length > 0 ? (
        <div className="project-rail-tooltip-section">
          <div className="project-rail-tooltip-label">
            {t("sidebar.projectUnreadCount", { count: unread.length })}
          </div>
          <ul className="project-rail-tooltip-list">
            {unread.map((session) => {
              const sessionTitle = sessionDisplayName(session);
              return (
              <li
                key={session.id}
                className={`project-rail-tooltip-card is-clickable${session.id === selectedSessionId ? " is-selected" : ""}`}
                role="button"
                tabIndex={0}
                title={sessionTitle}
                onClick={() => {
                  onSelectSession(session);
                  onClose();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectSession(session);
                    onClose();
                  }
                }}
              >
                <span className="project-rail-tooltip-dot is-done" aria-hidden="true" />
                <span className="project-rail-tooltip-card-body">
                  <span className="project-rail-tooltip-card-title" title={sessionTitle}>{sessionTitle}</span>
                  <span className="project-rail-tooltip-card-row">
                    <svg className="project-rail-tooltip-branch-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>
                    <span className="project-rail-tooltip-branch-text" title={session.branch ?? ""}>{session.branch ?? t("sidebar.noBranch")}</span>
                  </span>
                  <span className="project-rail-tooltip-card-row project-rail-tooltip-card-meta">
                    <span className="project-rail-tooltip-done">{t("sidebar.sessionCompleted")}</span>
                  </span>
                </span>
              </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {running.length === 0 && unread.length === 0 ? (
        <div className="project-rail-tooltip-section">
          <div className="project-rail-tooltip-empty">{t("sidebar.projectNotRunning")}</div>
        </div>
      ) : null}
      {onDeleteProject ? (
        <div className="project-rail-tooltip-delete">
          {!armed && !busy ? (
            busyCount > 0 ? (
              <button
                type="button"
                className="project-rail-tooltip-delete-btn is-disabled"
                disabled
                title={t("sidebar.deleteProjectRunningBlocked")}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                {t("sidebar.deleteProject")}
              </button>
            ) : (
              <button
                type="button"
                className="project-rail-tooltip-delete-btn"
                onClick={() => {
                  setArmed(true);
                  setDeleteError(null);
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                {t("sidebar.deleteProject")}
              </button>
            )
          ) : busy ? (
            <button type="button" className="project-rail-tooltip-delete-btn is-busy" disabled>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
              {t("sidebar.deleteProjectProgress")}
            </button>
          ) : (
            <div className="project-rail-tooltip-delete-confirm">
              <div className="project-rail-tooltip-delete-count">
                {t("sidebar.deleteProjectCount")}{" "}
                <span className="project-rail-tooltip-delete-count-num">
                  {t("sidebar.deleteProjectConfirm", { count: String(projectSessionsCount) })}
                </span>
              </div>
              {deleteError ? (
                <div className="project-rail-tooltip-delete-error">
                  {deleteError === "blocked-running"
                    ? t("sidebar.deleteProjectRunningBlocked")
                    : t("sidebar.deleteProjectError")}
                </div>
              ) : null}
              <div className="project-rail-tooltip-delete-actions">
                <button
                  type="button"
                  className="project-rail-tooltip-delete-btn is-danger"
                  onClick={async () => {
                    setBusy(true);
                    setDeleteError(null);
                    try {
                      const outcome = await onDeleteProject(project);
                      if (!outcome.ok) {
                        setDeleteError(outcome.reason);
                      }
                      setArmed(false);
                      setBusy(false);
                    } catch {
                      setDeleteError("failed");
                      setArmed(false);
                      setBusy(false);
                    }
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                  {t("sidebar.deleteProjectConfirm", { count: String(projectSessionsCount) })}
                </button>
                <button
                  type="button"
                  className="project-rail-tooltip-delete-btn"
                  onClick={() => {
                    setArmed(false);
                    setDeleteError(null);
                  }}
                >
                  {t("sidebar.cancelRemove")}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}


function SessionDayGroupSection({
  group,
  collapsed,
  label,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  archivedView,
  onSelectSession,
  onRenamed,
  onArchivedChange,
  onSessionDeleted,
  onToggleCollapse,
  t,
}: {
  group: SessionDayGroup;
  collapsed: boolean;
  label: string;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  archivedView: boolean;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onArchivedChange?: () => void;
  onSessionDeleted?: (id: string) => void;
  onToggleCollapse: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const [bulkBusy, setBulkBusy] = useState(false);
  const [headerHovered, setHeaderHovered] = useState(false);
  // Root session ids of every family in this day group. Archiving the root is
  // enough — subagents are derived rows that follow their parent.
  const bulkIds = useMemo(
    () => group.families.map((family) => family.root.id),
    [group.families],
  );
  const handleBulkArchive = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (bulkBusy || bulkIds.length === 0) return;
    setBulkBusy(true);
    try {
      await Promise.all(
        bulkIds.map((id) =>
          fetch(`/api/sessions/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archived: true }),
          }).catch(() => {}),
        ),
      );
      onArchivedChange?.();
    } finally {
      setBulkBusy(false);
    }
  }, [bulkBusy, bulkIds, onArchivedChange]);
  return (
    <div className="sidebar-session-day-group">
      <div
        className={`sidebar-session-day-header${collapsed ? " is-collapsed" : ""}`}
        onMouseEnter={() => setHeaderHovered(true)}
        onMouseLeave={() => setHeaderHovered(false)}
      >
        <button
          className="sidebar-session-day-header-toggle"
          onClick={onToggleCollapse}
          title={t(collapsed ? "sidebar.expandGroup" : "sidebar.collapseGroup")}
        >
          <svg
            className="sidebar-day-caret"
            width="9"
            height="9"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0 }}
          >
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
          <span className="sidebar-session-day-header-label">{label}</span>
          <span className="sidebar-session-day-count">{group.families.length}</span>
        </button>
        {/* Bulk archive for the whole day group. Shown only on the active
            Conversations tab, revealed on header hover (collapsed or expanded)
            so the label stays uncluttered otherwise. Kept visible mid-flight. */}
        {!archivedView && (headerHovered || bulkBusy) && (
          <button
            onClick={handleBulkArchive}
            disabled={bulkBusy}
            title={t("sidebar.archiveAllTitle")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: 22, height: 22, padding: 0, flexShrink: 0,
              background: "none", border: "1px solid var(--border)",
              borderRadius: 5, color: "var(--text-dim)",
              cursor: bulkBusy ? "default" : "pointer",
              fontSize: 10, opacity: bulkBusy ? 0.5 : 1,
              transition: "background 0.12s, color 0.12s, border-color 0.12s",
            }}
            onMouseEnter={(e) => {
              if (bulkBusy) return;
              e.currentTarget.style.background = "var(--bg-hover)";
              e.currentTarget.style.color = "var(--accent)";
              e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "none";
              e.currentTarget.style.color = "var(--text-dim)";
              e.currentTarget.style.borderColor = "var(--border)";
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="21 8 21 21 3 21 3 8" />
              <rect x="1" y="3" width="22" height="5" rx="1" />
              <line x1="10" y1="12" x2="14" y2="12" />
            </svg>
          </button>
        )}
      </div>
      {!collapsed && group.families.map((family) => {
        const familySessions = [family.root, ...family.subagents];
        const displaySession = family.latestModified === family.root.modified
          ? family.root
          : { ...family.root, modified: family.latestModified };
        return (
          <SessionItem
            key={family.root.id}
            session={displaySession}
            isSelected={familySessions.some((session) => session.id === selectedSessionId)}
            isRunning={familySessions.some((session) => runningSessionIds.has(session.id))}
            isUnread={familySessions.some((session) => unreadSessionIds.has(session.id))}
            archivedView={archivedView}
            onClick={() => onSelectSession(family.root)}
            onRenamed={onRenamed}
            onArchivedChange={onArchivedChange}
            onDeleted={(id) => onSessionDeleted?.(id)}
          />
        );
      })}
    </div>
  );
}

function RunningSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar.agentRunning")}
      aria-label={t("sidebar.agentRunning")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <g>
          <path
            d="M21 12a9 9 0 1 1-3.8-7.4"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
          />
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
      </svg>
    </span>
  );
}

function UnreadSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar.newActivity")}
      aria-label={t("sidebar.newSessionActivity")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "#0891b2",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <circle cx="7" cy="7" r="2.5" fill="currentColor" />
        <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" opacity="0.32">
          <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.32;0;0.32" dur="1.6s" repeatCount="indefinite" />
        </circle>
      </svg>
    </span>
  );
}

/**
 * Compact per-project activity badges for the workspace selector dropdown items:
 * a spinning running icon + count and an unread dot + count. Renders nothing
 * when the project has no activity. Counts share the accent / unread colors of
 * the per-session indicators so the two stay visually consistent.
 */
function showProjectActivity(
  activity: { running: number; unread: number } | undefined,
  t: (key: string) => string,
): ReactNode {
  if (!activity || (activity.running === 0 && activity.unread === 0)) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, marginLeft: 6 }}>
      {activity.running > 0 && (
        <span
          title={t("sidebar.agentRunning")}
          aria-label={`${t("sidebar.agentRunning")} (${activity.running})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--accent)", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
            <g>
              <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
            </g>
          </svg>
          {activity.running}
        </span>
      )}
      {activity.unread > 0 && (
        <span
          title={t("sidebar.newSessionActivity")}
          aria-label={`${t("sidebar.newSessionActivity")} (${activity.unread})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "#0891b2", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
          {activity.unread}
        </span>
      )}
    </span>
  );
}

function SessionItem({
  session,
  isSelected,
  isRunning,
  isUnread,
  archivedView = false,
  onClick,
  onRenamed,
  onArchivedChange,
  onDeleted,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  archivedView?: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onArchivedChange?: () => void;
  onDeleted?: (id: string) => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { locale, t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [hoveredEl, setHoveredEl] = useState<HTMLElement | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Select the whole name once the rename input is mounted (startRename's
  // immediate setTimeout can fire before the input exists).
  useEffect(() => {
    if (renaming) {
      const id = requestAnimationFrame(() => inputRef.current?.select());
      return () => cancelAnimationFrame(id);
    }
  }, [renaming]);

  // A stored first message may be an SDK-expanded <skill> block; collapse it
  // back to the compact /skill:name args command the user typed before using
  // it as the auto-name fallback, mirroring MessageView's rendering.
  const displayFirstMessage = skillExpansionToCommand(session.firstMessage) ?? session.firstMessage;
  const title = sessionDisplayName(session);

  const startRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (session.transient) return;
    setRenameValue(session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12));
    setRenaming(true);
  }, [session.name, session.transient, displayFirstMessage, session.id]);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    // No-op when unchanged: the fallback title (first message / id) isn't a
    // real stored name, so don't persist it as one. (The rename input seeds
    // from the same collapsed displayFirstMessage, so an untouched rename of
    // a skill-invoked session stays a no-op instead of persisting raw XML.)
    if (renameValue === title || name === (session.name ?? "")) return;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      onRenamed?.();
    } catch {
      // ignore
    }
  }, [renameValue, session.id, session.name, onRenamed, title]);

  const performDelete = useCallback(async () => {
    if (session.transient) return;
    setConfirmDelete(false);
    setDeleting(true);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      onDeleted?.(session.id);
    } catch {
      setDeleting(false);
    }
  }, [session.id, session.transient, onDeleted]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.shiftKey) {
      void performDelete();
    } else {
      setConfirmDelete(true);
    }
  }, [performDelete]);

  const handleDeleteConfirm = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    void performDelete();
  }, [performDelete]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  const [archiving, setArchiving] = useState(false);
  const toggleArchive = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (session.transient) return;
    setArchiving(true);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: !session.archived }),
      });
      onArchivedChange?.();
    } catch {
      // ignore
    } finally {
      setArchiving(false);
    }
  }, [session.id, session.transient, session.archived, onArchivedChange]);

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const handled = dispatchSessionRowContextMenu({
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      clientX: e.clientX,
      clientY: e.clientY,
      refresh: () => { onRenamed?.(); },
    });
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
  }, [onRenamed, session.cwd, session.id, session.name, session.path]);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  return (
    <div
      className="sidebar-session-record"
      onClick={confirmDelete || renaming ? undefined : onClick}
      onContextMenu={confirmDelete || renaming ? undefined : handleContextMenu}
      onMouseEnter={(e) => { setHovered(true); setHoveredEl(e.currentTarget); }}
      onMouseLeave={() => { setHovered(false); setHoveredEl(null); }}
      style={{
        height: SESSION_LIST_ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        paddingLeft: depth > 0 ? depth * 12 + 18 : 18,
        paddingRight: 8,
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "rgba(239,68,68,0.06)"
          : isSelected ? "color-mix(in srgb, var(--accent) 7%, transparent)" : hovered ? "var(--bg-hover)" : "transparent",
        transition: "background 0.1s",
        opacity: deleting ? 0.5 : 1,
        gap: 6,
        overflow: "hidden",
      }}
      data-selected={isSelected || undefined}
      data-session-id={session.id}
      data-confirming={confirmDelete || undefined}
    >
      {confirmDelete ? (
        /* ── Delete confirmation: same height, two flat buttons ── */
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("sidebar.deleteSession", { title: title.slice(0, 22) + (title.length > 22 ? "…" : "") })}
          </div>
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <button
              onClick={handleDeleteConfirm}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                height: 30, padding: "0 11px",
                background: "#ef4444", border: "none",
                borderRadius: 6, color: "#fff",
                cursor: "pointer", fontSize: 12, fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              {t("sidebar.delete")}
            </button>
            <button
              onClick={handleDeleteCancel}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                height: 30, padding: "0 11px",
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 6, color: "var(--text-muted)",
                cursor: "pointer", fontSize: 12, fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              {t("sidebar.cancel")}
            </button>
          </div>
        </>
      ) : renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          style={{
            flex: 1,
            fontSize: 12,
            padding: "5px 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: 30,
          }}
        />
      ) : (
        /* ── Normal view ── */
        <>
          {/* Subagent indicator for child sessions */}
          {depth > 0 && (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <rect x="5" y="7" width="14" height="11" rx="2" />
              <path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
            </svg>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                minWidth: 0,
                fontSize: 12.5,
                fontWeight: isSelected ? 600 : 400,
                lineHeight: 1.35,
                color: isSelected ? "var(--text)" : isUnread ? "var(--text)" : "var(--text-muted)",
                transition: "color 0.1s",
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {title}
              </span>
            </div>
            <div style={{ marginTop: 3, display: "flex", alignItems: "center", gap: 0, color: "var(--text-dim)", fontSize: 10.5, fontFamily: "var(--font-mono)", minWidth: 0, letterSpacing: "0.01em" }}>
              {isRunning ? (
                <RunningSessionIndicator />
              ) : isUnread ? (
                <UnreadSessionIndicator />
              ) : (
                <span title={session.modified} style={{ flexShrink: 0 }}>{formatSessionTimestamp(session.modified, locale)}</span>
              )}
              <span style={{ margin: "0 6px", color: "var(--border)", flexShrink: 0 }} aria-hidden="true">·</span>
              <span style={{ flexShrink: 0 }}>{t("sidebar.messagesCount", { count: session.messageCount })}</span>
              {session.isWorktree && session.branch && (
                <>
                  <span style={{ margin: "0 6px", color: "var(--border)", flexShrink: 0 }} aria-hidden="true">·</span>
                  <span
                    title={`Worktree: ${session.cwd}`}
                    style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--accent)", minWidth: 0, overflow: "hidden", flexShrink: 1 }}
                  >
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                      <line x1="6" y1="3" x2="6" y2="15" />
                      <circle cx="18" cy="6" r="3" />
                      <circle cx="6" cy="18" r="3" />
                      <path d="M18 9a9 9 0 0 1-9 9" />
                    </svg>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.branch}</span>
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={t(collapsed ? "sidebar.expandSubagents" : "sidebar.collapseSubagents")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, flexShrink: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 0.15s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}

          {/* Action buttons — shown on hover */}
          {hovered && !session.transient && (
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              <button
                onClick={startRename}
                title={t("sidebar.rename")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                  opacity: archiving ? 0.5 : 1,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-selected)";
                  e.currentTarget.style.color = "var(--accent)";
                  e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              {/* Archive button — only on the active Conversations tab. Once a
                  session is archived it lives in the Archive tab, where the
                  group header's bulk unarchive handles restoration instead. */}
              {!archivedView && (
                <button
                  onClick={toggleArchive}
                  title={t("sidebar.archiveTitle")}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 32, height: 32, padding: 0,
                    background: "var(--bg-hover)", border: "1px solid var(--border)",
                    borderRadius: 7, color: "var(--text-muted)",
                    cursor: "pointer", flexShrink: 0,
                    transition: "background 0.12s, color 0.12s, border-color 0.12s",
                    opacity: archiving ? 0.5 : 1,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-selected)";
                    e.currentTarget.style.color = "var(--accent)";
                    e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text-muted)";
                    e.currentTarget.style.borderColor = "var(--border)";
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="21 8 21 21 3 21 3 8" />
                    <rect x="1" y="3" width="22" height="5" rx="1" />
                    <line x1="10" y1="12" x2="14" y2="12" />
                  </svg>
                </button>
              )}
              <button
                onClick={handleDeleteClick}
                title={t("sidebar.deleteWithShiftClick")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(239,68,68,0.08)";
                  e.currentTarget.style.color = "#ef4444";
                  e.currentTarget.style.borderColor = "rgba(239,68,68,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </div>
          )}
        </>
      )}
      {!confirmDelete && !renaming && (
        <SessionTitleTooltip
          anchorEl={hoveredEl}
          open={hovered}
          title={title}
          messageCount={session.messageCount}
          timestamp={formatSessionTimestamp(session.modified, locale)}
          t={t}
        />
      )}
    </div>
  );
}
