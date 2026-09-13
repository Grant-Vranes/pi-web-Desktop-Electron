// 通用分块读文件助手:驱动 /api/files read 接口的 truncated/nextOffset 协议,
// 并在读取过程中检测 size/mtime 变化自动重启。由 excalidraw-scene 的
// fetchSceneText 抽取而来,drawio 查看器复用同一实现。

export interface TextChunk {
  content?: string;
  truncated?: boolean;
  nextOffset?: number;
  size?: number;
  mtimeMs?: number;
  error?: string;
}

export interface TextWithMetadata {
  text: string;
  size: number;
  mtimeMs: number;
}

const MAX_READ_RESTARTS = 2;
const MAX_CHUNKS = 64;

function readChunkMetadata(chunk: TextChunk, subject: string): { size: number; mtimeMs: number } {
  if (typeof chunk.size !== "number" || typeof chunk.mtimeMs !== "number") {
    throw new Error(`Missing ${subject} read metadata`);
  }
  return { size: chunk.size, mtimeMs: chunk.mtimeMs };
}

export async function fetchTextWithMetadata(
  fetchImpl: (url: string) => Promise<{ json(): Promise<TextChunk> }>,
  urlForOffset: (offset?: number) => string,
  subject = "file",
): Promise<TextWithMetadata> {
  for (let restarts = 0; restarts <= MAX_READ_RESTARTS; restarts += 1) {
    let text = "";
    let offset: number | undefined;
    let chunkCount = 0;
    let expectedSize: number | null = null;
    let expectedMtimeMs: number | null = null;
    let restartRequired = false;

    while (true) {
      const chunk = await fetchImpl(urlForOffset(offset)).then((response) => response.json());
      if (chunk.error) throw new Error(chunk.error);
      const { size, mtimeMs } = readChunkMetadata(chunk, subject);

      if (expectedSize === null || expectedMtimeMs === null) {
        expectedSize = size;
        expectedMtimeMs = mtimeMs;
      } else if (size !== expectedSize || mtimeMs !== expectedMtimeMs) {
        restartRequired = true;
        break;
      }

      text += chunk.content ?? "";
      if (!chunk.truncated) return { text, size: expectedSize, mtimeMs: expectedMtimeMs };

      if (typeof chunk.nextOffset !== "number" || chunk.nextOffset <= (offset ?? 0)) {
        throw new Error(`Invalid ${subject} chunk offset`);
      }
      offset = chunk.nextOffset;

      chunkCount += 1;
      if (chunkCount > MAX_CHUNKS) throw new Error(`Too many ${subject} chunks`);
    }

    if (!restartRequired) break;
  }

  throw new Error(`${subject} changed while reading`);
}