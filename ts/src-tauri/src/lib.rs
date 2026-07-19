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

// Resize/move events fire per frame; throttle so a drag doesn't hammer the disk.
static LAST_GEOMETRY_SAVE: Mutex<Option<Instant>> = Mutex::new(None);

/// Persist the window's bounds, at most every 500ms. The plugin saves on a clean
/// close (red button / Cmd+Q), but an ungraceful kill (Ctrl+C in dev) never
/// fires that path, so we also save as geometry changes.
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
/// macOS Finder/Launchpad/Dock launches inherit a minimal PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`) with no Homebrew, `~/.local/bin`,
/// npm-global, or version-manager shims, so `which::which("claude")` (and
/// ollama/brew) fail even when installed, and a spawned `claude` can't find
/// `node`. Merge in the user's login+interactive shell PATH (catches
/// nvm/fnm/asdf/volta), then static bin dirs as a backstop. Best-effort and
/// idempotent. No-op off macOS, where GUI launches carry the user's PATH.
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

  // 1) The user's real PATH from a login+interactive shell. stdin isn't a TTY,
  //    so an rc file that reads input gets EOF rather than hanging; the
  //    sentinel isolates the value from rc-file stdout chatter.
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

  // 2) Backstop: Homebrew (arm64 + Intel), /usr/local, the Claude Code native
  //    install dir (~/.local/bin), npm-global.
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
    // Persists geometry across launches. We restore explicitly below, since the
    // window is built at runtime rather than from config.
    .plugin(tauri_plugin_window_state::Builder::default().build());

  // Self-updater + process control (relaunch after an update), driven by the
  // in-app "Update" button (ui/src/desktop-updater.ts).
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
            // ONNX Runtime (via piper-rs) logs a wall of INFO lines on every
            // Piper synth. Quiet it without losing our own Info logs.
            .level_for("ort", log::LevelFilter::Warn)
            .build(),
        )?;
      }

      // Start the embedded backend and inject its base URL before any page
      // script runs, so ui/src/app-base.ts can resolve /app/v1/* against it.
      // The window is built here, not in tauri.conf.json, because an
      // initialization_script can only be attached at build time. Models
      // (Whisper, Piper) cache under the app data dir; the server derives
      // per-engine subdirs from it.
      let data_dir = app.path().app_data_dir().expect("resolve app data dir");
      let (port, token) = server::start(data_dir);
      // The per-launch token gates every /app/v1 request (server.rs
      // require_token). Hex-only, so splicing it into the literal is safe.
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

      // macOS: frameless-feeling window that keeps the native traffic lights.
      // The .nav doubles as the draggable title bar (see the TS UI).
      #[cfg(target_os = "macos")]
      let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

      let window = builder.build()?;
      // No-op on first run.
      let _ = window.restore_state(GEOMETRY_FLAGS);
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
