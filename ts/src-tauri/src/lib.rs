mod llm;
mod oauth;
mod ollama;
mod ollama_tools;
mod providers;
mod server;
mod tts;

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags, WindowExt};

const GEOMETRY_FLAGS: StateFlags = StateFlags::POSITION
  .union(StateFlags::SIZE)
  .union(StateFlags::MAXIMIZED);

// Throttle geometry writes so a resize/move drag (events fire per frame) doesn't
// hammer the disk. The final position lands either on the next event past the
// window or on the plugin's clean-close save.
static LAST_GEOMETRY_SAVE: Mutex<Option<Instant>> = Mutex::new(None);

/// Persist the window's current bounds, at most every 500ms. The window-state
/// plugin already saves on a clean close (red button / Cmd+Q), but an ungraceful
/// kill (Ctrl+C in dev) never fires that path — so we also save as geometry
/// changes, keeping the last-known bounds on disk however the process dies.
fn save_geometry_throttled(app: &tauri::AppHandle) {
  {
    let now = Instant::now();
    let mut last = LAST_GEOMETRY_SAVE.lock().unwrap();
    if matches!(*last, Some(prev) if now.duration_since(prev) < Duration::from_millis(500)) {
      return;
    }
    *last = Some(now);
  }
  let _ = app.save_window_state(GEOMETRY_FLAGS);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// macOS apps launched from Finder/Launchpad/Dock inherit a minimal PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`) that omits Homebrew, `~/.local/bin`,
/// npm-global, and version-manager shims — so `which::which("claude")` (and
/// ollama/brew) fail even when the tool is installed, and a spawned `claude`
/// can't find `node`. Repair PATH once at startup: merge in the user's
/// login+interactive shell PATH (catches nvm/fnm/asdf/volta wherever they put
/// their shims), then append common static bin dirs as a backstop. Best-effort
/// and idempotent; failures leave PATH untouched. No-op off macOS, where GUI
/// launches already carry the user's PATH.
#[cfg(target_os = "macos")]
fn repair_path() {
  use std::collections::HashSet;

  let mut dirs: Vec<String> = std::env::var("PATH")
    .unwrap_or_default()
    .split(':')
    .filter(|s| !s.is_empty())
    .map(str::to_string)
    .collect();
  let mut seen: HashSet<String> = dirs.iter().cloned().collect();

  // 1) The user's real PATH from a login+interactive shell. stdin is not a TTY
  //    here, so an rc file that reads input gets EOF rather than hanging; a
  //    sentinel isolates the value from any rc-file stdout chatter.
  if let Ok(shell) = std::env::var("SHELL") {
    if let Ok(out) = std::process::Command::new(&shell)
      .args(["-lic", "printf '__ALOUD_PATH__%s__ALOUD_END__' \"$PATH\""])
      .output()
    {
      let s = String::from_utf8_lossy(&out.stdout);
      if let (Some(i), Some(j)) = (s.find("__ALOUD_PATH__"), s.find("__ALOUD_END__")) {
        for d in s[i + "__ALOUD_PATH__".len()..j].split(':') {
          if !d.is_empty() && seen.insert(d.to_string()) {
            dirs.push(d.to_string());
          }
        }
      }
    }
  }

  // 2) Static backstop: Homebrew (arm64 + Intel), /usr/local, the Claude Code
  //    native install dir (~/.local/bin), and npm-global.
  let mut backstop: Vec<String> = vec![
    "/opt/homebrew/bin".into(),
    "/opt/homebrew/sbin".into(),
    "/usr/local/bin".into(),
    "/usr/local/sbin".into(),
  ];
  if let Ok(home) = std::env::var("HOME") {
    for sub in [".local/bin", ".npm-global/bin", "bin"] {
      backstop.push(format!("{home}/{sub}"));
    }
  }
  for d in backstop {
    if seen.insert(d.clone()) {
      dirs.push(d);
    }
  }

  std::env::set_var("PATH", dirs.join(":"));
}

#[cfg(not(target_os = "macos"))]
fn repair_path() {}

pub fn run() {
  // Must run before any which::which / CLI spawn (providers probe, claude, ollama).
  repair_path();

  #[allow(unused_mut)]
  let mut builder = tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    // Persist window geometry across launches (auto-saves on exit; we restore
    // explicitly below since the window is built at runtime, not from config).
    .plugin(tauri_plugin_window_state::Builder::default().build());

  // Self-updater + process control (for relaunch after an update). Desktop-only
  // plugins; the in-app "Update" button (ui/src/desktop-updater.ts) drives them.
  #[cfg(desktop)]
  {
    builder = builder
      .plugin(tauri_plugin_updater::Builder::new().build())
      .plugin(tauri_plugin_process::init());
  }

  builder
    .on_window_event(|window, event| {
      if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
        save_geometry_throttled(window.app_handle());
      }
    })
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            // ONNX Runtime (pulled in by piper-rs) logs a wall of INFO lines
            // ("Reserving memory in BFCArena…", "Done saving initialized
            // tensors", …) on every Piper synth. Quiet it to warnings+ while
            // keeping our own Info logs.
            .level_for("ort", log::LevelFilter::Warn)
            .build(),
        )?;
      }

      // Start the embedded local backend and inject its base URL into the
      // webview before any page script runs, so ui/src/app-base.ts can resolve
      // /app/v1/* against it. The window is built here (not in tauri.conf.json)
      // because an initialization_script can only be attached at build time.
      // Models (Whisper, Piper) are cached under the app data dir; the server
      // derives per-engine subdirs from it.
      let data_dir = app.path().app_data_dir().expect("resolve app data dir");
      let (port, token) = server::start(data_dir);
      // The per-launch token gates every /app/v1 request (see server.rs
      // require_token); app-base.ts attaches it to loopback fetches. Hex-only,
      // so it's safe to splice into the script literal.
      let init = format!(
        "window.__ALOUD_API_BASE__ = 'http://127.0.0.1:{port}';\n\
         window.__ALOUD_API_TOKEN__ = '{token}';"
      );

      let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("aloud")
        .inner_size(1000.0, 820.0)
        .min_inner_size(480.0, 600.0)
        .resizable(true)
        .initialization_script(init.as_str());

      // macOS: frameless-feeling window that keeps the native traffic-light
      // controls. The .nav doubles as the draggable title bar (see the TS UI).
      #[cfg(target_os = "macos")]
      let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

      let window = builder.build()?;
      // Apply the saved position/size/maximized state (no-op on first run).
      let _ = window.restore_state(GEOMETRY_FLAGS);
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
