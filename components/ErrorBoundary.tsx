"use client";

import { Component, default as React, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Short context label shown in the fallback, e.g. "chat" / "settings". */
  area?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Last-resort render guard. Without it a single throwing component unmounts
 * the whole React root and the window goes blank with no way back; the
 * fallback keeps the shell alive and offers a reload.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.area ? `:${this.props.area}` : ""}]`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const message = this.state.error.message || String(this.state.error);
    return (
      <div
        role="alert"
        style={{
          margin: 16,
          padding: 16,
          border: "1px solid color-mix(in srgb, #f87171 40%, var(--border))",
          borderRadius: 8,
          background: "color-mix(in srgb, #f87171 5%, var(--bg))",
          color: "var(--text)",
          fontSize: 13,
          lineHeight: 1.6,
          overflowWrap: "anywhere",
        }}
      >
        <div style={{ fontWeight: 650, marginBottom: 6 }}>
          {this.props.area ? `界面渲染出错（${this.props.area}）` : "界面渲染出错"}
        </div>
        <div style={{ color: "var(--text-muted)", marginBottom: 10 }}>{message}</div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            padding: "5px 12px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text)",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          重新加载
        </button>
      </div>
    );
  }
}
