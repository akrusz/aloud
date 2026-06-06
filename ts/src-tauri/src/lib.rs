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
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    // Persist window geometry across launches (auto-saves on exit; we restore
    // explicitly below since the window is built at runtime, not from config).
    .plugin(tauri_plugin_window_state::Builder::default().build())
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
      let port = server::start(data_dir);
      let init = format!("window.__ALOUD_API_BASE__ = 'http://127.0.0.1:{port}';");

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
