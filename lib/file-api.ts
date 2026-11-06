import { encodeFilePathForApi } from "./file-paths";
import { pageId } from "./page-debug";

export type FileApiRequestType = "read" | "download" | "meta" | "preview" | "watch" | "write";

export function getFileApiUrl(
  filePath: string,
  type: FileApiRequestType,
  sourceSessionId?: string | null,
  params: Record<string, string | number | undefined> = {},
): string {
  const encoded = encodeFilePathForApi(filePath);
  const searchParams = new URLSearchParams({ type });
  if (sourceSessionId) searchParams.set("sessionId", sourceSessionId);
  // A watch is a stream: the page that holds it, for the Debug panel's connected pages.
  if (type === "watch") searchParams.set("holder", pageId());
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }
  return `/api/files/${encoded}?${searchParams.toString()}`;
}
