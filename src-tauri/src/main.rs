//! Pi Web desktop shell (Tauri).
//!
//! Architecture mirrors desktop/main.cjs (Electron):
//!   1. Spawn the embedded Node server (bin/pi-web.js) or the packaged
//!      sidecar binary (binaries/pi-web-server, a Node SEA bundle).
//!   2. Wait for the HTTP port to accept connections.
//!   3. Open the main window pointing at http://127.0.0.1:<port>.
//!   4. Poll /api/agent/running and reflect the state in the tray tooltip.
//!   5. Kill the server child on exit.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::net::{SocketAddr, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{ContextMenu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 30141;
const RUNNING_POLL_MS: u64 = 2500;

/// Action selected in the last session-row context menu ("copied",
/// "copied-path", "copied-cwd", "revealed", "delete"). Written by the
/// app-level on_menu_event handler, consumed by session_row_context_menu.
struct ContextMenuAction(Mutex<Option<String>>);

/// Real server child handle (dev mode). In packaged mode the shell plugin
/// owns the sidecar process, so this stays empty.
struct ServerProcess(Mutex<Option<Child>>);

fn main() {
    let server = ServerProcess(Mutex::new(None));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(server)
        .manage(ContextMenuAction(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            confirm_delete_session,
            session_row_context_menu,
            open_terminal
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Route popup-menu selections into shared state for the
            // session_row_context_menu command.
            handle.on_menu_event(|_app, event| {
                let id = event.id().as_ref();
                if matches!(
                    id,
                    "copied" | "copied-path" | "copied-cwd" | "revealed" | "delete"
                ) {
                    *_app.state::<ContextMenuAction>().0.lock().unwrap() = Some(id.to_string());
                }
            });

            // 1. Spawn the embedded server.
            spawn_server(&handle)?;

            // 2. Wait until the port is accepting connections.
            wait_for_port(PORT, Duration::from_secs(60))
                .map_err(|e| format!("embedded server failed to start: {e}"))?;

            // 3. Tray icon with running-state tooltip.
            let tray = build_tray(&handle)?;
            handle.manage(TrayHandle(tray));

            // 4. Background poll: /api/agent/running -> tray tooltip.
            std::thread::spawn(move || running_status_loop(handle));

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the last window quits the app and takes the server down.
            if let tauri::WindowEvent::Destroyed = event {
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------------------------------------------------------------------------
// Server spawn
// ---------------------------------------------------------------------------

/// Spawn the embedded Next.js server.
///
/// - Dev (`cargo tauri dev`): run `node bin/pi-web.js` from the repo root, so
///   no packaging is required.
/// - Prod: run the sidecar binary declared in tauri.conf.json
///   (`externalBin: ["binaries/pi-web-server"]`), expected to be a Node
///   single-executable bundle (node-sea) containing the pi-web server.
fn spawn_server(app: &AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        spawn_dev_server(app)
    } else {
        spawn_sidecar_server(app)
    }
}

fn spawn_dev_server(app: &AppHandle) -> Result<(), String> {
    let repo_root = repo_root_from_cwd();
    let entry = repo_root.join("bin").join("pi-web.js");
    let node = std::env::var("NODE_BIN").unwrap_or_else(|_| "node".into());

    let mut child = Command::new(node)
        .arg(entry)
        .arg("--hostname")
        .arg(HOST)
        .arg("--port")
        .arg(PORT.to_string())
        .arg("--no-open")
        .env("PORT", PORT.to_string())
        .env("PI_WEB_HOSTNAME", HOST)
        .env("PI_WEB_NO_OPEN", "1")
        .current_dir(&repo_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to spawn node server: {e}"))?;

    // Pump stdout in a thread so the pipe never fills and blocks the server.
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                eprintln!("[server] {line}");
            }
        });
    }

    // Store the real child (stdout already moved out of it).
    *app.state::<ServerProcess>().0.lock().unwrap() = Some(child);
    Ok(())
}

fn spawn_sidecar_server(app: &AppHandle) -> Result<(), String> {
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;

    // The sidecar is a stock Node binary; the app payload lives under
    // resources/pi-web (assembled by scripts/build-sidecar.mjs).
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource dir: {e}"))?;
    let payload_dir = resource_dir.join("resources").join("pi-web");
    let entry = payload_dir.join("bin").join("pi-web.js");

    let sidecar = app
        .shell()
        .sidecar("pi-web-server")
        .map_err(|e| format!("sidecar not found: {e}"))?
        .args([
            entry.to_string_lossy().as_ref(),
            "--hostname",
            HOST,
            "--port",
            &PORT.to_string(),
            "--no-open",
        ])
        .env("PORT", PORT.to_string())
        .env("PI_WEB_HOSTNAME", HOST)
        .env("PI_WEB_NO_OPEN", "1")
        .current_dir(&payload_dir);

    let (mut rx, _child) = sidecar
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar: {e}"))?;

    // The shell plugin owns the sidecar's lifetime and reaps it on app exit;
    // we only forward its output here.
    std::thread::spawn(move || {
        while let Some(event) = rx.blocking_recv() {
            match event {
                CommandEvent::Stdout(line) => {
                    eprintln!("[server] {}", String::from_utf8_lossy(&line))
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[server:err] {}", String::from_utf8_lossy(&line))
                }
                CommandEvent::Terminated(status) => {
                    eprintln!("[server] terminated: {status:?}");
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn repo_root_from_cwd() -> std::path::PathBuf {
    // In dev, cargo runs with src-tauri/ as cwd.
    let cwd = std::env::current_dir().expect("cwd");
    if cwd.file_name().map(|n| n == "src-tauri").unwrap_or(false) {
        cwd.parent().unwrap().to_path_buf()
    } else {
        cwd
    }
}

// ---------------------------------------------------------------------------
// Port wait
// ---------------------------------------------------------------------------

fn wait_for_port(port: u16, timeout: Duration) -> Result<(), String> {
    let addr: SocketAddr = format!("{HOST}:{port}").parse().unwrap();
    let deadline = Instant::now() + timeout;
    loop {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok() {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err(format!("server did not listen on {addr} within {timeout:?}"));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

// ---------------------------------------------------------------------------
// Tray + running indicator
// ---------------------------------------------------------------------------

struct TrayHandle(tauri::tray::TrayIcon);

fn build_tray(app: &AppHandle) -> Result<tauri::tray::TrayIcon, String> {
    let icon = tauri::image::Image::from_path("public/icons/icon-mac-512.png")
        .or_else(|_| app.default_window_icon().cloned().ok_or("no icon available"))
        .map_err(|e| format!("tray icon: {e}"))?;

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("Pi Web Desktop")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)
        .map_err(|e| format!("tray build: {e}"))
}

fn running_status_loop(app: AppHandle) {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    let url = format!("http://{HOST}:{PORT}/api/agent/running");
    let mut last_running: Option<bool> = None;

    loop {
        let running = client
            .get(&url)
            .send()
            .ok()
            .and_then(|r| r.json::<serde_json::Value>().ok())
            .and_then(|v| {
                // Accepts { ids: [...] } or { running: [...] } shapes.
                v.get("ids")
                    .or_else(|| v.get("running"))
                    .and_then(|a| a.as_array())
                    .map(|a| !a.is_empty())
            });

        if let Some(running) = running {
            if last_running != Some(running) {
                last_running = Some(running);
                if let Some(tray) = app.try_state::<TrayHandle>() {
                    let _ = tray.0.set_tooltip(if running {
                        Some("Pi Web agent is running")
                    } else {
                        Some("Pi Web Desktop")
                    });
                    // Electron parity: Dock breathing dot / taskbar overlay /
                    // tray frame animation would hook in here. Tauri v2 lacks
                    // a public dock-setIcon API; animate the tray icon via
                    // tray.set_icon() with pre-generated frames if needed.
                }
            }
        }
        std::thread::sleep(Duration::from_millis(RUNNING_POLL_MS));
    }
}

// ---------------------------------------------------------------------------
// IPC commands (replace preload.cjs channels)
// ---------------------------------------------------------------------------

/// Parity for pi-web:confirm-delete-session — native confirmation dialog.
/// The frontend calls it via:
///   const ok = await invoke('confirm_delete_session', { name, id })
#[tauri::command]
fn confirm_delete_session(app: AppHandle, name: Option<String>, id: Option<String>) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let title = match &name {
        Some(n) if !n.is_empty() => format!("删除会话“{n}”？"),
        _ => "删除该会话？".to_string(),
    };
    let mut detail = "删除后无法恢复。".to_string();
    if let Some(id) = &id {
        detail = format!("会话 ID: {id}\n{detail}");
    }
    let confirmed = app
        .dialog()
        .message(detail)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("删除".into(), "取消".into()))
        .blocking_show();
    confirmed
}

/// Parity for pi-web:show-session-row-contextmenu — native popup menu on the
/// session row. Performs the selected action natively (clipboard / file
/// manager) and returns it so the frontend can follow up ("delete" triggers
/// the confirm dialog + DELETE fetch on the JS side).
#[tauri::command]
fn session_row_context_menu(
    app: AppHandle,
    window: tauri::Window,
    id: String,
    path: String,
    cwd: String,
    name: Option<String>,
) -> Result<Option<String>, String> {
    let label = match &name {
        Some(n) if !n.is_empty() => format!("会话：{n}"),
        _ => format!("会话：{id}"),
    };

    let disabled_label = MenuItemBuilder::with_id("header", label)
        .enabled(false)
        .build(&app)
        .map_err(|e| e.to_string())?;
    let copy_id = MenuItemBuilder::with_id("copied", "复制会话 ID")
        .build(&app)
        .map_err(|e| e.to_string())?;
    let copy_path = MenuItemBuilder::with_id("copied-path", "复制会话文件路径")
        .build(&app)
        .map_err(|e| e.to_string())?;
    let copy_cwd = MenuItemBuilder::with_id("copied-cwd", "复制工作目录")
        .build(&app)
        .map_err(|e| e.to_string())?;
    let reveal = MenuItemBuilder::with_id("revealed", "在文件管理器中显示会话文件")
        .build(&app)
        .map_err(|e| e.to_string())?;
    let delete = MenuItemBuilder::with_id("delete", "删除会话…")
        .build(&app)
        .map_err(|e| e.to_string())?;

    let sep1 = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    let sep2 = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;

    let menu = MenuBuilder::new(&app)
        .item(&disabled_label)
        .item(&sep1)
        .item(&copy_id)
        .item(&copy_path)
        .item(&copy_cwd)
        .item(&reveal)
        .item(&sep2)
        .item(&delete)
        .build()
        .map_err(|e| e.to_string())?;

    // Show the popup. muda does not return the clicked item from popup();
    // the selection is delivered to the app-level on_menu_event handler,
    // which writes it into shared state. Poll until it fires or the menu
    // is dismissed (timeout).
    menu.popup(window).map_err(|e| e.to_string())?;

    let deadline = Instant::now() + Duration::from_secs(120);
    let mut action: Option<String> = None;
    while Instant::now() < deadline {
        if let Some(captured) = app
            .state::<ContextMenuAction>()
            .0
            .lock()
            .unwrap()
            .take()
        {
            action = Some(captured);
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    if let Some(action) = &action {
        let text = match action.as_str() {
            "copied" => Some(id.clone()),
            "copied-path" => Some(path.clone()),
            "copied-cwd" => Some(cwd.clone()),
            _ => None,
        };
        if let Some(text) = text {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            app.clipboard()
                .write_text(text)
                .map_err(|e| format!("clipboard: {e}"))?;
        }
        if action == "revealed" {
            use tauri_plugin_opener::OpenerExt;
            app.opener()
                .reveal_item_in_dir(&path)
                .map_err(|e| format!("reveal: {e}"))?;
        }
    }

    Ok(action)
}

/// Parity for pi-web:open-terminal — open a native terminal window at the
/// given cwd (and switch to branch). Ported from desktop/main.cjs.
#[tauri::command(async)]
fn open_terminal(cwd: String, branch: Option<String>) -> Result<OpenTerminalResult, String> {
    run_open_terminal(&cwd, branch.as_deref())
}

#[derive(serde::Serialize)]
struct OpenTerminalResult {
    ok: bool,
    error: Option<String>,
}

fn ok_result() -> OpenTerminalResult {
    OpenTerminalResult { ok: true, error: None }
}

fn err_result(message: impl Into<String>) -> OpenTerminalResult {
    OpenTerminalResult { ok: false, error: Some(message.into()) }
}

fn shell_quote(v: &str) -> String {
    format!("'{}'", v.replace('\'', r"'\''"))
}

fn run_open_terminal(cwd: &str, branch: Option<&str>) -> Result<OpenTerminalResult, String> {
    if cfg!(target_os = "windows") {
        Ok(open_terminal_windows(cwd, branch))
    } else if cfg!(target_os = "macos") {
        Ok(open_terminal_macos(cwd, branch))
    } else {
        // Linux: try each terminal emulator in turn; verify via wmctrl when
        // available (Wayland GNOME silent-failure workaround).
        Ok(open_terminal_linux(cwd, branch))
    }
}

fn open_terminal_windows(cwd: &str, branch: Option<&str>) -> OpenTerminalResult {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;
    let psq = |v: &str| format!("\"{}\"", v.replace('"', "`\""));
    let git = branch
        .map(|b| format!("; try {{ git checkout {} }} catch {{}}", psq(b)))
        .unwrap_or_default();
    let ps_cmd = format!("Set-Location -LiteralPath {}{}", psq(cwd), git);
    let ps_line = format!(
        "pwsh.exe -NoExit -Command {} 2>nul || powershell.exe -NoExit -Command {}",
        ps_cmd, ps_cmd
    );
    #[cfg(target_os = "windows")]
    {
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
        let result = Command::new(comspec)
            .args(["/c", &format!("start \"\" /B {ps_line}")])
            .current_dir(cwd)
            .creation_flags(0x00000008 | 0x00000200) // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
            .spawn();
        return match result {
            Ok(_) => ok_result(),
            Err(e) => err_result(e.to_string()),
        };
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (cwd, ps_line);
        err_result("open_terminal_windows should only be called on Windows")
    }
}

fn open_terminal_macos(cwd: &str, branch: Option<&str>) -> OpenTerminalResult {
    let git = branch
        .map(|b| format!(" && git checkout {} 2>/dev/null || true", shell_quote(b)))
        .unwrap_or_default();
    let user_shell = std::env::var("SHELL").unwrap_or_else(|_| "bash".into());
    let sh = format!(
        "cd {}{} && exec {}",
        shell_quote(cwd),
        git,
        shell_quote(&user_shell)
    );
    let escaped = sh.replace('\\', "\\\\").replace('"', "\\\"");
    let result = Command::new("osascript")
        .args([
            "-e",
            &format!("tell application \"Terminal\" to do script \"{escaped}\""),
        ])
        .current_dir(cwd)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    match result {
        Ok(_) => ok_result(),
        Err(e) => err_result(e.to_string()),
    }
}

#[cfg(target_os = "linux")]
fn command_exists(name: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {} >/dev/null 2>&1", shell_quote(name))])
        .stdout(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn open_terminal_linux(cwd: &str, branch: Option<&str>) -> OpenTerminalResult {

    let git = branch
        .map(|b| format!(" && git checkout {} 2>/dev/null || true", shell_quote(b)))
        .unwrap_or_default();
    let user_shell = std::env::var("SHELL").unwrap_or_else(|_| "bash".into());
    let sh = format!(
        "cd {}{} && exec {}",
        shell_quote(cwd),
        git,
        shell_quote(&user_shell)
    );

    // Build the argv (excluding the leading command) for a launcher style:
    // - "xdg": xdg-terminal-exec — pass command+args directly (freedesktop std)
    // - "--":  gnome-terminal / xfce4-terminal separate options from command
    // - "-e":  xterm / konsole / kitty / alacritty / foot / wezterm …
    let build_args = |flag: &str| -> Vec<String> {
        match flag {
            "xdg" => vec!["sh".into(), "-c".into(), sh.clone()],
            "--" => vec!["--".into(), "sh".into(), "-c".into(), sh.clone()],
            _ => vec!["-e".into(), "sh".into(), "-c".into(), sh.clone()],
        }
    };

    // Candidate list: freedesktop standard first, then standalone emulators
    // immune to gnome-terminal's D-Bus factory problem, then D-Bus-based ones,
    // then gnome-terminal last.
    let mut candidates: Vec<(&str, &str)> = vec![
        ("xdg-terminal-exec", "xdg"),
        ("xterm", "-e"),
        ("kitty", "-e"),
        ("alacritty", "-e"),
        ("wezterm", "-e"),
        ("foot", "-e"),
        ("konsole", "-e"),
        ("xfce4-terminal", "--"),
        ("mate-terminal", "-e"),
        ("lxterminal", "-e"),
        ("tilix", "-e"),
        ("qterminal", "-e"),
        ("terminology", "-e"),
        ("ptyxis", "-e"),
        ("kgx", "-e"),
        ("gnome-terminal", "--"),
    ];
    let pref = std::env::var("TERMINAL").unwrap_or_default();
    let pref = pref.split_whitespace().next().unwrap_or("").to_string();
    if !pref.is_empty() {
        let flag = if pref == "gnome-terminal" || pref == "xfce4-terminal" { "--" } else { "-e" };
        candidates.insert(0, (Box::leak(pref.clone().into_boxed_str()), flag));
    }

    let available: Vec<&(&str, &str)> = candidates
        .iter()
        .filter(|(name, _)| command_exists(name))
        .collect();
    if available.is_empty() {
        return err_result(
            "No terminal emulator found. Set the TERMINAL env var (e.g. TERMINAL=xterm) or install xterm (apt install xterm / dnf install xterm).",
        );
    }

    let can_verify = command_exists("wmctrl");
    let list_windows = || -> String {
        Command::new("wmctrl")
            .arg("-l")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    };
    let before_windows = if can_verify { list_windows() } else { String::new() };

    let mut attempted: Vec<String> = Vec::new();
    for (name, flag) in &available {
        attempted.push((*name).to_string());
        let args = build_args(flag);
        Command::new(name)
            .args(&args)
            .current_dir(cwd)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok();
        // Give the emulator up to 2.5s to create a window.
        std::thread::sleep(Duration::from_millis(2500));
        if can_verify {
            let after_windows = list_windows();
            if after_windows != before_windows {
                return ok_result();
            }
            // No new window: this emulator may have silently failed. Try next.
            continue;
        }
        // Cannot verify — assume the first available worked.
        return ok_result();
    }

    let is_wayland = std::env::var("XDG_SESSION_TYPE")
        .map(|v| v.to_lowercase().contains("wayland"))
        .unwrap_or(false)
        || std::env::var("WAYLAND_DISPLAY").is_ok();
    let hint = if is_wayland {
        "gnome-terminal is known to silently fail on some Wayland GNOME setups. Install a standalone emulator (apt install xterm, or kitty/alacritty/wezterm) and/or set TERMINAL=xterm before launching pi-web."
    } else {
        "Set the TERMINAL env var to your preferred emulator (e.g. TERMINAL=xterm)."
    };
    err_result(format!(
        "Terminal launched but no window appeared (tried: {}). {hint}",
        attempted.join(", ")
    ))
}

#[cfg(not(target_os = "linux"))]
fn open_terminal_linux(_cwd: &str, _branch: Option<&str>) -> OpenTerminalResult {
    err_result("open_terminal_linux should only be called on Linux")
}
