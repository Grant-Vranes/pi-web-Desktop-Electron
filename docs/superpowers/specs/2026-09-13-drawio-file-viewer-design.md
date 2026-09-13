# .drawio 文件查看与编辑 — 设计文档

日期:2026-09-13
状态:已确认

## 目标

pi-web 文件浏览器支持 `.drawio` 文件(draw.io/diagrams.net mxfile XML)的查看与编辑:

- **查看模式**:只读渲染图(无编辑 UI),支持明暗主题。
- **编辑模式**:完整 drawio 编辑器,内容自动写回原文件。
- **完全离线**:drawio 静态应用自托管,运行时零外网请求(浏览器与 Electron 桌面端一致)。
- **优雅降级**:资产缺失或文件非法时回退到现有文本查看器。

方案与接入方式参考 horseMD 工程(`/Users/akio/Akio/horseMD`)的成熟实现:
pinned fetch 脚本 + 本地静态 webapp + iframe embed postMessage 协议。

用户已确认:

- 编辑支持(方案 B,非只读)。
- 引擎:自托管官方 webapp,不联网(参考 jgraph/drawio)。
- 文件类型:仅 `.drawio`(含未压缩与 deflate 压缩 mxfile XML)。
- 资产策略:参考 horseMD 的 fetch 脚本方案(非提交进仓库)。

## 资产层

### `scripts/fetch-drawio.mjs`

移植 horseMD `scripts/fetch-drawio.mjs`,差异为解压目标改为 `public/drawio/`:

- 下载固定版本(pinned,如 `v31.4.5`)的官方 `draw.war`:
  `https://github.com/jgraph/drawio/releases/download/v<VER>/draw.war`
- 解压到 `public/drawio/`,写入 `public/drawio/DRAWIO_VERSION`。
- 已存在且版本一致则直接跳过(幂等);下载体积过小(< 1MB)时中止。
- 完整性检查:`index.html`、`js/app.min.js`、`js/viewer.min.js` 必须存在,否则失败退出。

### 接线与 gitignore

- `public/drawio/` 加入 `.gitignore`。
- `build` / `desktop:dist` / `release` 脚本在构建前执行 fetch(打包必须成功,失败即中断)。
- `dev` 脚本 best-effort 执行:失败不阻塞 dev,运行时组件回退文本视图。
- ⚠️ 实现时验证 `npm pack`(release)不会因 `.gitignore` 排除 `public/drawio`;
  必要时通过 `files` 字段/`.npmignore` 反转规则处理。

### 服务方式

- Next.js 静态服务 `public/drawio/**`,iframe 指向 `/drawio/index.html`。
- 浏览器与桌面端(Electron 内置 Next server)共用同一 URL,iframe 与宿主同源,
  postMessage origin 校验用 `location.origin`(horseMD 用自定义协议
  `drawio-local://`,此处不需要)。

## 类型判断

- `lib/file-types.ts` 新增 `isDrawioPath(filePath)`(扩展名为 `drawio`)。
- `FileViewer` 分发:`isExcalidrawPath` 之前或之后新增
  `isDrawioPath(filePath) && !textFallback` 分支 → `DrawioViewer`。
- `FileIcons.tsx` 新增 drawio 扩展名图标。

## 文件校验(`lib/drawio-file.ts`)

移植 horseMD `src/renderer/src/lib/drawio-file.js` 规则:

- `isValidDrawioXml(text)`:包含 `<mxfile` 或 `<mxGraphModel` 开头标记即有效。
  全压缩体(deflate+base64、无 `<`)有意拒绝 → 走损坏回退,避免误判。
- 不解析 XML 语义,XML 原样传给 drawio 引擎。

## 新组件 `components/DrawioViewer.tsx`

通过 `next/dynamic` 懒加载(同 `ExcalidrawViewer`),props 一致:

`filePath / cwd / sourceSessionId / watchEnabled / onFallbackToText`

### 头部

复用 ExcalidrawViewer 头部模式:相对路径、扩展名、文件大小、live/static
监听指示灯、下载按钮;查看模式显示"编辑",编辑模式显示"退出编辑"。

### 查看模式(viewer.min.js)

- 不用 iframe:动态注入 `public/drawio/js/viewer.min.js`(官方只读渲染器,
  viewer.diagrams.net 同款),渲染只读图。真正的只读 —— drawio embed iframe
  无法锁定为只读。
- 主题:`useTheme` 明暗切换(重渲染)。
- 加载失败(脚本缺失/渲染异常)→ 回退文本视图。

### 编辑模式(iframe embed 协议)

移植 horseMD `DrawioEditor.jsx` 的协议与状态机:

- iframe URL:`/drawio/index.html?embed=1&proto=json&ui=min&noExitBtn=1&...`
  (语言参数跟随应用 i18n)。
- JSON postMessage 协议:
  - iframe → 宿主:`{event: 'init'}` 就绪
  - 宿主 → iframe:`{action: 'load', xml, autosave: 1}`
  - iframe → 宿主:`{event: 'save', xml}` 内容变化
- origin + `event.source` 双重校验,只接受自家 iframe 的消息。
- **基线规则**:载入后首次 `save` 是基线(drawio 载入会重序列化 XML),
  不视为编辑。
- 500ms 防抖后写回;退出编辑、切换文件、组件卸载前同步 flush 未落盘内容。

### 保存与冲突

- 复用现有 `/api/files` write 接口:`{ content, baseMtimeMs }`,
  409 → 冲突 UI(覆盖 `force` / 取消),同 ExcalidrawViewer。
- 保存成功以响应 `mtimeMs` 更新基线。

### 文件监听

- 同 ExcalidrawViewer:查看模式外部变更 → 重新加载;
  编辑模式仅刷新大小显示,避免 clobber 画布,落盘时以 409 兜底。
- 指示灯 live/static 逻辑一致。

### 错误处理

- 文件读取/解析失败、XML 非法 → 错误态 + "以文本打开"按钮(`onFallbackToText`)。
- iframe 已加载但超时(30s)未发 `init` → 错误态 + 重试(重建 iframe)。
- `public/drawio` 资产缺失 → 直接回退文本视图。

## i18n

`lib/i18n/messages/{en,zh-CN,zh-TW}.ts` 新增词条:加载中、加载失败/重试、
损坏文件提示、以文本打开、退出编辑、未保存确认等(对齐 ExcalidrawViewer 词条风格)。

## 测试

- `lib/drawio-file` 测试:有效/无效/压缩体/空内容判定。
- `DrawioViewer.test.mjs`:协议消息(init→load、save 防抖与基线、origin 拒绝)、
  flush、冲突 409 路径、回退分支。
- `fetch-drawio` 脚本幂等性(已存在版本一致时跳过)。

## 不做(YAGNI)

- `.drawio.svg` / `.drawio.png` 支持。
- 查看模式内的页面缩略图/搜索等 viewer 高级 UI(用 viewer.min.js 默认行为)。
- 导出 PNG/SVG(horseMD 的 export 协议暂不移植)。
- 桌面端自定义协议(horseMD 因无 HTTP server 才需要;pi-web 有)。
