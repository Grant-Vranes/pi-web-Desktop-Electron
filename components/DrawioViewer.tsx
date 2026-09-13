"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { getFileApiUrl } from "@/lib/file-api";
import { fetchTextWithMetadata } from "@/lib/chunked-file-read";
import { isValidDrawioXml } from "@/lib/drawio-file";

const DRAWIO_APP_BASE = "/drawio";

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
  const { t } = useI18n();

  const [xml, setXml] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [watching, setWatching] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const baseMtimeMsRef = useRef(0);
  const readRequestRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

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

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={HEADER_STYLE}>
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext || "drawio"}</span>
        {size != null && <span>{formatSize(size)}</span>}
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
        ) : !xml ? (
          <LoadingPlaceholder />
        ) : (
          <DrawioStaticView xml={xml} reloadKey={reloadKey} onRenderError={() => setError(t("i18n.invalidDrawioFile"))} />
        )}
      </div>
    </div>
  );
}
