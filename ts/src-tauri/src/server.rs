//! Embedded local HTTP backend for the desktop shell.
//!
//! Serves `/app/v1/*`, the endpoints the TS UI reaches via
//! `fetch('/app/v1/...')` against an injected base URL (`ui/src/app-base.ts`
//! plus the `initialization_script` in `lib.rs`). Bound to an ephemeral
//! `127.0.0.1` port so nothing is exposed off-box, and guarded by a per-launch
//! token + Host check (`AuthConfig`) so other local processes and
//! rebinding/localhost-fetching websites can't drive it either.
//!
//! Whisper STT (`POST /app/v1/stt/whisper`) runs on whisper.cpp via whisper-rs:
//! raw little-endian f32 mono PCM in the body plus a `?sample_rate=` query,
//! returning `{text,language,duration}`, or 503 while the model is loading.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Query, Request, State},
    http::{header, HeaderName, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::cors::CorsLayer;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

// GGML models downloaded on demand from whisper.cpp's official mirror. The
// launch default is base.en (~142 MB, a good accuracy/size balance for a
// turn-based app); the Settings model-size + language pick retargets via the
// stt request's `model_size`/`lang` params (whisper_model_file).
const WHISPER_MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
const DEFAULT_WHISPER_MODEL: &str = "ggml-base.en.bin";

/// Map the Settings size + language onto a whisper.cpp model file. English
/// gets the smaller, better `.en` variants; other languages the multilingual
/// ones. "large" is v3 (no `.en` variant exists). None = unknown size.
fn whisper_model_file(size: &str, lang: &str) -> Option<String> {
    let en = lang.eq_ignore_ascii_case("en");
    let stem = match size {
        "tiny" | "base" | "small" | "medium" => {
            if en {
                format!("{size}.en")
            } else {
                size.to_string()
            }
        }
        "large" => "large-v3".to_string(),
        _ => return None,
    };
    Some(format!("ggml-{stem}.bin"))
}
const TARGET_SAMPLE_RATE: u32 = 16_000;
// 30 s of 16 kHz f32 mono ≈ 1.9 MB, and onset pre-buffering can stretch an
// utterance past that, so cap generously.
const MAX_AUDIO_BYTES: usize = 8 * 1024 * 1024;

pub struct AppState {
    whisper: Mutex<Option<Arc<WhisperContext>>>,
    whisper_ready: AtomicBool,
    // Last whisper init failure (download or load), cleared on success. Drives
    // an honest 503 body and the system-info whisper block - without it a
    // first-run download failure is invisible outside the Rust log.
    whisper_error: Mutex<Option<String>>,
    // The model file the loader is targeting (whisper_model_file). An stt
    // request naming a different one retargets and the loader follows.
    whisper_model: Mutex<String>,
    // A run_whisper_loader thread is alive. Guards against spawning two.
    whisper_loading: AtomicBool,
    // (bytes downloaded, content-length if known) while a model download is in
    // flight; None otherwise. Read by the 503 body and system-info.
    whisper_progress: Mutex<Option<(u64, Option<u64>)>>,
    model_dir: PathBuf,
    // Piper voice models (.onnx/.onnx.json).
    piper_dir: PathBuf,
    // See tts::PiperCache.
    piper: crate::tts::PiperCache,
    // One JSON file per session, served by /app/v1/sessions and revealed by
    // /app/v1/open-sessions-folder. On desktop the TS UI persists here
    // (BackendSessionStore) rather than in webview localStorage, so saved
    // sessions are durable, openable files.
    sessions_dir: PathBuf,
    // Root app-data dir, surfaced by /app/v1/open-config-folder.
    data_dir: PathBuf,
}

type Shared = Arc<AppState>;

/// Per-launch auth for the loopback server. Loopback binding alone is not
/// enough: any local process, or any website via `fetch('http://127.0.0.1:…')`
/// or DNS rebinding, can reach this port, which proxies the claude CLI,
/// reads/writes session files, and runs installers. So every request must carry
/// a random per-launch bearer token only the webview knows (injected as
/// `window.__ALOUD_API_TOKEN__`; see `lib.rs` and `ui/src/app-base.ts`) plus a
/// loopback `Host` header - a rebinding request reaches the socket fine but
/// carries the attacker's hostname, so that check kills it before the token does.
struct AuthConfig {
    token: String,
    allowed_hosts: [String; 2],
}

/// Carries the per-launch token. `Authorization: Bearer <token>` is accepted
/// too, for hand-rolled callers and debugging.
const TOKEN_HEADER: HeaderName = HeaderName::from_static("x-aloud-token");

/// Constant-time equality: token comparison must not leak how many leading
/// bytes matched through response timing.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Reject anything not provably from our webview: bad `Host` → 403, bad token
/// → 401. Runs inside the CORS layer, so browser preflights (which never carry
/// custom headers) are still answered.
async fn require_token(State(auth): State<Arc<AuthConfig>>, req: Request, next: Next) -> Response {
    let host_ok = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|h| auth.allowed_hosts.iter().any(|a| a == h))
        .unwrap_or(false);
    if !host_ok {
        return err(StatusCode::FORBIDDEN, "Bad Host header.").into_response();
    }
    let presented = req
        .headers()
        .get(&TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .or_else(|| {
            req.headers()
                .get(header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "))
        });
    let token_ok = presented
        .map(|t| ct_eq(t.as_bytes(), auth.token.as_bytes()))
        .unwrap_or(false);
    if !token_ok {
        return err(StatusCode::UNAUTHORIZED, "Missing or invalid API token.").into_response();
    }
    next.run(req).await
}

/// The per-launch API token: 32 random bytes as lowercase hex.
fn random_token() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn router(state: Shared, auth: Arc<AuthConfig>) -> Router {
    // The role-versioned prefix lives here in one place. The hosted, signed-in
    // service is /cloud/v1 on the remote Hono server.
    let app_v1 = Router::new()
        .route("/system-info", get(system_info))
        .route("/stt/whisper", post(stt_whisper))
        .route("/voices", get(voices))
        .route("/voices/preview", get(voices_preview))
        .route("/tts/download-model", post(tts_download_model))
        .route("/tts/uninstall-model", post(tts_uninstall_model))
        .route("/llm/anthropic/messages", post(llm_anthropic_messages))
        .route("/llm/claude_proxy/complete", post(llm_claude_proxy_complete))
        .route("/llm/claude_proxy/probe", get(llm_claude_proxy_probe))
        .route("/providers", get(providers))
        .route("/models/{provider}", get(models))
        .route("/google-oauth", post(google_oauth))
        .route("/ollama/pull", post(ollama_pull))
        .route("/ollama/delete", post(ollama_delete))
        .route("/ollama/restart", post(ollama_restart))
        .route("/ollama/upgrade", post(ollama_upgrade))
        .route("/install/{tool}", post(install_tool))
        .route("/sessions", get(sessions_list))
        .route(
            "/sessions/{id}",
            get(sessions_get).put(sessions_put).delete(sessions_delete),
        )
        .route("/open-config-folder", post(open_config_folder))
        .route("/open-sessions-folder", post(open_sessions_folder))
        .route("/open-session-file/{id}", post(open_session_file))
        .route("/open-voice-settings", post(open_voice_settings));
    // The webview origin (tauri://localhost in prod, http://localhost:4649 in
    // dev) differs from this server's 127.0.0.1:<port>, so every request is
    // cross-origin. Allow exactly the origins the webview can have; anything
    // else (a website fetching the loopback) gets no CORS headers.
    let cors = CorsLayer::new()
        .allow_origin([
            HeaderValue::from_static("tauri://localhost"), // macOS/Linux prod
            HeaderValue::from_static("http://tauri.localhost"), // Windows prod
            HeaderValue::from_static("http://localhost:4649"), // tauri:dev (Vite)
            HeaderValue::from_static("http://127.0.0.1:4649"),
        ])
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            TOKEN_HEADER,
            HeaderName::from_static("x-provider-key"),
            HeaderName::from_static("x-api-key"),
        ]);
    Router::new()
        .nest("/app/v1", app_v1)
        // Later .layer() calls are outermost, so requests hit CORS (answering
        // preflights tokenlessly) before the token check.
        .layer(middleware::from_fn_with_state(auth, require_token))
        .layer(cors)
        .layer(DefaultBodyLimit::max(MAX_AUDIO_BYTES))
        .with_state(state)
}

/// Bind an ephemeral loopback port, kick off model loading in the background,
/// spawn the server on Tauri's async runtime, and return the chosen port plus
/// the per-launch API token (both injected into the webview by `lib.rs`).
pub fn start(data_dir: PathBuf) -> (u16, String) {
    // Silences whisper.cpp/GGML's model-load dump by redirecting their stderr
    // into whisper-rs's logging hook, which is a no-op here because we don't
    // enable its `log_backend`/`tracing_backend` feature. Our own log:: lines
    // are unaffected; enable `log_backend` to see those internals when
    // debugging. Must run before the whisper context loads below.
    whisper_rs::install_logging_hooks();

    let state: Shared = Arc::new(AppState {
        whisper: Mutex::new(None),
        whisper_ready: AtomicBool::new(false),
        whisper_error: Mutex::new(None),
        whisper_model: Mutex::new(DEFAULT_WHISPER_MODEL.to_string()),
        whisper_loading: AtomicBool::new(true),
        whisper_progress: Mutex::new(None),
        model_dir: data_dir.join("models"),
        piper_dir: data_dir.join("piper-models"),
        piper: Mutex::new(None),
        sessions_dir: data_dir.join("sessions"),
        data_dir,
    });

    // The download is large and the load slow, so keep both off the server
    // path. Until the loader finishes /app/v1/stt/whisper returns 503 with the
    // reason (loading / downloading / failed-and-retrying).
    {
        let state = state.clone();
        std::thread::spawn(move || run_whisper_loader(&state));
    }

    tauri::async_runtime::block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local api server");
        let port = listener
            .local_addr()
            .expect("local api server addr")
            .port();
        let token = random_token();
        let auth = Arc::new(AuthConfig {
            token: token.clone(),
            allowed_hosts: [format!("127.0.0.1:{port}"), format!("localhost:{port}")],
        });
        let app = router(state, auth);
        tauri::async_runtime::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                log::error!("local api server stopped: {e}");
            }
        });
        log::info!("local api server listening on 127.0.0.1:{port}");
        (port, token)
    })
}

/// Background loader: (re)load whichever model `whisper_model` targets,
/// retrying failures with backoff, until the loaded model matches the target.
/// At most one runs (`whisper_loading`); stt_whisper retargets and respawns.
/// A failed first-run download (offline launch, proxy blocking huggingface.co)
/// used to fail once and leave STT dead for the app's lifetime.
fn run_whisper_loader(state: &AppState) {
    let mut delay = std::time::Duration::from_secs(15);
    loop {
        let target = state.whisper_model.lock().unwrap().clone();
        match load_whisper(state, &target) {
            Ok(retargeted) => {
                if !retargeted {
                    break;
                }
                delay = std::time::Duration::from_secs(15);
            }
            Err(e) => {
                log::error!("whisper init failed (retrying in {}s): {e}", delay.as_secs());
                *state.whisper_error.lock().unwrap() = Some(e);
                // Sleep in 1s slices so a model switch doesn't wait out the
                // whole backoff before being picked up.
                let mut slept = std::time::Duration::ZERO;
                while slept < delay
                    && *state.whisper_model.lock().unwrap() == target
                {
                    std::thread::sleep(std::time::Duration::from_secs(1));
                    slept += std::time::Duration::from_secs(1);
                }
                delay = if *state.whisper_model.lock().unwrap() == target {
                    (delay * 2).min(std::time::Duration::from_secs(300))
                } else {
                    std::time::Duration::from_secs(15)
                };
            }
        }
    }
    state.whisper_loading.store(false, Ordering::SeqCst);
}

/// Download (if absent) + load one model file. Ok(true) = loaded fine but the
/// target changed mid-load, so the result was discarded and the caller should
/// go again; Ok(false) = loaded and installed.
fn load_whisper(state: &AppState, file: &str) -> Result<bool, String> {
    std::fs::create_dir_all(&state.model_dir).map_err(|e| e.to_string())?;
    let path = state.model_dir.join(file);
    if !path.exists() {
        let url = format!("{WHISPER_MODEL_BASE_URL}{file}");
        log::info!("downloading whisper model {file} -> {}", path.display());
        download(&url, &path, state)?;
        log::info!("whisper model downloaded: {file}");
    }
    let model_path = path.to_str().ok_or("model path not UTF-8")?;
    let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map_err(|e| format!("load model: {e}"))?;
    // Install only if this is still the wanted model - a switch mid-load must
    // not briefly publish the superseded one as ready.
    let current = state.whisper_model.lock().unwrap();
    if *current != file {
        return Ok(true);
    }
    *state.whisper.lock().unwrap() = Some(Arc::new(ctx));
    *state.whisper_error.lock().unwrap() = None;
    state.whisper_ready.store(true, Ordering::SeqCst);
    log::info!("whisper model ready: {file}");
    Ok(false)
}

/// Stream a URL to a file via a `.part` sibling, renamed on success so a
/// half-finished download can't be mistaken for a complete model. Progress
/// lands in `whisper_progress` for the 503 body / system-info.
fn download(url: &str, dest: &Path, state: &AppState) -> Result<(), String> {
    use std::io::{Read, Write};
    let tmp = dest.with_extension("part");
    let response = ureq::get(url).call().map_err(|e| e.to_string())?;
    let total: Option<u64> = response
        .headers()
        .get("content-length")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse().ok());
    let mut reader = response.into_body().into_reader();
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 65536];
    let mut done: u64 = 0;
    *state.whisper_progress.lock().unwrap() = Some((0, total));
    let copied = loop {
        match reader.read(&mut buf) {
            Ok(0) => break Ok(()),
            Ok(n) => {
                if let Err(e) = file.write_all(&buf[..n]) {
                    break Err(e.to_string());
                }
                done += n as u64;
                *state.whisper_progress.lock().unwrap() = Some((done, total));
            }
            Err(e) => break Err(e.to_string()),
        }
    };
    *state.whisper_progress.lock().unwrap() = None;
    copied?;
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// `GET /app/v1/system-info` - platform + tool availability. A successful
/// response is also the UI's "is desktop" signal.
async fn system_info(State(state): State<Shared>) -> Json<Value> {
    let claude = which::which("claude").ok();
    let ollama = which::which("ollama").ok();
    let path_str = |p: Option<PathBuf>| -> Value {
        match p {
            Some(p) => json!(p.display().to_string()),
            None => Value::Null,
        }
    };
    // The UI's platform-string consumers expect "darwin", not Rust's "macos".
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    Json(json!({
        "platform": platform,
        // The UI's is-desktop probe keys off this to enable desktop-only
        // features. The web Hono answers false.
        "desktop": true,
        // The UI sizes the Ollama context window from this
        // (contextLengthForRam). null when detection fails.
        "ram_gb": crate::providers::system_ram_gb(),
        "has_homebrew": which::which("brew").is_ok(),
        // STT health for the bug-report diagnostics block: ready, still
        // loading (error null), or failed-and-retrying (error set), plus the
        // targeted model file and download progress when one is in flight.
        "whisper": {
            "ready": state.whisper_ready.load(Ordering::SeqCst),
            "error": state.whisper_error.lock().unwrap().clone(),
            "model": state.whisper_model.lock().unwrap().clone(),
            "download": state.whisper_progress.lock().unwrap().map(|(done, total)| {
                json!({ "downloaded": done, "total": total })
            }),
        },
        "tools": {
            "claude_cli": { "installed": claude.is_some(), "path": path_str(claude) },
            "ollama": { "installed": ollama.is_some(), "path": path_str(ollama) },
        },
    }))
}

#[derive(Deserialize)]
struct SttQuery {
    sample_rate: Option<u32>,
    /// Settings model size (tiny/base/small/medium/large). Absent = keep the
    /// current model - the UI's reachability probe sends a bare POST and must
    /// not retarget.
    model_size: Option<String>,
    /// 2-letter language (Settings). Picks .en vs multilingual model files and
    /// steers transcription.
    lang: Option<String>,
}

/// Transcribe raw f32 mono PCM. Body and response match the
/// CloudWhisperSttEngine adapter.
async fn stt_whisper(
    State(state): State<Shared>,
    Query(q): Query<SttQuery>,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    let lang = q.lang.clone().unwrap_or_else(|| "en".to_string());
    // Retarget on an explicit size/language change: drop the old context
    // (frees its RAM), mark not-ready, (re)start the loader if none runs.
    if let Some(size) = q.model_size.as_deref() {
        let Some(file) = whisper_model_file(size, &lang) else {
            return err(StatusCode::BAD_REQUEST, "Unknown Whisper model size.");
        };
        let mut current = state.whisper_model.lock().unwrap();
        if *current != file {
            log::info!("whisper model switch: {} -> {file}", *current);
            *current = file;
            state.whisper_ready.store(false, Ordering::SeqCst);
            *state.whisper.lock().unwrap() = None;
            *state.whisper_error.lock().unwrap() = None;
            if !state.whisper_loading.swap(true, Ordering::SeqCst) {
                let state = state.clone();
                std::thread::spawn(move || run_whisper_loader(&state));
            }
        }
    }
    if !state.whisper_ready.load(Ordering::SeqCst) {
        // Say WHY: mid-download (with progress), failed-and-retrying (with the
        // error), or plain loading - an endless generic "loading" reads as a
        // dead mic.
        let msg = if let Some((done, total)) = *state.whisper_progress.lock().unwrap() {
            match total {
                Some(t) => format!(
                    "Downloading the speech model - {}% done.",
                    done * 100 / t.max(1)
                ),
                None => format!(
                    "Downloading the speech model - {} MB so far.",
                    done / (1024 * 1024)
                ),
            }
        } else {
            match state.whisper_error.lock().unwrap().clone() {
                Some(e) => format!(
                    "Local speech recognition isn't ready ({e}). It keeps retrying - check your connection, or switch to aloud cloud in Settings."
                ),
                None => "Whisper model still loading - try again in a moment.".to_string(),
            }
        };
        return err(StatusCode::SERVICE_UNAVAILABLE, &msg);
    }
    if body.is_empty() {
        return err(StatusCode::BAD_REQUEST, "Empty request body.");
    }
    if body.len() % 4 != 0 {
        return err(
            StatusCode::BAD_REQUEST,
            "Body length not aligned to float32 frames.",
        );
    }

    let samples: Vec<f32> = body
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    if samples.is_empty() {
        return (StatusCode::OK, Json(json!({ "text": "" })));
    }

    let sample_rate = q.sample_rate.unwrap_or(TARGET_SAMPLE_RATE);
    let ctx = match state.whisper.lock().unwrap().clone() {
        Some(c) => c,
        None => {
            return err(
                StatusCode::SERVICE_UNAVAILABLE,
                "Whisper model still loading - try again in a moment.",
            )
        }
    };

    // Whisper inference is CPU-heavy and blocking; keep it off the async
    // reactor so the server stays responsive.
    match tokio::task::spawn_blocking(move || transcribe(&ctx, &samples, sample_rate, &lang)).await
    {
        Ok(Ok((text, duration))) => (
            StatusCode::OK,
            Json(json!({ "text": text.trim(), "language": "en", "duration": duration })),
        ),
        Ok(Err(e)) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Transcription failed: {e}"),
        ),
        Err(e) => err(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Transcription task failed: {e}"),
        ),
    }
}

fn err(code: StatusCode, msg: &str) -> (StatusCode, Json<Value>) {
    (code, Json(json!({ "error": msg })))
}

// --- TTS: /app/v1/voices + /app/v1/voices/preview --------------------------------

/// Fallback when the client sends no `?text=`. The UI always sends text, so
/// this is rarely hit.
const DEFAULT_PREVIEW_TEXT: &str = "Take a slow breath, and let your shoulders soften.";

#[derive(Deserialize)]
struct VoicesQuery {
    engine: Option<String>,
    lang: Option<String>,
}

/// `GET /app/v1/voices` - aggregated Piper + macOS catalogue (or one engine via
/// `?engine=`), optionally filtered by `?lang=`. Off the async reactor because
/// it shells out to `say -v ?` and stats the model dir.
async fn voices(State(state): State<Shared>, Query(q): Query<VoicesQuery>) -> Json<Value> {
    let dir = state.piper_dir.clone();
    let voices = tokio::task::spawn_blocking(move || {
        crate::tts::list_voices(q.engine.as_deref(), q.lang.as_deref(), &dir)
    })
    .await
    .unwrap_or_else(|_| Value::Array(Vec::new()));
    Json(voices)
}

#[derive(Deserialize)]
struct PreviewQuery {
    voice: Option<String>,
    engine: Option<String>,
    text: Option<String>,
    rate: Option<u32>,
}

/// `GET /app/v1/voices/preview` - synthesize one utterance to a WAV. Also the
/// session TTS path the UI streams sentences through, so the AppState model
/// cache matters here, not just for previews.
async fn voices_preview(State(state): State<Shared>, Query(q): Query<PreviewQuery>) -> Response {
    let voice = match q.voice {
        Some(v) if !v.is_empty() => v,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    let text = q.text.unwrap_or_else(|| DEFAULT_PREVIEW_TEXT.to_string());

    // Synthesis is blocking and CPU-heavy.
    let result = tokio::task::spawn_blocking(move || {
        crate::tts::synth_preview(
            &state.piper_dir,
            &state.piper,
            &voice,
            q.engine.as_deref(),
            &text,
            q.rate,
        )
    })
    .await;

    match result {
        Ok(Ok(bytes)) => ([(header::CONTENT_TYPE, "audio/wav")], bytes).into_response(),
        Ok(Err(e)) => {
            log::warn!("voice preview failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Err(e) => {
            log::error!("voice preview task failed: {e}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Deserialize)]
struct ModelReq {
    #[serde(default)]
    engine: String,
    #[serde(default)]
    voice: String,
}

/// `POST /app/v1/tts/download-model` - stream a Piper model download as NDJSON
/// progress lines. The download runs on a blocking thread and pushes events
/// through a channel backing the response body, so the UI gets live progress
/// for a 60-105 MB fetch.
async fn tts_download_model(State(state): State<Shared>, Json(req): Json<ModelReq>) -> Response {
    if req.engine.is_empty() || req.voice.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "engine and voice are required" })))
            .into_response();
    }

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<String, std::io::Error>>(64);
    let dir = state.piper_dir.clone();
    tokio::task::spawn_blocking(move || {
        let mut send = move |v: Value| {
            // If the client hangs up the receiver drops and sends fail; that's
            // fine, we just stop reporting.
            let _ = tx.blocking_send(Ok(format!("{v}\n")));
        };
        if let Err(e) = crate::tts::download_model(&dir, &req.engine, &req.voice, &mut send) {
            send(json!({ "status": "error", "error": e }));
        }
    });

    let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    Response::builder()
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(axum::body::Body::from_stream(stream))
        .expect("build ndjson response")
}

/// `POST /app/v1/tts/uninstall-model` - delete a downloaded Piper model.
async fn tts_uninstall_model(
    State(state): State<Shared>,
    Json(req): Json<ModelReq>,
) -> (StatusCode, Json<Value>) {
    if req.voice.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "voice is required" })));
    }
    match crate::tts::uninstall_model(&state.piper_dir, &req.engine, &req.voice) {
        Ok(status) => (StatusCode::OK, Json(json!({ "status": status }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))),
    }
}

// --- /app/v1/providers + /app/v1/models/<provider> -------------------------------

/// `GET /app/v1/providers` - claude / ollama probes plus env-var checks for the
/// API-key providers, including the Ollama tier/recommendation block. See
/// `crate::providers`.
async fn providers() -> Json<Value> {
    let v = tokio::task::spawn_blocking(crate::providers::providers)
        .await
        .unwrap_or_else(|_| json!({}));
    Json(v)
}

/// `GET /app/v1/models/{provider}` - the provider's live model list. The UI
/// forwards the user's BYOK key as `x-provider-key`, which never leaves
/// loopback; OpenRouter needs none, claude_proxy is static. See
/// `providers::models`.
async fn models(
    axum::extract::Path(provider): axum::extract::Path<String>,
    headers: axum::http::HeaderMap,
) -> Json<Value> {
    let key = headers
        .get("x-provider-key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    // The upstream fetches are synchronous (ureq), same as providers().
    let v = tokio::task::spawn_blocking(move || crate::providers::models(&provider, key.as_deref()))
        .await
        .unwrap_or_else(|_| json!([]));
    Json(v)
}

/// `POST /app/v1/google-oauth` - desktop Google sign-in via the loopback PKCE
/// flow (meditation-pal-fae). Returns `{code, codeVerifier, redirectUri}` for
/// the UI to finish at the hosted `/cloud/v1/auth/google/desktop`, which holds
/// the client secret. Long-lived: it waits for the user to finish in the
/// browser. See `crate::oauth`.
async fn google_oauth(Json(body): Json<crate::oauth::OauthStart>) -> Response {
    if body.client_id.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "client_id required" })))
            .into_response();
    }
    match crate::oauth::google_loopback(&body.client_id).await {
        Ok(r) => (
            StatusCode::OK,
            Json(json!({
                "code": r.code,
                "codeVerifier": r.code_verifier,
                "redirectUri": r.redirect_uri,
            })),
        )
            .into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))).into_response(),
    }
}

/// `POST /app/v1/ollama/pull` - stream a model pull as NDJSON progress lines.
async fn ollama_pull(Json(req): Json<crate::ollama::ModelReq>) -> Response {
    if req.model.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "model is required" })))
            .into_response();
    }
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<String, std::io::Error>>(64);
    tokio::task::spawn_blocking(move || {
        let mut send = move |v: Value| {
            let _ = tx.blocking_send(Ok(format!("{v}\n")));
        };
        if let Err(e) = crate::ollama::pull_stream(&req.model, &mut send) {
            send(json!({ "status": "error", "error": e }));
        }
    });
    let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    Response::builder()
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(axum::body::Body::from_stream(stream))
        .expect("build ndjson response")
}

/// `POST /app/v1/ollama/delete` - remove a pulled model. `{ ok: true }`, or
/// `{ error }` with a 502 on failure.
async fn ollama_delete(Json(req): Json<crate::ollama::ModelReq>) -> (StatusCode, Json<Value>) {
    if req.model.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "model is required" })));
    }
    match tokio::task::spawn_blocking(move || crate::ollama::delete(&req.model)).await {
        Ok(Ok(())) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Ok(Err(e)) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("delete task failed: {e}") })),
        ),
    }
}

/// Run a blocking, progress-emitting job on a worker thread and stream its
/// events back as NDJSON. `f` gets a `send` closure for `{status: ...}` events;
/// the stream ends when `f` returns. Shared by the Ollama
/// restart/upgrade/install handlers.
fn ndjson_stream<F>(f: F) -> Response
where
    F: FnOnce(&mut dyn FnMut(Value)) + Send + 'static,
{
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<String, std::io::Error>>(64);
    tokio::task::spawn_blocking(move || {
        let mut send = |v: Value| {
            let _ = tx.blocking_send(Ok(format!("{v}\n")));
        };
        f(&mut send);
    });
    let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    Response::builder()
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(axum::body::Body::from_stream(stream))
        .expect("build ndjson response")
}

/// `POST /app/v1/ollama/restart` - restart the local daemon, streaming progress
/// until the version endpoint answers again.
async fn ollama_restart() -> Response {
    ndjson_stream(|send| crate::ollama_tools::restart_stream(send))
}

/// `POST /app/v1/ollama/upgrade` - upgrade an existing install (brew on macOS,
/// install.sh on Linux). 400 + a download URL where there's no automatic path
/// (Windows, or macOS without Homebrew); otherwise streams.
async fn ollama_upgrade() -> Response {
    if let Some((error, download_url)) = crate::ollama_tools::upgrade_precheck() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": error, "download_url": download_url })),
        )
            .into_response();
    }
    ndjson_stream(|send| crate::ollama_tools::upgrade_stream(send))
}

/// `POST /app/v1/install/{tool}` - install an external tool (only `ollama`;
/// Piper is compiled in). Streams progress; 400 + download URL when there's no
/// automatic path.
async fn install_tool(axum::extract::Path(tool): axum::extract::Path<String>) -> Response {
    if let Err((status, error, download_url)) = crate::ollama_tools::install_precheck(&tool) {
        let code = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST);
        let mut body = json!({ "error": error });
        if let Some(url) = download_url {
            body["download_url"] = json!(url);
        }
        return (code, Json(body)).into_response();
    }
    ndjson_stream(move |send| crate::ollama_tools::install_stream(&tool, send))
}

// --- /app/v1/open-* shell escapes ---------------------------------------------

/// Reveal a path in the platform file browser (Finder / Explorer / xdg).
/// Detached spawn: the user just wants the window to appear.
fn reveal_path(path: &Path) -> std::io::Result<()> {
    use std::process::Command;
    let _ = std::fs::create_dir_all(path); // best-effort; the dir may not exist yet
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(path);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("explorer");
        c.arg(path);
        c
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(path);
        c
    };
    cmd.spawn().map(|_| ())
}

/// Reveal a file, *selecting* it rather than just opening its folder. macOS
/// `open -R` and Windows `explorer /select,` highlight the file; Linux has no
/// portable "select" flag, so open the parent dir.
fn reveal_file(path: &Path) -> std::io::Result<()> {
    use std::process::Command;
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg("-R").arg(path);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("explorer");
        c.arg(format!("/select,{}", path.display()));
        c
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(path.parent().unwrap_or(path));
        c
    };
    cmd.spawn().map(|_| ())
}

/// `POST /app/v1/open-session-file/{id}` - highlight one saved session's JSON
/// file in the file browser. 404 if it hasn't been written yet, so the UI can
/// fail-soft.
async fn open_session_file(
    State(state): State<Shared>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<Value>) {
    let Some(path) = session_path(&state, &id) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad session id" })));
    };
    if !path.exists() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "session file not found" })));
    }
    match reveal_file(&path) {
        Ok(_) => (StatusCode::OK, Json(json!({ "status": "ok" }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("could not reveal file: {e}") })),
        ),
    }
}

/// `POST /app/v1/open-config-folder` - reveal the app's data directory. The TS
/// UI also pings this route with `OPTIONS` to decide whether to show the "Open
/// config folder" button; axum answers 405, which the detector counts as "route
/// exists", so registering the POST is enough.
async fn open_config_folder(State(state): State<Shared>) -> (StatusCode, Json<Value>) {
    open_dir_response(&state.data_dir)
}

/// `POST /app/v1/open-sessions-folder` - reveal the session-logs dir, created
/// on first save.
async fn open_sessions_folder(State(state): State<Shared>) -> (StatusCode, Json<Value>) {
    open_dir_response(&state.sessions_dir)
}

// --- /app/v1/sessions - on-disk session logs (desktop persistence) ------------

/// Session ids are `YYYY-MM-DD-HHMMSS`, but the client is untrusted, so allow
/// only a safe filename charset. This is what keeps `{id}` from escaping the
/// sessions dir: `..`, `/`, NUL and friends are all rejected.
fn safe_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn session_path(state: &AppState, id: &str) -> Option<PathBuf> {
    if safe_session_id(id) {
        Some(state.sessions_dir.join(format!("{id}.json")))
    } else {
        None
    }
}

/// `GET /app/v1/sessions` - saved session ids (filenames sans `.json`).
async fn sessions_list(State(state): State<Shared>) -> (StatusCode, Json<Value>) {
    let mut ids: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&state.sessions_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if let Some(stem) = name.to_string_lossy().strip_suffix(".json") {
                ids.push(stem.to_string());
            }
        }
    }
    (StatusCode::OK, Json(json!({ "ids": ids })))
}

/// `GET /app/v1/sessions/{id}` - read one session's JSON (404 if absent).
async fn sessions_get(
    State(state): State<Shared>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    let Some(path) = session_path(&state, &id) else {
        return (StatusCode::BAD_REQUEST, "bad session id").into_response();
    };
    match std::fs::read(&path) {
        Ok(bytes) => ([(header::CONTENT_TYPE, "application/json")], bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// `PUT /app/v1/sessions/{id}` - write one session's JSON (body is the state).
async fn sessions_put(
    State(state): State<Shared>,
    axum::extract::Path(id): axum::extract::Path<String>,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    let Some(path) = session_path(&state, &id) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad session id" })));
    };
    let _ = std::fs::create_dir_all(&state.sessions_dir);
    match std::fs::write(&path, &body) {
        Ok(_) => (StatusCode::OK, Json(json!({ "status": "ok" }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("could not save session: {e}") })),
        ),
    }
}

/// `DELETE /app/v1/sessions/{id}` - remove one session's JSON (idempotent).
async fn sessions_delete(
    State(state): State<Shared>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<Value>) {
    let Some(path) = session_path(&state, &id) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "bad session id" })));
    };
    match std::fs::remove_file(&path) {
        Ok(_) => (StatusCode::OK, Json(json!({ "status": "ok" }))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            (StatusCode::OK, Json(json!({ "status": "ok" })))
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("could not delete session: {e}") })),
        ),
    }
}

fn open_dir_response(path: &Path) -> (StatusCode, Json<Value>) {
    match reveal_path(path) {
        Ok(_) => (StatusCode::OK, Json(json!({ "status": "ok" }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("could not open folder: {e}") })),
        ),
    }
}

/// `POST /app/v1/open-voice-settings` - open macOS System Settings to the Spoken
/// Content pane, where Premium voices are installed. Other OSes get a 400 so
/// the UI can hide the button or fail-soft.
async fn open_voice_settings() -> (StatusCode, Json<Value>) {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        let res = Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.universalaccess?TextToSpeech")
            .spawn();
        return match res {
            Ok(_) => (StatusCode::OK, Json(json!({ "status": "ok" }))),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": format!("could not open settings: {e}") })),
            ),
        };
    }
    #[cfg(not(target_os = "macos"))]
    {
        (StatusCode::BAD_REQUEST, Json(json!({ "error": "macOS only" })))
    }
}

/// `POST /app/v1/llm/anthropic/messages` - relay an Anthropic Messages request
/// upstream, since the webview can't reach Anthropic directly (no CORS). The
/// user's BYOK key arrives as `x-api-key` over loopback; a server-side
/// `ANTHROPIC_API_KEY` is the dev/parity fallback.
async fn llm_anthropic_messages(headers: axum::http::HeaderMap, body: Bytes) -> Response {
    if body.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Empty request body." })))
            .into_response();
    }
    if body.len() > crate::llm::MAX_PROXY_BYTES {
        return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({ "error": "Request body too large." })))
            .into_response();
    }

    let key = headers
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .filter(|k| !k.is_empty())
        .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok())
        .filter(|k| !k.is_empty());
    let Some(key) = key else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "No Anthropic API key. Add your key in Settings or set ANTHROPIC_API_KEY."
            })),
        )
            .into_response();
    };

    let body_vec = body.to_vec();
    match tokio::task::spawn_blocking(move || crate::llm::anthropic_proxy(body_vec, &key)).await {
        Ok(Ok(r)) => {
            let code = StatusCode::from_u16(r.status).unwrap_or(StatusCode::BAD_GATEWAY);
            let mut resp = (code, r.body).into_response();
            if let Ok(ct) = header::HeaderValue::from_str(&r.content_type) {
                resp.headers_mut().insert(header::CONTENT_TYPE, ct);
            }
            resp
        }
        Ok(Err(e)) => {
            let code = StatusCode::from_u16(e.status).unwrap_or(StatusCode::BAD_GATEWAY);
            (code, Json(json!({ "error": e.message }))).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("proxy task failed: {e}") })),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct ProbeQuery {
    model: Option<String>,
}

/// `GET /app/v1/llm/claude_proxy/probe?model=<id>` - can the local Claude
/// subscription serve `<id>` right now? Runs a cached probe against the `claude`
/// CLI (`crate::llm::claude_probe`) so the UI can grey out a model Anthropic has
/// pulled from subscriptions before offering it. Returns `{model, status}`,
/// status one of available/unavailable/cli_missing/unknown.
async fn llm_claude_proxy_probe(
    State(state): State<Shared>,
    Query(q): Query<ProbeQuery>,
) -> Response {
    let model = q.model.unwrap_or_default();
    if model.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "model required" })))
            .into_response();
    }
    // Same app-owned scratch cwd as the completion path, same reasons.
    let cwd = state.data_dir.join("claude-cwd");
    let _ = std::fs::create_dir_all(&cwd);
    let body = crate::llm::claude_probe(&model, &cwd).await;
    (StatusCode::OK, Json(body)).into_response()
}

/// `POST /app/v1/llm/claude_proxy/complete` - run one `claude` CLI completion
/// for the "Anthropic (Subscription)" provider. Desktop-only by nature, since
/// it needs the authenticated CLI. See `crate::llm`.
async fn llm_claude_proxy_complete(
    State(state): State<Shared>,
    Json(req): Json<crate::llm::CompleteRequest>,
) -> Response {
    // An empty scratch dir for the CLI's cwd: app-owned + per-user (under the
    // app data dir), so no untrusted CLAUDE.md/.claude can be planted the way a
    // world-writable temp dir would allow, and outside Documents/home so the
    // CLI's project scan doesn't trip a macOS file prompt.
    let cwd = state.data_dir.join("claude-cwd");
    let _ = std::fs::create_dir_all(&cwd);
    match crate::llm::claude_complete(req, &cwd).await {
        Ok(body) => (StatusCode::OK, Json(body)).into_response(),
        Err(e) => {
            let code = StatusCode::from_u16(e.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            (code, Json(json!({ "error": e.message }))).into_response()
        }
    }
}

fn transcribe(
    ctx: &WhisperContext,
    samples: &[f32],
    sample_rate: u32,
    lang: &str,
) -> Result<(String, f64), String> {
    // The TS client downsamples to the 16 kHz mono f32 whisper.cpp wants before
    // POSTing, so guard the assumption rather than resample here.
    if sample_rate != TARGET_SAMPLE_RATE {
        return Err(format!(
            "expected {TARGET_SAMPLE_RATE} Hz audio, got {sample_rate} Hz"
        ));
    }

    let mut wstate = ctx.create_state().map_err(|e| e.to_string())?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some(lang));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);

    wstate.full(params, samples).map_err(|e| e.to_string())?;

    let n = wstate.full_n_segments();
    let mut text = String::new();
    for i in 0..n {
        if let Some(segment) = wstate.get_segment(i) {
            let piece = segment.to_str_lossy().map_err(|e| e.to_string())?;
            text.push_str(piece.as_ref());
        }
    }
    let duration = samples.len() as f64 / sample_rate as f64;
    Ok((text, duration))
}
