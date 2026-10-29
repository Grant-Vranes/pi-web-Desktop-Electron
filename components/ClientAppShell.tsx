"use client";

import dynamic from "next/dynamic";
import { I18nProvider } from "@/hooks/useI18n";
import { ErrorBoundary } from "./ErrorBoundary";

const AppShellNoSsr = dynamic(
  () => import("./AppShell").then((mod) => mod.AppShell),
  { ssr: false },
);

export function ClientAppShell() {
  return (
    <I18nProvider>
      <ErrorBoundary area="app">
        <AppShellNoSsr />
      </ErrorBoundary>
    </I18nProvider>
  );
}
