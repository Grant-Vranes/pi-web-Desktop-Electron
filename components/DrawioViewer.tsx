"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { getFileApiUrl } from "@/lib/file-api";
import { fetchTextWithMetadata } from "@/lib/chunked-file-read";
import { isValidDrawioXml } from "@/lib/drawio-file";

const DRAWIO_APP_BASE = "/drawio";
const CHANGE_DEBOUNCE_MS = 500;
const INIT_TIMEOUT_MS = 30000;

// viewer.min.js 把所有资源根默认指向官方在线 viewer 域名;
// 全部钉到自托管副本,保证零外网(须在脚本求值前设置)。
const VIEWER_GLOBALS: Record<string, string> = {
  STYLE_PATH: `${DRAWIO_APP_BASE}/styles`,
  SHAPES_PATH: `${DRAWIO_APP_BASE}/shapes`,
  STENCIL_PATH: `${DRAWIO_APP_BASE}/stencils`,
  DRAW_MATH_URL: `${DRAWIO_APP_BASE}/math4/es5`,
  GRAPH_IMAGE_PATH: `${DRAWIO_APP_BASE}/img`,
  mxImageBasePath: `${DRAWIO_APP_BASE}/mxgraph/images`,
  mxBasePath: `${DRAWIO_APP_BASE}/mxgraph/`,
  RESOURCE_BASE: `${DRAWIO_APP_BASE}/resources/grapheditor`,
};

interface GraphViewerCtor {
  new (elt: Element, xmlNode: Element, config: Record<string, unknown>): unknown;
}

let viewerScriptState: "unloaded" | "loading" | "ready" = "unloaded";
const viewerWaiters: Array<(ok: boolean) => void> = [];

function loadDrawioViewerScript(): Promise<boolean> {
  if (viewerScriptState === "ready") return Promise.resolve(true);
  if (viewerScriptState === "loading") {
    return new Promise((resolve) => {
      viewerWaiters.push(resolve);
    });
  }
  viewerScriptState = "loading";
  const scope = window as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(VIEWER_GLOBALS)) {
    scope[key] = value;
  }
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = `${DRAWIO_APP_BASE}/js/viewer.min.js`;
    script.onload = () => {
      viewerScriptState = "ready";
      for (const resolve of viewerWaiters.splice(0)) resolve(true);
      resolve(true);
    };
    script.onerror = () => {
      viewerScriptState = "unloaded";
      for (const resolve of viewerWaiters.splice(0)) resolve(false);
      resolve(false);
    };
    document.head.appendChild(script);
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function LoadingPlaceholder({ absolute = false }: { absolute?: boolean }) {
  const { t } = useI18n();
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-dim)",
        fontSize: 13,
        ...(absolute ? { position: "absolute" as const, inset: 0, zIndex: 1 } : {}),
      }}
    >
      {t("i18n.loading")}
    </div>
  );
}

interface DrawioViewerProps {
  filePath: string;
  cwd?: string;
  sourceSessionId?: string | null;
  watchEnabled?: boolean;
  /** Called when the file cannot be rendered as a drawio diagram. */
  onFallbackToText: () => void;
}

type MetaResponse = { size?: number; error?: string };

type WriteResponse = { mtimeMs?: number; size?: number; error?: string };

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "4px 16px",
  borderBottom: "1px solid var(--border)",
  fontSize: 11,
  color: "var(--text-dim)",
  background: "var(--bg)",
  flexShrink: 0,
};

const ICON_BUTTON_STYLE: CSSProperties = {
  padding: "2px 8px",
  borderRadius: 4,
  border: "1px solid var(--border)",
  background: "var(--bg-panel)",
  color: "var(--text)",
  fontSize: 11,
  cursor: "pointer",
};

function DownloadLink({ filePath, sourceSessionId }: { filePath: string; sourceSessionId?: string | null }) {
  const { t } = useI18n();
  return (
    <a
      href={getFileApiUrl(filePath, "download", sourceSessionId)}
      download={getFileName(filePath)}
      title={t("i18n.downloadFile")}
      aria-label={t("i18n.downloadFile")}
      className="file-viewer-icon-button"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </a>
  );
}

/** 查看模式:viewer.min.js 只读渲染。diagram 无背景时默认白底,与文件本身一致。 */
function DrawioStaticView({ xml, reloadKey, onRenderError }: { xml: string; reloadKey: number; onRenderError: () => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const errorRef = useRef(onRenderError);
  errorRef.current = onRenderError;

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    container.textContent = "";
    void loadDrawioViewerScript().then((ok) => {
      if (cancelled) return;
      const ctor = (window as unknown as { GraphViewer?: GraphViewerCtor }).GraphViewer;
      if (!ok || !ctor) {
        errorRef.current();
        return;
      }
      try {
        const doc = new DOMParser().parseFromString(xml, "text/xml");
        const parsed = doc.documentElement;
        if (!parsed || parsed.nodeName === "parsererror") {
          errorRef.current();
          return;
        }
        container.textContent = "";
        const host = document.createElement("div");
        host.style.height = "100%";
        container.appendChild(host);
        new ctor(host, parsed, { nav: true, resize: true, border: 12, toolbar: "zoom pages lightbox" });
      } catch {
        errorRef.current();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [xml, reloadKey]);

  return <div ref={containerRef} style={{ height: "100%", overflow: "auto", background: "var(--bg-panel)" }} />;
}

export default function DrawioViewer({ filePath, cwd, sourceSessionId, watchEnabled = true, onFallbackToText }: DrawioViewerProps) {
  const { t, locale } = useI18n();

  const [xml, setXml] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [watching, setWatching] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveConflict, setSaveConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [initialEditXml, setInitialEditXml] = useState<string | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [frameError, setFrameError] = useState(false);
  const [frameNonce, setFrameNonce] = useState(0);

  const baseMtimeMsRef = useRef(0);
  const readRequestRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const latestXmlRef = useRef<string | null>(null);
  const lastBaselineRef = useRef<string | null>(null);
  const pendingXmlRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // drawio 应用界面语言映射(编辑 iframe 用)
  const drawioLang = useMemo(
    () => (locale === "zh-CN" ? "zh" : locale === "zh-TW" ? "zh-tw" : "en"),
    [locale],
  );

  const frameUrl = useMemo(() => {
    const params = new URLSearchParams({
      embed: "1",
      proto: "json",
      ui: "kennedy",
      noExitBtn: "1",
      spin: "1",
      lang: drawioLang,
    });
    return `${DRAWIO_APP_BASE}/index.html?${params.toString()}`;
  }, [drawioLang]);

  const checkAssets = useCallback(async () => {
    let response: Response;
    try {
      response = await fetch(`${DRAWIO_APP_BASE}/DRAWIO_VERSION`);
    } catch {
      // 浏览器离线 / 资产目录缺失:与 HTTP 失败同样走资产缺失提示。
      throw new Error(t("i18n.drawioLoadFailed"));
    }
    if (!response.ok) throw new Error(t("i18n.drawioLoadFailed"));
  }, [t]);

  const loadFile = useCallback(async () => {
    const requestId = ++readRequestRef.current;
    try {
      await checkAssets();
      if (requestId !== readRequestRef.current) return;
      const { text, mtimeMs, size: readSize } = await fetchTextWithMetadata(
        fetch,
        (offset) => getFileApiUrl(filePath, "read", sourceSessionId, { offset }),
        "drawio file",
      );
      if (requestId !== readRequestRef.current) return;
      if (!isValidDrawioXml(text)) throw new Error(t("i18n.invalidDrawioFile"));
      baseMtimeMsRef.current = mtimeMs;
      setSize(readSize);
      setXml(text);
      setReloadKey((k) => k + 1);
      setError(null);
    } catch (loadError) {
      if (requestId === readRequestRef.current) {
        setXml(null);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    }
  }, [checkAssets, filePath, sourceSessionId, t]);

  useEffect(() => {
    setXml(null);
    setSize(null);
    setMode("view");
    setError(null);
    void loadFile();
  }, [filePath, sourceSessionId, loadFile]);

  // Live watch:与 ExcalidrawViewer 相同模式。编辑模式不 clobber 画布。
  useEffect(() => {
    setWatching(false);
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (!watchEnabled) return;

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;
    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", () => {
      if (modeRef.current === "view") {
        void loadFile();
      } else {
        fetch(getFileApiUrl(filePath, "meta", sourceSessionId))
          .then((r) => r.json())
          .then((d: MetaResponse) => {
            if (typeof d.size === "number") setSize(d.size);
          })
          .catch(() => { /* ignore */ });
      }
    });
    const markDisconnected = () => setWatching(false);
    es.addEventListener("error", markDisconnected);
    es.onerror = markDisconnected;

    return () => {
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [filePath, sourceSessionId, watchEnabled, loadFile]);

  const writeXml = useCallback(
    async (content: string, options: { force?: boolean } = {}): Promise<"ok" | "conflict" | "error"> => {
      setSaving(true);
      setSaveError(null);
      try {
        const response = await fetch(getFileApiUrl(filePath, "write", sourceSessionId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, baseMtimeMs: options.force ? null : baseMtimeMsRef.current }),
        });
        if (response.status === 409) {
          setSaveConflict(true);
          return "conflict";
        }
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as WriteResponse | null;
          setSaveConflict(false);
          setSaveError(payload?.error ?? t("i18n.saveFailed"));
          return "error";
        }
        const result = (await response.json()) as WriteResponse;
        baseMtimeMsRef.current = result.mtimeMs ?? baseMtimeMsRef.current;
        if (typeof result.size === "number") setSize(result.size);
        setSaveConflict(false);
        setDirty(false);
        return "ok";
      } catch (e) {
        setSaveConflict(false);
        setSaveError(String(e));
        return "error";
      } finally {
        setSaving(false);
      }
    },
    [filePath, sourceSessionId, t],
  );

  const publishChange = useCallback(
    (content: string) => {
      pendingXmlRef.current = content;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        const pending = pendingXmlRef.current;
        if (pending == null || pending === lastBaselineRef.current) return;
        pendingXmlRef.current = null;
        lastBaselineRef.current = pending;
        void writeXml(pending);
      }, CHANGE_DEBOUNCE_MS);
    },
    [writeXml],
  );

  const flushPending = useCallback((): Promise<"ok" | "conflict" | "error" | "idle"> => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const pending = pendingXmlRef.current;
    if (pending != null && pending !== lastBaselineRef.current) {
      pendingXmlRef.current = null;
      lastBaselineRef.current = pending;
      return writeXml(pending);
    }
    return Promise.resolve("idle");
  }, [writeXml]);

  // 卸载 flush:经 ref 转发,避免依赖变化触发 cleanup 误 flush。
  const flushPendingRef = useRef(flushPending);
  flushPendingRef.current = flushPending;
  useEffect(
    () => () => {
      void flushPendingRef.current();
    },
    [],
  );

  const postToFrame = useCallback((payload: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage(JSON.stringify(payload), window.location.origin);
  }, []);

  useEffect(() => {
    if (mode !== "edit") return;
    const handleMessage = (event: MessageEvent) => {
      // 只接受自家 iframe 的消息——拒绝一切杂散窗口。
      if (event.source !== frameRef.current?.contentWindow) return;
      if (event.origin !== window.location.origin) return;
      let msg: unknown;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : "");
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      const record = msg as Record<string, unknown>;
      if (record.event === "init") {
        setFrameReady(true);
        setFrameError(false);
        // xml 缺省 = 空白画布,drawio 会自行替换空图。
        postToFrame({ action: "load", xml: initialEditXml ?? undefined, autosave: 1 });
        return;
      }
      if (record.event === "save" && typeof record.xml === "string" && record.xml.length > 0) {
        latestXmlRef.current = record.xml;
        if (lastBaselineRef.current === null) {
          // 载入后首次 save:drawio 以自己的规范形式(常为压缩)重序列化,
          // 是基线而非编辑。
          lastBaselineRef.current = record.xml;
          return;
        }
        setDirty(true);
        publishChange(record.xml);
      }
      // 'exit' / 'openLink' / 'resize' 忽略——noExitBtn=1 隐藏退出入口。
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [mode, initialEditXml, postToFrame, publishChange]);

  // iframe 已加载但迟迟不发 init(资产损坏/协议失败):报错并可重试。
  useEffect(() => {
    if (mode !== "edit" || frameReady) return;
    const timer = setTimeout(() => setFrameError((prev) => (prev ? prev : !frameReady)), INIT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [mode, frameReady, frameNonce]);

  const enterEdit = useCallback(() => {
    if (!xml) return;
    readRequestRef.current += 1; // 使在途读失效
    setInitialEditXml(xml);
    lastBaselineRef.current = null;
    latestXmlRef.current = null;
    setFrameReady(false);
    setFrameError(false);
    setFrameNonce((n) => n + 1);
    setSaveConflict(false);
    setSaveError(null);
    setMode("edit");
  }, [xml]);

  const exitEdit = useCallback(() => {
    // 冲突 UI 显示中:必须先选覆盖或取消。防抖路径的 pendingXmlRef 已被清空,
    // 此时 flushPending() 返回 "idle",不拦住就会退出并丢弃 latestXmlRef 里的编辑。
    if (saveConflict) return;
    void flushPending().then((status) => {
      if (status === "conflict") return; // 冲突 UI 已显示,停在编辑态由用户决策
      setSaveConflict(false);
      setSaveError(null);
      setMode("view");
      setDirty(false);
      void loadFile();
    });
  }, [saveConflict, flushPending, loadFile]);

  const forceSave = useCallback(() => {
    const content = latestXmlRef.current;
    if (!content) {
      setSaveConflict(false);
      return;
    }
    void writeXml(content, { force: true });
  }, [writeXml]);

  const cancelConflict = useCallback(() => {
    setSaveConflict(false);
    setMode("view");
    setDirty(false);
    void loadFile();
  }, [loadFile]);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={HEADER_STYLE}>
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext || "drawio"}</span>
        {size != null && <span>{formatSize(size)}</span>}
        {mode === "view" ? (
          <button type="button" style={ICON_BUTTON_STYLE} disabled={!xml} onClick={enterEdit}>
            {t("i18n.editFile")}
          </button>
        ) : (
          <>
            {dirty && <span style={{ color: "#fbbf24" }}>{t("i18n.unsavedChanges")}</span>}
            <button type="button" style={ICON_BUTTON_STYLE} disabled={saving} onClick={exitEdit}>
              {saving ? t("i18n.saving") : t("i18n.doneEditing")}
            </button>
          </>
        )}
        <span
          title={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)" }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "#4ade80" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "live" : "static"}
        </span>
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {error ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              padding: 24,
              color: "#f87171",
              fontSize: 13,
            }}
          >
            <span>{error}</span>
            <button type="button" style={ICON_BUTTON_STYLE} onClick={() => onFallbackToText()}>
              {t("i18n.openAsText")}
            </button>
          </div>
        ) : mode === "edit" ? (
          frameError ? (
            <div
              style={{
                height: "100%",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                padding: 24,
                color: "#f87171",
                fontSize: 13,
              }}
            >
              <span>{t("i18n.drawioLoadFailed")}</span>
              <button
                type="button"
                style={ICON_BUTTON_STYLE}
                onClick={() => {
                  setFrameError(false);
                  setFrameReady(false);
                  lastBaselineRef.current = null;
                  setFrameNonce((n) => n + 1);
                }}
              >
                {t("i18n.refresh")}
              </button>
            </div>
          ) : (
            <>
              {!frameReady && <LoadingPlaceholder absolute />}
              <iframe
                key={frameNonce}
                ref={frameRef}
                title="drawio"
                src={frameUrl}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  border: "none",
                  background: "var(--bg-panel)",
                  visibility: frameReady ? "visible" : "hidden",
                }}
              />
            </>
          )
        ) : !xml ? (
          <LoadingPlaceholder />
        ) : (
          <DrawioStaticView xml={xml} reloadKey={reloadKey} onRenderError={() => setError(t("i18n.invalidDrawioFile"))} />
        )}
        {saveError && !error && !saveConflict && (
          <div
            style={{
              position: "absolute",
              top: 8,
              left: 16,
              right: 16,
              zIndex: 2,
              padding: "8px 12px",
              border: "1px solid rgba(248,113,113,0.45)",
              borderRadius: 6,
              background: "var(--bg-panel)",
              color: "#f87171",
              fontSize: 12,
              boxShadow: "0 2px 8px rgba(0,0,0,0.16)",
            }}
          >
            {saveError}
          </div>
        )}
        {/* 冲突 UI 是覆盖层:iframe 保持挂载,drawio 编辑器状态不被销毁,
            覆盖后无需重载(重载会用过期的 initialEditXml 回滚用户的覆盖)。 */}
        {saveConflict && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 3,
              background: "rgba(0,0,0,0.45)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              padding: 24,
              fontSize: 13,
              color: "var(--text)",
            }}
          >
            <span>{t("i18n.fileChangedOnDisk")}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" style={ICON_BUTTON_STYLE} onClick={forceSave}>
                {t("i18n.overwrite")}
              </button>
              <button type="button" style={ICON_BUTTON_STYLE} onClick={cancelConflict}>
                {t("i18n.cancel")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
