//! Embedded local HTTP backend for the desktop shell.
//!
//! Serves the app's own backend surface (`/app/v1/*`) — the endpoints the TS UI
//! reaches via `fetch('/app/v1/...')`, which in a Tauri build hit this server
//! through an injected base URL (see `ui/src/app-base.ts` and the
//! `initialization_script` in `lib.rs`). Bound to
//! an ephemeral `127.0.0.1` port so nothing is exposed off-box, and guarded by
//! a per-launch token + Host check (see `AuthConfig`) so other local processes
//! and rebinding/localhost-fetching websites can't drive it either.
//!
//! Endpoints:
//! - `GET  /app/v1/system-info` — platform + tool availability.
//! - `POST /app/v1/stt/whisper` — local Whisper STT via whisper.cpp (whisper-rs).
//!   Takes raw little-endian f32 mono PCM in the body, a `?sample_rate=` query,
//!   returns `{text,language,duration}`, and 503 while the model is still
//!   loading (the UI already handles that).

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

// Default STT model: base.en GGML (~142 MB). Good accuracy/size balance for a
// turn-based meditation app; the meditation-pal-nn1 research calls for a
// capability-tiered choice (tiny/base/small) later. Downloaded on first run.
const WHISPER_MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
const WHISPER_MODEL_FILE: &str = "ggml-base.en.bin";
const TARGET_SAMPLE_RATE: u32 = 16_000;
// 30 s of 16 kHz f32 mono ≈ 1.9 MB; with onset pre-buffering an utterance can
// run longer, so cap generously.
const MAX_AUDIO_BYTES: usize = 8 * 1024 * 1024;

pub struct AppState {
    whisper: Mutex<Option<Arc<WhisperContext>>>,
    whisper_ready: AtomicBool,
    model_dir: PathBuf,
    // Piper voice models (.onnx/.onnx.json) live here, downloaded on demand.
    piper_dir: PathBuf,
    // LRU-of-1 cache of the last-loaded Piper model (see tts::PiperCache).
    piper: crate::tts::PiperCache,
    // On-disk session logs — one JSON file per session, served by the
    // /app/v1/sessions routes and revealed by /app/v1/open-sessions-folder. In
    // a desktop build the TS UI persists here (BackendSessionStore) instead of
    // webview localStorage, so saved sessions are durable, openable files.
    sessions_dir: PathBuf,
    // Root app-data dir — surfaced by /app/v1/open-config-folder for "show me
    // where my data lives" buttons in the TS UI.
    data_dir: PathBuf,
}

type Shared = Arc<AppState>;

/// Per-launch auth for the loopback server. Loopback-bound is not enough on its
/// own: any local process — or any website, via `fetch('http://127.0.0.1:…')`
/// or DNS rebinding — can reach this port, and it proxies the claude CLI,
/// reads/writes session files, and runs installers. So every request must
/// present a random per-launch bearer token that only the webview knows (it's
/// injected as `window.__ALOUD_API_TOKEN__` next to the base URL; see `lib.rs`
/// and `ui/src/app-base.ts`), and must carry a loopback `Host` header (a DNS
/// rebinding request reaches the socket fine but carries the attacker's
/// hostname, so this check kills it even before the token does).
struct AuthConfig {
    token: String,
    allowed_hosts: [String; 2],
}

/// Custom request header carrying the per-launch token (`Authorization:
/// Bearer <token>` is accepted too, for hand-rolled callers/debugging).
const TOKEN_HEADER: HeaderName = HeaderName::from_static("x-aloud-token");

/// Constant-time byte-string equality — token comparison must not leak how many
/// leading bytes matched through response timing.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Reject any request that isn't provably from our webview: wrong/missing
/// `Host` → 403, wrong/missing token → 401. Runs inside the CORS layer, so
/// browser preflights (which never carry custom headers) are still answered.
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

/// 32 random bytes as lowercase hex — the per-launch API token.
fn random_token() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn router(state: Shared, auth: Arc<AuthConfig>) -> Router {
    // The app's own backend surface, mounted under /app/v1. The role-versioned
    // prefix lives here in one place; the hosted, signed-in service lives at
    // /cloud/v1 on the remote Hono server.
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
        .route("/open-voice-settings", post(open_voice_settings));
    // The webview origin (tauri://localhost in prod, http://localhost:4649 in
    // dev) differs from this server's 127.0.0.1:<port>, so every request is
    // cross-origin. Allow exactly the origins our webview can have — anything
    // else (a random website fetching the loopback) gets no CORS headers.
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
        // Layer order matters: later .layer() calls are outermost, so requests
        // hit CORS (answering preflights tokenlessly) before the token check.
        .layer(middleware::from_fn_with_state(auth, require_token))
        .layer(cors)
        .layer(DefaultBodyLimit::max(MAX_AUDIO_BYTES))
        .with_state(state)
}

/// Bind an ephemeral loopback port, kick off model loading in the background,
/// spawn the server on Tauri's async runtime, and return the chosen port plus
/// the per-launch API token (both injected into the webview by `lib.rs`).
pub fn start(data_dir: PathBuf) -> (u16, String) {
    // Silence whisper.cpp/GGML's chatty model-load dump (n_vocab, n_audio_ctx,
    // …). It redirects their stderr into whisper-rs's logging hook, which is a
    // no-op here because we don't enable its `log_backend`/`tracing_backend`
    // feature — so the lines vanish, while our own log:: lines stay. To inspect
    // those internals when debugging, enable whisper-rs's `log_backend` feature.
    // Must run before the whisper context loads below.
    whisper_rs::install_logging_hooks();

    let state: Shared = Arc::new(AppState {
        whisper: Mutex::new(None),
        whisper_ready: AtomicBool::new(false),
        model_dir: data_dir.join("models"),
        piper_dir: data_dir.join("piper-models"),
        piper: Mutex::new(None),
        sessions_dir: data_dir.join("sessions"),
        data_dir,
    });

    // Model download + load is slow (and the download is large) — do it off the
    // server path. Until it finishes, /app/v1/stt/whisper returns 503, which the UI
    // surfaces as "model still loading".
    {
        let state = state.clone();
        std::thread::spawn(move || {
            if let Err(e) = load_whisper(&state) {
                log::error!("whisper init failed: {e}");
            }
        });
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

fn load_whisper(state: &AppState) -> Result<(), String> {
    std::fs::create_dir_all(&state.model_dir).map_err(|e| e.to_string())?;
    let path = state.model_dir.join(WHISPER_MODEL_FILE);
    if !path.exists() {
        log::info!("downloading whisper model -> {}", path.display());
        download(WHISPER_MODEL_URL, &path)?;
        log::info!("whisper model downloaded");
    }
    let model_path = path.to_str().ok_or("model path not UTF-8")?;
    let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map_err(|e| format!("load model: {e}"))?;
    *state.whisper.lock().unwrap() = Some(Arc::new(ctx));
    state.whisper_ready.store(true, Ordering::SeqCst);
    log::info!("whisper model ready");
    Ok(())
}

/// Stream a URL to a file, downloading to a `.part` sibling then renaming so a
/// half-finished download can't be mistaken for a complete model.
fn download(url: &str, dest: &Path) -> Result<(), String> {
    let tmp = dest.with_extension("part");
    let response = ureq::get(url).call().map_err(|e| e.to_string())?;
    let mut reader = response.into_body().into_reader();
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    std::io::copy(&mut reader, &mut file).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// `GET /app/v1/system-info` — platform + tool availability. The UI keys
/// desktop-only features off this (and uses a successful response as its "is
/// desktop" signal).
async fn system_info() -> Json<Value> {
    let claude = which::which("claude").ok();
    let ollama = which::which("ollama").ok();
    let path_str = |p: Option<PathBuf>| -> Value {
        match p {
            Some(p) => json!(p.display().to_string()),
            None => Value::Null,
        }
    };
    // Map Rust's "macos" to "darwin" so platform-string consumers in the UI
    // get the value they expect.
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    Json(json!({
        "platform": platform,
        // This is the local desktop backend; the UI's is-desktop probe keys off
        // this to enable desktop-only features (the web Hono answers false).
        "desktop": true,
        "has_homebrew": which::which("brew").is_ok(),
        "tools": {
            "claude_cli": { "installed": claude.is_some(), "path": path_str(claude) },
            "ollama": { "installed": ollama.is_some(), "path": path_str(ollama) },
        },
    }))
}

#[derive(Deserialize)]
struct SttQuery {
    sample_rate: Option<u32>,
}

/// Transcribe raw f32 mono PCM. Body and response match what the
/// CloudWhisperSttEngine adapter expects.
async fn stt_whisper(
    State(state): State<Shared>,
    Query(q): Query<SttQuery>,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    if !state.whisper_ready.load(Ordering::SeqCst) {
        return err(
            StatusCode::SERVICE_UNAVAILABLE,
            "Whisper model still loading — try again in a moment.",
        );
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
                "Whisper model still loading — try again in a moment.",
            )
        }
    };

    // Whisper inference is CPU-heavy and blocking — keep it off the async
    // reactor so concurrent requests / the server stay responsive.
    match tokio::task::spawn_blocking(move || transcribe(&ctx, &samples, sample_rate)).await {
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

/// Fallback preview phrase when the client doesn't supply `?text=`. The UI
/// always sends text (preview line or a session sentence), so this is rarely
/// hit; kept short.
const DEFAULT_PREVIEW_TEXT: &str = "Take a slow breath, and let your shoulders soften.";

#[derive(Deserialize)]
struct VoicesQuery {
    engine: Option<String>,
    lang: Option<String>,
}

/// `GET /app/v1/voices` — aggregated Piper + macOS voice catalogue (or one engine
/// when `?engine=` is set), optionally filtered by `?lang=`. Runs off the async
/// reactor because it shells out to `say -v ?` and stats the model dir.
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

/// `GET /app/v1/voices/preview` — synthesize one utterance to a WAV. This is also
/// the session TTS path the UI streams sentences through, so the model cache in
/// AppState matters here, not just for previews.
async fn voices_preview(State(state): State<Shared>, Query(q): Query<PreviewQuery>) -> Response {
    let voice = match q.voice {
        Some(v) if !v.is_empty() => v,
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    let text = q.text.unwrap_or_else(|| DEFAULT_PREVIEW_TEXT.to_string());

    // Synthesis (and any first-run model download) is blocking and CPU-heavy.
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

/// `POST /app/v1/tts/download-model` — stream a Piper model download as NDJSON
/// progress lines. The download runs on a blocking thread and pushes each
/// progress event through a channel that backs the response body, so the UI
/// gets live progress for a 60–105 MB fetch.
async fn tts_download_model(State(state): State<Shared>, Json(req): Json<ModelReq>) -> Response {
    if req.engine.is_empty() || req.voice.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "engine and voice are required" })))
            .into_response();
    }

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<String, std::io::Error>>(64);
    let dir = state.piper_dir.clone();
    tokio::task::spawn_blocking(move || {
        let mut send = move |v: Value| {
            // Best-effort: if the client hangs up, the receiver drops and sends
            // fail — that's fine, we just stop reporting.
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

/// `POST /app/v1/tts/uninstall-model` — delete a downloaded Piper model.
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

// --- /app/v1/llm/claude_proxy/complete ----------------------------------------

// --- /app/v1/providers + /app/v1/models/<provider> -------------------------------

/// `GET /app/v1/providers` — claude / ollama probes + env-var checks for the
/// API-key providers. The TS UI uses only `{available, installed?, hint?}` per
/// provider plus `ollama.models`, so the elaborate Ollama tier/recommendation
/// system is intentionally omitted (see `crate::providers`).
async fn providers() -> Json<Value> {
    let v = tokio::task::spawn_blocking(crate::providers::providers)
        .await
        .unwrap_or_else(|_| json!({}));
    Json(v)
}

/// `GET /app/v1/models/{provider}` — the provider's live model list. The UI
/// forwards the user's BYOK key as `x-provider-key` (it never leaves loopback);
/// OpenRouter needs none and claude_proxy is static. See `providers::models`.
async fn models(
    axum::extract::Path(provider): axum::extract::Path<String>,
    headers: axum::http::HeaderMap,
) -> Json<Value> {
    let key = headers
        .get("x-provider-key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    // The upstream list fetches are synchronous (ureq) — keep them off the
    // async reactor, same as providers().
    let v = tokio::task::spawn_blocking(move || crate::providers::models(&provider, key.as_deref()))
        .await
        .unwrap_or_else(|_| json!([]));
    Json(v)
}

/// `POST /app/v1/google-oauth` — desktop Google sign-in via the loopback PKCE
/// flow (meditation-pal-fae). Opens the system browser, catches the redirect on
/// an ephemeral 127.0.0.1 port, and returns `{code, codeVerifier, redirectUri}`
/// for the UI to finish at the hosted `/cloud/v1/auth/google/desktop` (which
/// holds the client secret). The (public) client id comes from the UI's cloud
/// `/config`. Long-lived: it waits for the user to finish in the browser.
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

/// `POST /app/v1/ollama/pull` — stream a model pull as NDJSON progress lines,
/// shaped the way the settings UI expects.
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

/// `POST /app/v1/ollama/delete` — remove a pulled model. Returns `{ ok: true }`
/// on success or `{ error: "…" }` with a 502 on failure.
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
/// events back as NDJSON (one JSON object per line). `f` receives a `send`
/// closure to emit `{status: ...}` events; the stream ends when `f` returns.
/// Shared by the Ollama restart/upgrade/install handlers.
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

/// `POST /app/v1/ollama/restart` — stop and restart the local Ollama daemon,
/// streaming progress until the version endpoint answers again.
async fn ollama_restart() -> Response {
    ndjson_stream(|send| crate::ollama_tools::restart_stream(send))
}

/// `POST /app/v1/ollama/upgrade` — upgrade an existing Ollama install (brew on
/// macOS, install.sh on Linux). Returns 400 + a download URL where there's no
/// automatic path (Windows, or macOS without Homebrew); otherwise streams.
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

/// `POST /app/v1/install/{tool}` — install an external tool (only `ollama` in
/// the desktop build; Piper is compiled in). Streams progress; 400 + download
/// URL when there's no automatic path.
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

/// Reveal a filesystem path in the platform file browser (Finder / Explorer /
/// xdg). Detached spawn — the user just wants the window to appear.
fn reveal_path(path: &Path) -> std::io::Result<()> {
    use std::process::Command;
    let _ = std::fs::create_dir_all(path); // best-effort — the dir may not exist yet
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

/// `POST /app/v1/open-config-folder` — reveal the app's data directory (where
/// models and any future on-disk state live). The TS UI also pings this route
/// with `OPTIONS` to decide whether the "Open config folder" button is
/// available; axum returns 405 for a method-not-allowed, which the detector
/// counts as "route exists" — so registering the POST is enough.
async fn open_config_folder(State(state): State<Shared>) -> (StatusCode, Json<Value>) {
    open_dir_response(&state.data_dir)
}

/// `POST /app/v1/open-sessions-folder` — reveal the on-disk session-logs dir
/// (created on first save). In a desktop build the TS UI persists each session
/// as a JSON file here, so this opens the folder the user actually wants.
async fn open_sessions_folder(State(state): State<Shared>) -> (StatusCode, Json<Value>) {
    open_dir_response(&state.sessions_dir)
}

// --- /app/v1/sessions — on-disk session logs (desktop persistence) ------------

/// Session ids are `YYYY-MM-DD-HHMMSS`, but the client is untrusted, so allow
/// only a safe filename charset — this is what keeps `{id}` from escaping the
/// sessions dir (`..`, `/`, NUL, etc. are all rejected).
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

/// `GET /app/v1/sessions` — list saved session ids (filenames sans `.json`).
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

/// `GET /app/v1/sessions/{id}` — read one session's JSON (404 if absent).
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

/// `PUT /app/v1/sessions/{id}` — write one session's JSON (body is the state).
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

/// `DELETE /app/v1/sessions/{id}` — remove one session's JSON (idempotent).
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

/// `POST /app/v1/open-voice-settings` — open macOS System Settings to the Spoken
/// Content pane (where Premium voices are installed). macOS-only; other OSes
/// get a 400 so the UI can hide or fail-soft.
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

/// `POST /app/v1/llm/claude_proxy/complete` — run one `claude` CLI completion for
/// the "Anthropic (Subscription)" provider. Desktop-only by nature (needs the
/// authenticated CLI). See `crate::llm`.
/// `POST /app/v1/llm/anthropic/messages` — relay an Anthropic Messages request
/// upstream (the webview can't reach Anthropic directly — no CORS). The user's
/// key arrives as `x-api-key` (the UI forwards its bring-your-own key over
/// loopback); a server-side `ANTHROPIC_API_KEY` is the dev/parity fallback.
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

/// `GET /app/v1/llm/claude_proxy/probe?model=<id>` — is the local Claude
/// subscription actually able to serve `<id>` right now? Runs a tiny cached
/// probe against the `claude` CLI (see `crate::llm::claude_probe`) so the UI can
/// grey out a model Anthropic has pulled from the subscription (e.g. Fable)
/// before offering it. Returns `{model, status}` with status one of
/// available/unavailable/cli_missing/unknown.
async fn llm_claude_proxy_probe(
    State(state): State<Shared>,
    Query(q): Query<ProbeQuery>,
) -> Response {
    let model = q.model.unwrap_or_default();
    if model.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "model required" })))
            .into_response();
    }
    // Same app-owned scratch cwd as the completion path, for the same reasons
    // (no untrusted CLAUDE.md pickup, no macOS file prompt).
    let cwd = state.data_dir.join("claude-cwd");
    let _ = std::fs::create_dir_all(&cwd);
    let body = crate::llm::claude_probe(&model, &cwd).await;
    (StatusCode::OK, Json(body)).into_response()
}

async fn llm_claude_proxy_complete(
    State(state): State<Shared>,
    Json(req): Json<crate::llm::CompleteRequest>,
) -> Response {
    // A dedicated empty scratch dir for the CLI's cwd: app-owned + per-user
    // (under the app data dir), so no untrusted CLAUDE.md/.claude can be planted
    // the way a shared world-writable temp dir would allow, and not under
    // Documents/home so the CLI's project scan doesn't trip a macOS file prompt.
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
) -> Result<(String, f64), String> {
    // The TS client always sends 16 kHz mono f32 (it downsamples before POST),
    // which is what whisper.cpp wants; guard the assumption rather than resample.
    if sample_rate != TARGET_SAMPLE_RATE {
        return Err(format!(
            "expected {TARGET_SAMPLE_RATE} Hz audio, got {sample_rate} Hz"
        ));
    }

    let mut wstate = ctx.create_state().map_err(|e| e.to_string())?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
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
