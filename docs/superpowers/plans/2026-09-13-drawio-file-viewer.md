# .drawio File Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pi-web 文件浏览器支持 `.drawio` 文件的离线查看(viewer.min.js 只读渲染)与编辑(自托管 diagrams.net webapp iframe embed),缺资产/非法文件回退文本视图。

**Architecture:** 移植 horseMD 的接入方式:`scripts/fetch-drawio.mjs` 下载 pinned 版本的官方 `draw.war` 解压到 `public/drawio/`(gitignore,构建脚本自动补齐);Next.js 静态服务该目录,浏览器与 Electron 桌面端共用。新组件 `DrawioViewer` 查看模式注入 `js/viewer.min.js`(把所有默认指向 viewer.diagrams.net 的全局变量钉到本地路径实现零外网),编辑模式用 iframe `?embed=1&proto=json` postMessage 协议,防抖写回现有 `/api/files` write 接口。

**Tech Stack:** Next.js(现有)、node:test(现有)、extract-zip(新 devDependency,解压 war)、无运行时新依赖。

**Spec:** `docs/superpowers/specs/2026-09-13-drawio-file-viewer-design.md`

## Global Constraints

- 完全离线:运行时任何 drawio 资源(脚本、stencil、样式、翻译)不得指向外网;`viewer.min.js` 的默认网络路径全部用本地 `window.*` 变量覆盖。
- 仅 `.drawio` 扩展名;不处理 `.drawio.svg` / `.drawio.png`。
- 编辑采用自动保存(iframe `autosave:1` + 500ms 防抖写回),非手动保存按钮。
- 首次观察到的 iframe `save` 是基线,不是编辑(drawio 载入会重序列化 XML)。
- 全压缩 mxfile(无 `<` 字符)按无效处理 → 文本回退,不做 deflate 解压。
- 资产版本 pinned:`PINNED_VERSION = "31.4.5"`(与 horseMD 一致,已验证可用)。
- ⚠️ war 解压后约 **155MB**(不是之前估计的 20-30MB);`public` 在 package.json `files` 里,实测 npm pack 会包含 gitignored 的 `public/drawio`(npm 的 files 白名单优先于 .gitignore),npm 包与桌面安装包都会 +155MB。此为已确认接受的代价。
- 测试运行方式:`npm test`(node --experimental-strip-types --test),lib 测试用 `await import("./xxx.ts")` 直接加载 TS 源,组件测试用读源文件 + 正则断言(参考 `components/ExcalidrawViewer.test.mjs`)。
- 本机 npm 不在默认 PATH,测试前执行:`export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"`。
- 工作区有他人未提交改动(`lib/trash.*`、i18n locale 文件等),**严禁**提交或还原它们;提交时只 `git add` 本计划明确列出的文件,i18n 文件用精确 hunk 暂存。

---

### Task 1: drawio 文件校验助手

**Files:**
- Create: `lib/drawio-file.ts`
- Test: `lib/drawio-file.test.mjs`

**Interfaces:**
- Consumes: 无。
- Produces: `isValidDrawioXml(text: string): boolean`;`EMPTY_DRAWIO_XML: string`(空白模板常量,与 horseMD 对齐)。

- [ ] **Step 1: Write the failing test**

`lib/drawio-file.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./drawio-file.ts");
}

test("accepts mxfile and mxGraphModel XML roots", async () => {
  const { isValidDrawioXml } = await loadSubject();
  assert.equal(isValidDrawioXml('<mxfile host="pi-web"><diagram/></mxfile>'), true);
  assert.equal(isValidDrawioXml("<mxGraphModel><root/></mxGraphModel>"), true);
  assert.equal(isValidDrawioXml("  <MXFILE page='1'>"), true);
});

test("rejects empty, non-xml, and fully compressed bodies", async () => {
  const { isValidDrawioXml } = await loadSubject();
  assert.equal(isValidDrawioXml(""), false);
  assert.equal(isValidDrawioXml("not xml at all"), false);
  // deflate+base64 全压缩体:无 '<' 字符,有意拒绝
  assert.equal(isValidDrawioXml("jVNdb9owFP01vOfadAmJXVQJN9GFW7tJm5aSB4xr2A2MxE399U0"), false);
});

test("rejects non-string input", async () => {
  const { isValidDrawioXml } = await loadSubject();
  assert.equal(isValidDrawioXml(/** @type {any} */ (null)), false);
  assert.equal(isValidDrawioXml(/** @type {any} */ (undefined)), false);
});

test("exposes a valid blank-canvas template", async () => {
  const { EMPTY_DRAWIO_XML, isValidDrawioXml } = await loadSubject();
  assert.equal(isValidDrawioXml(EMPTY_DRAWIO_XML), true);
  assert.match(EMPTY_DRAWIO_XML, /<mxfile[\s>]/);
  assert.match(EMPTY_DRAWIO_XML, /<diagram[\s>]/);
  assert.match(EMPTY_DRAWIO_XML, /<mxGraphModel[\s>]/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test lib/drawio-file.test.mjs`

Expected: FAIL — `Cannot find module './drawio-file.ts'`。

- [ ] **Step 3: Write minimal implementation**

`lib/drawio-file.ts`:

```ts
// .drawio (mxfile XML) 文件助手:不解析 XML 语义——内容原样交给 drawio
// 引擎;这里只负责"有效 vs 损坏"判定,并提供空白画布模板。

export const EMPTY_DRAWIO_XML =
  '<mxfile host="pi-web" version="31.4.5">' +
  '<diagram id="page-1" name="Page-1">' +
  '<mxGraphModel dx="1422" dy="798" grid="1" gridSize="10" guides="1" tooltips="1" ' +
  'connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" ' +
  'math="0" shadow="0"><root><mxCell id="0" /><mxCell id="1" parent="0" /></root>' +
  '</mxGraphModel></diagram></mxfile>';

// 全压缩体(deflate+base64,完全无 '<')有意拒绝:drawio 首次保存时会自行
// 重序列化,对我们无法识别的内容走损坏回退(错误提示 + 以文本打开)更安全。
export function isValidDrawioXml(text: string): boolean {
  if (typeof text !== "string") return false;
  return /<mxfile[\s>]/i.test(text) || /<mxGraphModel[\s>]/i.test(text);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test lib/drawio-file.test.mjs`

Expected: PASS(4 tests)。

- [ ] **Step 5: Commit**

```bash
git add lib/drawio-file.ts lib/drawio-file.test.mjs
git commit -m "feat: drawio mxfile XML validation helpers"
```

---

### Task 2: 通用分块读文件助手(从 excalidraw-scene 提取)

**Files:**
- Create: `lib/chunked-file-read.ts`
- Modify: `lib/excalidraw-scene.ts`(fetchSceneText 改为委托)
- Test: `lib/chunked-file-read.test.mjs`(新建);`lib/excalidraw-scene.test.mjs`(现有,必须继续通过)

**Interfaces:**
- Consumes: `/api/files read` 的 chunk 响应结构 `{ content?, truncated?, nextOffset?, size?, mtimeMs?, error? }`。
- Produces: `fetchTextWithMetadata(fetchImpl, urlForOffset, subject?): Promise<{ text: string; size: number; mtimeMs: number }>`。Task 5 的 DrawioViewer 以 `subject="drawio file"` 调用。

- [ ] **Step 1: 查看现有实现与测试**

先读 `lib/excalidraw-scene.ts` 的 `fetchSceneText` 全文和 `lib/excalidraw-scene.test.mjs` 的全部断言。错误信息字符串为:
- `Missing Excalidraw scene read metadata`
- `Invalid Excalidraw scene chunk offset`
- `Too many Excalidraw scene chunks`
- `Excalidraw scene changed while reading`

它们必须能由 `subject="Excalidraw scene"` 经模板 `Missing ${subject} read metadata` 等精确再现,现有测试才不会破。

- [ ] **Step 2: Write the failing test**

`lib/chunked-file-read.test.mjs`(仿 `lib/excalidraw-scene.test.mjs` 的 fakeResponse 模式):

```js
import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./chunked-file-read.ts");
}

function fakeResponse(chunk) {
  return { async json() { return chunk; } };
}

test("concatenates multi-chunk content and returns read metadata", async () => {
  const { fetchTextWithMetadata } = await loadSubject();
  const calls = [];
  const chunks = [
    { content: "hello ", nextOffset: 6, truncated: true, size: 12, mtimeMs: 100 },
    { content: "world", truncated: false, size: 12, mtimeMs: 100 },
  ];
  const result = await fetchTextWithMetadata(
    (url) => { calls.push(url); return Promise.resolve(fakeResponse(chunks[calls.length - 1])); },
    (offset) => `/api/files/x?offset=${offset ?? 0}`,
    "drawio file",
  );
  assert.equal(result.text, "hello world");
  assert.equal(result.size, 12);
  assert.equal(result.mtimeMs, 100);
  assert.equal(calls.length, 2);
});

test("error messages use the provided subject", async () => {
  const { fetchTextWithMetadata } = await loadSubject();
  await assert.rejects(
    fetchTextWithMetadata(
      () => Promise.resolve(fakeResponse({ mtimeMs: 1 })), // 缺 size → Missing ... read metadata
      () => "/api/files/x",
      "drawio file",
    ),
    (error) => error.message === "Missing drawio file read metadata",
  );
});

test("restarts when file mutates between chunks", async () => {
  const { fetchTextWithMetadata } = await loadSubject();
  let call = 0;
  const responses = [
    { content: "a", nextOffset: 1, truncated: true, size: 2, mtimeMs: 100 },
    { content: "b", truncated: true, size: 3, mtimeMs: 200 }, // mtime 变化 → 重来
    { content: "xy", nextOffset: 2, truncated: true, size: 3, mtimeMs: 200 },
    { content: "z", truncated: false, size: 3, mtimeMs: 200 },
  ];
  const result = await fetchTextWithMetadata(
    () => Promise.resolve(fakeResponse(responses[call++])),
    (offset) => `/api/files/x?offset=${offset ?? 0}`,
    "drawio file",
  );
  assert.equal(result.text, "xyz");
  assert.equal(result.mtimeMs, 200);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --experimental-strip-types --test lib/chunked-file-read.test.mjs`

Expected: FAIL — `Cannot find module './chunked-file-read.ts'`。

- [ ] **Step 4: 实现(把 excalidraw-scene.ts 的循环逻辑原样迁移并参数化 subject)**

`lib/chunked-file-read.ts`:

```ts
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
```

- [ ] **Step 5: excalidraw-scene.ts 委托**

`lib/excalidraw-scene.ts` 中删除原 `fetchSceneText` 函数体及其私有辅助(`readChunkMetadata`、`MAX_SCENE_RESTARTS`/`MAX_SCENE_CHUNKS` 若无他用),保留类型定义,替换为:

```ts
export async function fetchSceneText(
  fetchImpl: (url: string) => Promise<SceneReadResponse>,
  urlForOffset: (offset?: number) => string,
): Promise<SceneText> {
  return fetchTextWithMetadata(
    fetchImpl as unknown as (url: string) => Promise<{ json(): Promise<TextChunk> }>,
    urlForOffset,
    "Excalidraw scene",
  ) as Promise<SceneText>;
}
```

顶部加 `import { fetchTextWithMetadata, type TextChunk } from "./chunked-file-read";`。若类型签名不吻合,允许在委托处做最小适配(但**不得**改动 chunked-file-read 的行为);以 `node --experimental-strip-types --test lib/excalidraw-scene.test.mjs` 全绿为准。

- [ ] **Step 6: Run all affected tests**

Run: `node --experimental-strip-types --test lib/chunked-file-read.test.mjs lib/excalidraw-scene.test.mjs`

Expected: 全部 PASS。

- [ ] **Step 7: Commit**

```bash
git add lib/chunked-file-read.ts lib/chunked-file-read.test.mjs lib/excalidraw-scene.ts
git commit -m "refactor: extract generic chunked file reader from excalidraw scene loader"
```

---

### Task 3: drawio 资产 fetch 脚本与构建接线

**Files:**
- Create: `scripts/fetch-drawio.mjs`
- Modify: `package.json`(scripts + devDependencies)
- Modify: `.gitignore`(追加 `/public/drawio/`)

**Interfaces:**
- Consumes: `https://github.com/jgraph/drawio/releases/download/v31.4.5/draw.war`。
- Produces: `public/drawio/{index.html, js/app.min.js, js/viewer.min.js, DRAWIO_VERSION, stencils/, styles/, shapes/, img/, images/, mxgraph/, resources/, math4/}`。Task 5 依赖 `js/viewer.min.js` 与 `DRAWIO_VERSION`。

- [ ] **Step 1: 安装 extract-zip**

Run: `npm install --save-dev extract-zip`

Expected: package.json devDependencies 出现 `"extract-zip"`。

- [ ] **Step 2: 写脚本**

`scripts/fetch-drawio.mjs`:

```js
#!/usr/bin/env node
// Downloads the pinned diagrams.net webapp (draw.war) and unpacks it into
// public/drawio/ for the offline drawio viewer/editor. public/drawio is
// gitignored — build/dev scripts run this automatically. The version is
// pinned deliberately; upgrading drawio is an explicit human action
// (change PINNED_VERSION, re-run).
// --soft: dev-time best effort — warn and exit 0 on failure so `npm run dev`
// never blocks; the viewer falls back to the text view at runtime.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import extract from "extract-zip";

const PINNED_VERSION = "31.4.5";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "public", "drawio");
const versionFile = join(target, "DRAWIO_VERSION");
const soft = process.argv.includes("--soft");

function fail(message) {
  if (soft) {
    console.warn(`[fetch-drawio] ${message}`);
    console.warn("[fetch-drawio] continuing without drawio assets; .drawio files will open as text.");
    process.exit(0);
  }
  console.error(`[fetch-drawio] ${message}`);
  process.exit(1);
}

if (existsSync(versionFile) && readFileSync(versionFile, "utf8").trim() === PINNED_VERSION) {
  console.log(`drawio v${PINNED_VERSION} already vendored at ${target}`);
  process.exit(0);
}

const url = `https://github.com/jgraph/drawio/releases/download/v${PINNED_VERSION}/draw.war`;
const warPath = join(root, "public", `draw-${PINNED_VERSION}.war`);
mkdirSync(join(root, "public"), { recursive: true });

console.log(`Downloading ${url} ...`);
let res;
try {
  res = await fetch(url, { redirect: "follow" });
} catch (error) {
  fail(`Download failed: ${error}`);
}
if (!res.ok) fail(`Download failed: HTTP ${res.status} ${res.statusText}`);
const buf = Buffer.from(await res.arrayBuffer());
if (buf.length < 1024 * 1024) fail(`Downloaded file is suspiciously small (${buf.length} bytes) — aborting`);
writeFileSync(warPath, buf);

console.log(`Unpacking into ${target} ...`);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
try {
  await extract(warPath, { dir: target });
} catch (error) {
  fail(`Unpack failed: ${error}`);
}
rmSync(warPath, { force: true });

// Sanity checks: files the viewer and editor actually load must exist.
for (const required of ["index.html", join("js", "app.min.js"), join("js", "viewer.min.js")]) {
  if (!existsSync(join(target, required))) {
    fail(`Vendored webapp is missing ${required} — the war layout may have changed`);
  }
}
writeFileSync(versionFile, `${PINNED_VERSION}\n`);
console.log(`drawio v${PINNED_VERSION} vendored OK`);
```

- [ ] **Step 3: package.json 接线**

`scripts` 修改(dev best-effort、build 强制),另外加一条便捷命令:

```json
"dev": "node scripts/fetch-drawio.mjs --soft && node bin/start-dev.js --hostname 127.0.0.1",
"dev:lan": "node scripts/fetch-drawio.mjs --soft && node bin/start-dev.js --hostname 0.0.0.0",
"build": "node scripts/fetch-drawio.mjs && next build --webpack",
"fetch-drawio": "node scripts/fetch-drawio.mjs",
```

`desktop:dist`、`release`、`start` 不改(它们经过 `build`,或运行时零网络)。

- [ ] **Step 4: .gitignore 追加**

在 `.gitignore` 末尾追加(先确认文件末尾有换行,避免出现 `src-tauri/target//public/drawio/` 式拼接):

```bash
tail -c 1 .gitignore | od -c | head -1   # 若末尾无 \n,先 printf '\n' >> .gitignore
printf '/public/drawio/\n' >> .gitignore
```

- [ ] **Step 5: 运行脚本验证(需网络,一次性)**

Run: `node scripts/fetch-drawio.mjs`

Expected: 输出 `drawio v31.4.5 vendored OK`;`ls public/drawio/index.html public/drawio/js/viewer.min.js public/drawio/DRAWIO_VERSION` 全部存在;`du -sm public/drawio` 约 155MB。

再次运行:`node scripts/fetch-drawio.mjs`

Expected: 输出 `drawio v31.4.5 already vendored at ...`(幂等,秒退)。

- [ ] **Step 6: Commit**

```bash
git add scripts/fetch-drawio.mjs package.json package-lock.json .gitignore
git commit -m "feat: vendor offline drawio webapp via pinned fetch script"
```

---

### Task 4: 文件类型接线(file-types / FileViewer / FileIcons)

**Files:**
- Modify: `lib/file-types.ts`(在 `isExcalidrawPath` 附近新增)
- Modify: `components/FileViewer.tsx`(dynamic import + 分发分支)
- Modify: `components/FileIcons.tsx`(图标)
- Create: `components/DrawioViewer.tsx`(最小占位,避免中间态指向不存在模块)
- Test: `lib/file-types.test.mjs`(追加用例;若无该文件则新建)、`components/FileViewer.test.mjs`(追加断言)

**Interfaces:**
- Consumes: `getFileExt(filePath)`(`lib/file-types.ts`,已存在)。
- Produces: `isDrawioPath(filePath: string): boolean`;`FileViewer` 中 `isDrawioPath(filePath) && !textFallback` 分支渲染 `<DrawioViewer filePath cwd sourceSessionId watchEnabled onFallbackToText>`。Task 5 替换占位组件。

- [ ] **Step 1: Write the failing test**

`lib/file-types.test.mjs` 追加(没有该文件就新建,头部照现有 lib 测试 `import assert from "node:assert/strict"; import test from "node:test";`):

```js
test("isDrawioPath matches only the drawio extension", async () => {
  const { isDrawioPath } = await import("./file-types.ts");
  assert.equal(isDrawioPath("/a/b/diagram.drawio"), true);
  assert.equal(isDrawioPath("C:\\a\\DIAGRAM.DRAWIO"), true);
  assert.equal(isDrawioPath("/a/b/diagram.drawio.svg"), false);
  assert.equal(isDrawioPath("/a/b/diagram.png"), false);
  assert.equal(isDrawioPath("/a/b.drawio/notes.txt"), false);
});
```

`components/FileViewer.test.mjs` 追加(先读现有文件确认读源变量名——`ExcalidrawViewer.test.mjs` 里是 `fileViewerSource`,若 `FileViewer.test.mjs` 用别的名字,沿用它的名字):

```js
test("dispatches .drawio files to DrawioViewer before the text fallback", () => {
  assert.match(fileViewerSource, /isDrawioPath/);
  assert.match(fileViewerSource, /const DrawioViewer = dynamic\(\(\) => import\("\.\/DrawioViewer"\), \{\s*ssr: false/s);
  assert.match(fileViewerSource, /isDrawioPath\(filePath\) && !textFallback/);
  assert.match(fileViewerSource, /<DrawioViewer[\s\S]*?onFallbackToText=\{\(\) => setTextFallback\(true\)\}\s*\/>/s);
  // excalidraw 分支不受影响
  assert.match(fileViewerSource, /isExcalidrawPath\(filePath\) && !textFallback/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test lib/file-types.test.mjs components/FileViewer.test.mjs`

Expected: FAIL。

- [ ] **Step 3: 实现**

`lib/file-types.ts`(`isExcalidrawPath` 后面):

```ts
export function isDrawioPath(filePath: string): boolean {
  return getFileExt(filePath) === "drawio";
}
```

`components/FileIcons.tsx`(仿 `ExcalidrawIcon`,新增):

```tsx
function DrawioIcon({ size = 14 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <path d="M10 6.5h4a3 3 0 0 1 3 3V14" />
      <path d="m14.5 11.5 2.5 2.5 2.5-2.5" />
    </svg>
  );
}
```

`getFileIcon` 中 `if (ext === "excalidraw")` 行后加:

```ts
  if (ext === "drawio") return <DrawioIcon size={size} />;
```

`components/FileViewer.tsx`:
1. 顶部 `isExcalidrawPath` 的 import 块加 `isDrawioPath,`。
2. `const ExcalidrawViewer = dynamic(...)` 旁加:

```tsx
const DrawioViewer = dynamic(() => import("./DrawioViewer"), {
  ssr: false,
  loading: () => <FileViewerLoadingPlaceholder />,
});
```

3. `isExcalidrawPath` 分支之前加:

```tsx
  if (isDrawioPath(filePath) && !textFallback) {
    return (
      <DrawioViewer
        filePath={filePath}
        cwd={cwd}
        sourceSessionId={sourceSessionId}
        watchEnabled={watchEnabled}
        onFallbackToText={() => setTextFallback(true)}
      />
    );
  }
```

`components/DrawioViewer.tsx` 占位:

```tsx
"use client";

// 占位实现(Task 5 替换):避免中间提交出现指向不存在模块的 dynamic import。
export default function DrawioViewer() {
  return null;
}
```

- [ ] **Step 4: Run tests**

Run: `node --experimental-strip-types --test lib/file-types.test.mjs components/FileViewer.test.mjs`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/file-types.ts components/FileViewer.tsx components/FileIcons.tsx components/DrawioViewer.tsx lib/file-types.test.mjs components/FileViewer.test.mjs
git commit -m "feat: route .drawio files to a (placeholder) drawio viewer"
```

### Task 5: DrawioViewer 查看模式(加载/校验/watch/只读渲染)

**Files:**
- Modify: `components/DrawioViewer.tsx`(替换占位,本任务不含编辑模式)
- Modify: `lib/i18n/messages/en.ts`、`lib/i18n/messages/zh-CN.ts`、`lib/i18n/messages/zh-TW.ts`(新词条)
- Test: `components/DrawioViewer.test.mjs`(新建)

**Interfaces:**
- Consumes: `fetchTextWithMetadata`(Task 2)、`isValidDrawioXml`(Task 1)、`getFileApiUrl`(`lib/file-api.ts`)、`useI18n`(`locale`, `t`)、`getRelativeFilePath`/`getFileName`(`lib/file-paths.ts`)、`/api/files` 的 read/watch/download 接口。
- Produces: `DrawioViewer` 默认导出,props `{ filePath: string; cwd?: string; sourceSessionId?: string | null; watchEnabled?: boolean; onFallbackToText: () => void }`。Task 6 在同文件内追加编辑模式。

- [ ] **Step 1: 新增 i18n 词条**

⚠️ i18n 文件有他人未提交改动:只允许插入本任务的两行,提交时用 `git add -p` 精确暂存(或推迟到工作区干净后再提交,并在任务记录里注明)。

`lib/i18n/messages/en.ts`(紧跟 `"i18n.invalidExcalidrawScene"` 行后):

```ts
    "i18n.invalidDrawioFile": "This file is not a valid drawio diagram.",
    "i18n.drawioLoadFailed": "The drawio editor assets are not installed. Run: npm run fetch-drawio",
```

`lib/i18n/messages/zh-CN.ts` 同位置:

```ts
    "i18n.invalidDrawioFile": "该文件不是有效的 drawio 图表。",
    "i18n.drawioLoadFailed": "drawio 编辑器资源未安装。请运行:npm run fetch-drawio",
```

`lib/i18n/messages/zh-TW.ts` 同位置:

```ts
    "i18n.invalidDrawioFile": "該檔案不是有效的 drawio 圖表。",
    "i18n.drawioLoadFailed": "drawio 編輯器資源未安裝。請執行:npm run fetch-drawio",
```

- [ ] **Step 2: Write the failing test**

`components/DrawioViewer.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./DrawioViewer.tsx", import.meta.url), "utf8");

test("pins every drawio asset base to the vendored copy — no network defaults", () => {
  assert.doesNotMatch(source, /viewer\.diagrams\.net/);
  for (const key of ["STYLE_PATH", "SHAPES_PATH", "STENCIL_PATH", "GRAPH_IMAGE_PATH", "mxImageBasePath", "mxBasePath", "RESOURCE_BASE", "DRAW_MATH_URL"]) {
    assert.match(source, new RegExp(`${key}: \`\\$\{DRAWIO_APP_BASE\}`), `missing local override for ${key}`);
  }
});

test("checks vendored assets before rendering and falls back on failure", () => {
  assert.match(source, /DRAWIO_VERSION/);
  assert.match(source, /onFallbackToText\(\)/);
});

test("view mode constructs a read-only GraphViewer from the file XML", () => {
  assert.match(source, /GraphViewer\? GraphViewerCtor/); // 取到全局构造器
  assert.match(source, /new ctor\(host, parsed/);
  assert.match(source, /new DOMParser\(\)\.parseFromString\(xml, "text\/xml"\)/);
  assert.doesNotMatch(source, /edit:\s*["'_]/); // 查看模式不提供编辑入口
});

test("reads the file through the shared chunked reader with the drawio subject", () => {
  assert.match(source, /fetchTextWithMetadata\(/);
  assert.match(source, /"drawio file"/);
  assert.match(source, /isValidDrawioXml\(/);
});

test("external file changes reload only outside edit mode", () => {
  assert.match(source, /modeRef\.current === "view"[\s\S]*?void loadFile\(\)/s);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --experimental-strip-types --test components/DrawioViewer.test.mjs`

Expected: FAIL(占位组件不匹配任何断言)。

- [ ] **Step 4: 实现查看模式**

完整替换 `components/DrawioViewer.tsx`(编辑模式的状态/逻辑留待 Task 6,此处刻意不出现):

```tsx
"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { getFileApiUrl } from "@/lib/file-api";
import { fetchTextWithMetadata } from "@/lib/chunked-file-read";
import { isValidDrawioXml } from "@/lib/drawio-file";

const DRAWIO_APP_BASE = "/drawio";

// viewer.min.js 把所有资源根默认指向 https://viewer.diagrams.net/...;
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

interface Props {
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

export default function DrawioViewer({ filePath, cwd, sourceSessionId, watchEnabled = true, onFallbackToText }: Props) {
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
    const response = await fetch(`${DRAWIO_APP_BASE}/DRAWIO_VERSION`);
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
          <DrawioStaticView xml={xml} reloadKey={reloadKey} onRenderError={() => setError(t("i18n.drawioLoadFailed"))} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run tests + 全量测试**

Run: `node --experimental-strip-types --test components/DrawioViewer.test.mjs && npm test 2>&1 | tail -20`

Expected: DrawioViewer tests PASS;全量无新增失败(注意 locale 一致性测试)。

- [ ] **Step 6: Commit(注意 i18n 文件的 hunk 隔离)**

```bash
git add components/DrawioViewer.tsx components/DrawioViewer.test.mjs
# i18n:仅暂存本任务插入的两行 hunk(文件含他人改动)
git add -p lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts lib/i18n/messages/zh-TW.ts
git commit -m "feat: offline drawio view mode via vendored viewer.min.js"
```

---

### Task 6: DrawioViewer 编辑模式(iframe embed 协议 + 自动保存/冲突)

**Files:**
- Modify: `components/DrawioViewer.tsx`(追加编辑模式)
- Test: `components/DrawioViewer.test.mjs`(追加断言)

**Interfaces:**
- Consumes: Task 5 的组件骨架、`getFileApiUrl(..., "write", ...)`(body `{ content, baseMtimeMs }` → 200 `{ mtimeMs, size }` / 409 冲突)、drawio embed postMessage 协议(`init` → `load` → `save`)、`useI18n` 的 `locale`。
- Produces: 完整 DrawioViewer:头部"编辑/退出编辑"按钮、同源编辑 iframe、500ms 防抖自动保存、409 冲突 UI(覆盖/取消)、退出与卸载 flush。

- [ ] **Step 1: Write the failing test**

`components/DrawioViewer.test.mjs` 追加:

```js
test("edit mode validates iframe messages by source and same origin", () => {
  assert.match(source, /event\.source !== frameRef\.current\?\.contentWindow/);
  assert.match(source, /event\.origin !== window\.location\.origin/);
  assert.match(source, /action: "load", xml: initialEditXml \?\? undefined, autosave: 1/);
});

test("first observed save is a baseline, not an edit", () => {
  assert.match(source, /if \(lastBaselineRef\.current === null\) \{[\s\S]*?lastBaselineRef\.current = record\.xml;/s);
});

test("saves are debounced and flushed on exit and unmount", () => {
  assert.match(source, /CHANGE_DEBOUNCE_MS = 500/);
  assert.match(source, /const exitEdit = useCallback[\s\S]*?flushPending\(\)/s);
  assert.match(source, /useEffect\(\(\) => \(\) => \{[\s\S]*?flushPendingRef\.current\(\)/s);
});

test("write sends baseMtimeMs and handles 409 conflicts with force overwrite", () => {
  assert.match(source, /baseMtimeMs:\s*options\.force\s*\?\s*null\s*:\s*baseMtimeMsRef\.current/);
  assert.match(source, /response\.status === 409/);
  assert.match(source, /setSaveConflict\(true\)/);
  assert.match(source, /writeXml\(content, \{ force: true \}\)/);
});

test("edit iframe is same-origin with embed protocol params", () => {
  assert.match(source, /embed: "1",\s*proto: "json",\s*ui: "kennedy",\s*noExitBtn: "1",\s*spin: "1"/s);
  assert.match(source, /DRAWIO_APP_BASE\)\/index\.html/);
});

test("entering edit mode invalidates in-flight reads and resets baselines", () => {
  assert.match(source, /const enterEdit = useCallback[\s\S]*?readRequestRef\.current \+= 1;/s);
  assert.match(source, /lastBaselineRef\.current = null;/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test components/DrawioViewer.test.mjs`

Expected: 新增用例 FAIL。

- [ ] **Step 3: 实现编辑模式**

在 Task 5 版本上追加/修改:

1. 常量区加(查看模式未用到的超时常量在此补入):

```tsx
const CHANGE_DEBOUNCE_MS = 500;
const INIT_TIMEOUT_MS = 30000;
```

2. 类型区加:

```tsx
type WriteResponse = { mtimeMs?: number; size?: number; error?: string };
```

3. state 区加:

```tsx
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveConflict, setSaveConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [initialEditXml, setInitialEditXml] = useState<string | null>(null);
  const [frameReady, setFrameReady] = useState(false);
  const [frameError, setFrameError] = useState(false);
  const [frameNonce, setFrameNonce] = useState(0);
```

4. refs 区加:

```tsx
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const latestXmlRef = useRef<string | null>(null);
  const lastBaselineRef = useRef<string | null>(null);
  const pendingXmlRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
```

5. `useI18n()` 解构改为 `const { t, locale } = useI18n();`,并加 drawio 语言映射 + iframe URL:

```tsx
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
```

(import 区补 `useMemo`。)

6. 写回(返回状态供 exitEdit 决策):

```tsx
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
```

7. 防抖与 flush:

```tsx
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
```

8. `postToFrame` + 协议消息处理:

```tsx
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
```

9. 进入/退出编辑 + 冲突操作:

```tsx
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
    void flushPending().then((status) => {
      if (status === "conflict") return; // 冲突 UI 已显示,停在编辑态由用户决策
      setSaveConflict(false);
      setSaveError(null);
      setMode("view");
      setDirty(false);
      void loadFile();
    });
  }, [flushPending, loadFile]);

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
```

10. 头部按钮(HEADER 内 DownloadLink 之前):

```tsx
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
```

11. body 渲染整体改为(Task 5 的三元链扩展为四分支):

```tsx
        {error ? (
          /* Task 5 的 error 块原样保留 */
        ) : saveConflict ? (
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              padding: 24,
              fontSize: 13,
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
          <DrawioStaticView xml={xml} reloadKey={reloadKey} onRenderError={() => setError(t("i18n.drawioLoadFailed"))} />
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
```

- [ ] **Step 4: Run tests**

Run: `node --experimental-strip-types --test components/DrawioViewer.test.mjs`

Expected: PASS(含 Task 5 用例)。

- [ ] **Step 5: lint**

Run: `npm run lint`

Expected: 无新增 error。

- [ ] **Step 6: Commit**

```bash
git add components/DrawioViewer.tsx components/DrawioViewer.test.mjs
git commit -m "feat: drawio edit mode via self-hosted embed iframe with autosave"
```

---

### Task 7: 端到端验证 + 打包验证 + 文档

**Files:**
- Modify: `AGENTS.md`(File Map 加一行 DrawioViewer;不动其他内容)

**Interfaces:**
- Consumes: 前序全部任务。
- Produces: 验证通过的完整功能。

- [ ] **Step 1: 全量测试 + lint**

Run: `npm test 2>&1 | tail -5 && npm run lint`

Expected: 全绿。若有 locale 一致性失败,补齐三份 locale 的 key 后重跑。

- [ ] **Step 2: 构建验证(需要 Task 3 资产已就位)**

Run: `npm run build 2>&1 | tail -10`

Expected: build 成功(fetch-drawio 先执行,资产已 vendored 时秒过)。

- [ ] **Step 3: npm pack 包含性验证(spec 风险项,已预验)**

Run: `npm pack --dry-run 2>&1 | grep -c "public/drawio"`

Expected: 大于 0(files 白名单优先于 .gitignore,已实测)。若为 0,在 package.json `files` 数组追加 `"public/drawio"` 重试;仍为 0 则创建根级 `.npmignore`(不含 `/public/drawio/`,但镜像 `.gitignore` 其余条目)并对比 `npm pack --dry-run` 前后的文件清单确认无回归。

- [ ] **Step 4: 手动端到端(dev server,需网络已就绪的资产)**

准备测试文件(内容 = `EMPTY_DRAWIO_XML`):

```bash
node --experimental-strip-types -e 'import("./lib/drawio-file.ts").then(m => require("fs").writeFileSync("/tmp/test.drawio", m.EMPTY_DRAWIO_XML))' 2>/dev/null || cat > /tmp/test.drawio <<'XML'
<mxfile host="pi-web" version="31.4.5"><diagram id="page-1" name="Page-1"><mxGraphModel dx="1422" dy="798" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0"><root><mxCell id="0" /><mxCell id="1" parent="0" /></root></mxGraphModel></diagram></mxfile>
XML
```

Run: `npm run dev`,浏览器打开,把 `/tmp/test.drawio` 拖入会话打开文件 tab。

验证清单:
1. 只读渲染空白画布(白底网格),无编辑工具栏;DevTools Network 无任何指向 viewer.diagrams.net 的请求(离线约束)。
2. 编辑模式:点"编辑" → iframe 出现完整 drawio 编辑器(kennedy UI,语言跟随界面语言)。
3. 拖一个形状到画布 → 约 0.5s 后自动写盘:用外部编辑器打开该文件确认 XML 已更新且仍是合法 `<mxfile`。
4. "退出编辑" → 回到只读视图,内容与刚才编辑一致。
5. live watch:编辑态下用外部编辑器改文件 → 不 clobber 画布;退出编辑后视图显示外部新内容。
6. 冲突:编辑态下外部改文件,立即在画布做修改触发写盘 → 409 冲突 UI;点"覆盖"写盘成功,点"取消"回到只读并显示外部内容。
7. 回退:临时把 `public/drawio` 改名 → 重新打开 .drawio → 错误态显示 `i18n.drawioLoadFailed` + "以文本打开";点它落到文本视图。改回目录名。

- [ ] **Step 5: 文档**

`AGENTS.md` 的 components File Map 区(`ExcalidrawViewer.tsx` 行附近)加:

```
  DrawioViewer.tsx    .drawio 图查看(viewer.min.js 只读)+ 编辑(自托管 embed iframe)
```

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md
git commit -m "docs: note drawio viewer in file map"
```
