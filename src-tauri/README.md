# Pi Web — Tauri 桌面壳

对应 Electron 版 `desktop/main.cjs` 的职责。架构与 Electron 版一致：
**Node 服务器进程 + 本地 HTTP UI，Tauri 只做壳**。双壳并存，前端通过
`lib/desktop-bridge.ts` 做运行时检测，Electron 路径未受影响。

## 结构

```
src-tauri/
  src/main.rs          # 壳主逻辑
  tauri.conf.json      # withGlobalTauri、窗口指向 http://127.0.0.1:30141
  capabilities/        # 远程 UI (127.0.0.1) 的 IPC 白名单
  binaries/            # sidecar：官方 Node 二进制（构建时生成，gitignored）
  resources/pi-web/    # 应用 payload：bin/ .next/ public/ node_modules（生成）
```

## main.rs 职责（与 Electron 对照）

| Electron (desktop/main.cjs / preload.cjs) | Tauri | 状态 |
|---|---|---|
| spawn 内嵌服务器 + waitForPort | `spawn_server()` + `wait_for_port()` | ✅ |
| 托盘 + tooltip | `build_tray()` | ✅ |
| 运行状态指示（tooltip 切换） | `running_status_loop()` 轮询 `/api/agent/running` | ✅ |
| Dock 呼吸点 / Win 任务栏 overlay | 无公开 API；可用 `tray.set_icon()` 帧动画降级 | ⚠️ |
| 右键菜单（复制/显示/删除） | `session_row_context_menu` command（muda popup + `on_menu_event`） | ✅ |
| 删除确认对话框 | `confirm_delete_session` command（dialog 插件） | ✅ |
| 打开系统终端（含 Linux wmctrl 验证、TERMINAL 覆盖） | `open_terminal` command（完整移植） | ✅ |
| 拖拽文件原生路径 | 关闭 webview drag-drop 拦截，走 HTML5 `text/uri-list`（dropped-paths.ts 已有 file:// 解析） | ✅ |

## 开发

```bash
# 终端 1：Next dev server（沿用现有脚本）
npm run dev
# 终端 2：Tauri 壳（dev 模式 Rust 直接 spawn node bin/pi-web.js）
npm run desktop:tauri
```

前置：Rust 工具链 + `@tauri-apps/cli`（已加入 devDependencies）。
注意：`cargo tauri dev`/`build` 要求 `src-tauri/resources/pi-web` 与
`src-tauri/binaries/pi-web-server-*` 存在（见下），先跑一次打包脚本或放置占位。

## 打包

```bash
node scripts/build-sidecar.mjs     # next build + 组装 payload + 下载 Node sidecar
cd src-tauri && cargo tauri build  # 或 npm run desktop:tauri:build
```

- sidecar 是**官方 Node 二进制**（按平台从 nodejs.org 下载），Rust 端以
  `resources/pi-web/bin/pi-web.js` 为入口启动、cwd 设为 payload 根目录。
  不用 Node SEA：SEA 无法容纳 Next.js 与 node-pty 原生模块。
- payload 含完整 node_modules（prune 过 devDependencies），体积预计 150-300MB
  压缩后，仍显著小于 Electron 同等打包。
- 多平台发布：在对应平台 CI 上分别执行（node-pty 原生模块不可交叉编译）。

## 前端桥接

所有 shell 相关调用统一走 `lib/desktop-bridge.ts`：
`openDesktopTerminal`、`confirmDeleteSession`、`installTauriSessionRowContextMenu`。
检测顺序：`window.piDesktop`（Electron）→ `window.__TAURI__`（Tauri，由
`withGlobalTauri: true` 注入远程页面）→ 浏览器 fallback（HTTP API / window.confirm）。

## 已知差异（相对 Electron 版）

- Dock 动态图标 / Windows 任务栏 overlay：Tauri v2 无公开 API，托盘 tooltip
  指示仍可用；如需动画需自写平台插件。
- 自动更新：尚未接入（Electron 版走 `app-update` route），后续接
  `tauri-plugin-updater`。
- 关窗行为：Electron 隐藏到托盘；Tauri 骨架为直接退出（可按需改为 hide）。
