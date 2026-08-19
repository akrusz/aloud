//! Desktop LLM bridge, serving `/app/v1/llm/claude_proxy/complete` plus an
//! Anthropic HTTP relay.
//!
//! The webview can't shell out, so the embedded server does: spawn
//! `claude -p … --output-format json` and return the `{text, finish_reason,
//! tokens_used}` shape the TS `ClaudeProxyHttpProvider` expects.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::process::Command;
use tokio::time::timeout;

const DEFAULT_MODEL: &str = "sonnet";
const TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Deserialize)]
pub struct CompleteRequest {
    #[serde(default)]
    messages: Vec<Msg>,
    #[serde(default)]
    system: Option<String>,
    #[serde(default)]
    model: Option<String>,
    // Wire-compatibility only: the `claude` CLI has no max-tokens flag.
    #[serde(default)]
    #[allow(dead_code)]
    max_tokens: Option<u32>,
}

#[derive(Deserialize)]
struct Msg {
    role: String,
    content: String,
}

/// Error carrying the HTTP status the handler should return. 503 means the
/// `claude` CLI is missing or unauthenticated; the TS client renders that as an
/// "install Claude Code" message.
#[derive(Debug)]
pub struct ProxyError {
    pub status: u16,
    pub message: String,
}

impl ProxyError {
    fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }
}

/// Run one `claude` completion, returning the `{text, finish_reason,
/// tokens_used}` JSON body.
pub async fn claude_complete(req: CompleteRequest, cwd: &Path) -> Result<Value, ProxyError> {
    if !req.messages.iter().all(|m| {
        matches!(m.role.as_str(), "user" | "assistant" | "system")
    }) {
        return Err(ProxyError::new(400, "message missing valid role/content"));
    }

    let binary = which::which("claude").map_err(|_| {
        ProxyError::new(
            503,
            "claude CLI not found on PATH. Install Claude Code to use the \
             Anthropic Subscription provider.",
        )
    })?;

    let prompt = format_history(&req.messages);
    let model = req.model.as_deref().filter(|s| !s.is_empty()).unwrap_or(DEFAULT_MODEL);

    let mut cmd = Command::new(binary);
    // An app-owned, per-user scratch dir (under the app data dir) - never the
    // .app's launch cwd, never a world-writable temp dir:
    //   - the CLI reads CLAUDE.md/.claude from its working dir, so an empty
    //     app-owned dir blocks config injection (on a shared /tmp another local
    //     user could plant config the CLI would obey);
    //   - it's outside home/Documents, so the CLI's first-run project scan
    //     doesn't trip the macOS "allow access to your files" prompt.
    cmd.current_dir(cwd);
    cmd.arg("-p")
        .arg("--tools")
        .arg("")
        .arg("--no-session-persistence")
        .arg("--disable-slash-commands")
        .arg("--output-format")
        .arg("json")
        .arg("--model")
        .arg(model);
    if let Some(system) = req.system.as_deref().filter(|s| !s.is_empty()) {
        cmd.arg("--system-prompt").arg(system);
    }
    cmd.arg(&prompt);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    // On timeout the `cmd.output()` future is dropped mid-flight; without this
    // the CLI is orphaned and keeps burning quota in the background.
    cmd.kill_on_drop(true);

    let output = match timeout(TIMEOUT, cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(ProxyError::new(500, format!("failed to run claude: {e}"))),
        Err(_) => return Err(ProxyError::new(504, "claude CLI timed out")),
    };

    if !output.status.success() {
        return Err(ProxyError::new(
            500,
            format!("claude CLI failed ({}): {}", output.status, cli_failure_detail(&output)),
        ));
    }

    let data: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| ProxyError::new(500, format!("claude CLI returned invalid JSON: {e}")))?;

    if data.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
        let detail = data
            .get("result")
            .or_else(|| data.get("api_error_status"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        return Err(ProxyError::new(500, format!("claude CLI error: {detail}")));
    }

    let text = data.get("result").and_then(Value::as_str).unwrap_or("");
    let finish_reason = data.get("stop_reason").cloned().unwrap_or(Value::Null);
    let tokens_used = match data.get("usage") {
        Some(u) => {
            let input = u.get("input_tokens").and_then(Value::as_u64).unwrap_or(0);
            let output = u.get("output_tokens").and_then(Value::as_u64).unwrap_or(0);
            json!(input + output)
        }
        None => Value::Null,
    };

    Ok(json!({
        "text": text,
        "finish_reason": finish_reason,
        "tokens_used": tokens_used,
    }))
}

/// The error string of a failed (non-zero exit) CLI run. Usually stderr - but
/// with `--output-format json` the CLI reports usage limits, expired OAuth
/// tokens, and API errors as a JSON `result` on STDOUT and exits 1 with
/// stderr empty, which used to reach the user as "claude CLI failed (exit
/// status: 1):" with nothing after the colon (Robin's 2.6.3 report).
fn cli_failure_detail(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stderr = stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stdout = stdout.trim();
    if let Ok(v) = serde_json::from_str::<Value>(stdout) {
        if let Some(result) = v.get("result").and_then(Value::as_str) {
            return result.to_string();
        }
    }
    stdout.chars().take(400).collect()
}

/// Encode multi-turn history as the single prompt string the `claude` CLI
/// takes. System turns are dropped (they go via `--system-prompt`); a lone user
/// turn is verbatim; otherwise turns become a `User:`/`Assistant:` transcript.
fn format_history(messages: &[Msg]) -> String {
    let convo: Vec<&Msg> = messages.iter().filter(|m| m.role != "system").collect();
    if convo.is_empty() {
        return String::new();
    }
    if convo.len() == 1 && convo[0].role == "user" {
        return convo[0].content.clone();
    }
    convo
        .iter()
        .map(|m| {
            let role = if m.role == "user" { "User" } else { "Assistant" };
            format!("{role}: {}", m.content)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

// --- Subscription model availability probe ----------------------------------

/// Shorter than a real turn: a hung probe is inconclusive, not worth 90s.
const PROBE_TIMEOUT: Duration = Duration::from_secs(25);
/// How long a verdict stays trusted. Long enough to avoid spending quota on
/// every picker open, short enough to notice a mid-day removal.
const PROBE_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Copy, PartialEq, Eq)]
enum ProbeStatus {
    /// The subscription served the model.
    Available,
    /// Removed from, or never on, this subscription.
    Unavailable,
    /// No `claude` CLI, so the whole provider is unusable.
    CliMissing,
    /// Inconclusive (timeout, rate limit, transient/auth error): don't act on it.
    Unknown,
}

impl ProbeStatus {
    fn as_str(self) -> &'static str {
        match self {
            ProbeStatus::Available => "available",
            ProbeStatus::Unavailable => "unavailable",
            ProbeStatus::CliMissing => "cli_missing",
            ProbeStatus::Unknown => "unknown",
        }
    }
}

fn probe_cache() -> &'static Mutex<HashMap<String, (Instant, ProbeStatus)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, ProbeStatus)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Can the local Claude subscription serve `model` right now? Runs a one-word
/// completion and classifies the outcome, caching definitive verdicts for
/// PROBE_TTL so repeated picker opens don't each spend quota. Returns
/// `{model, status}`; anything ambiguous is `unknown`, which the UI treats as
/// "leave the model shown".
pub async fn claude_probe(model: &str, cwd: &Path) -> Value {
    if let Some((at, status)) = probe_cache().lock().unwrap().get(model).copied() {
        if at.elapsed() < PROBE_TTL {
            return json!({ "model": model, "status": status.as_str() });
        }
    }
    let status = run_probe(model, cwd).await;
    // Only definitive verdicts: a transient `unknown` shouldn't pin the model
    // as good-or-bad, so let the next call re-probe.
    if status != ProbeStatus::Unknown {
        probe_cache()
            .lock()
            .unwrap()
            .insert(model.to_string(), (Instant::now(), status));
    }
    json!({ "model": model, "status": status.as_str() })
}

async fn run_probe(model: &str, cwd: &Path) -> ProbeStatus {
    let binary = match which::which("claude") {
        Ok(b) => b,
        Err(_) => return ProbeStatus::CliMissing,
    };
    let mut cmd = Command::new(binary);
    cmd.current_dir(cwd);
    cmd.arg("-p")
        .arg("--tools")
        .arg("")
        .arg("--no-session-persistence")
        .arg("--disable-slash-commands")
        .arg("--output-format")
        .arg("json")
        .arg("--model")
        .arg(model)
        .arg("Reply with just: ok");
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    let output = match timeout(PROBE_TIMEOUT, cmd.output()).await {
        Ok(Ok(o)) => o,
        // Couldn't launch or timed out: inconclusive, not a removal.
        Ok(Err(_)) | Err(_) => return ProbeStatus::Unknown,
    };

    if output.status.success() {
        // A zero exit can still carry an in-band `is_error` payload.
        if let Ok(v) = serde_json::from_slice::<Value>(&output.stdout) {
            if v.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
                let detail = v
                    .get("result")
                    .or_else(|| v.get("api_error_status"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                return classify_probe_detail(detail);
            }
        }
        return ProbeStatus::Available;
    }
    classify_probe_detail(&cli_failure_detail(&output))
}

/// Map a CLI error string to a verdict. Only a clear model-availability signal
/// counts as `Unavailable`; everything else stays `Unknown` so a rate limit or
/// auth blip can't masquerade as a removed model. The CLI's wording for a
/// pulled model isn't contractual, so widen the match as strings are observed.
fn classify_probe_detail(detail: &str) -> ProbeStatus {
    let d = detail.to_lowercase();
    let model_availability = d.contains("model")
        && (d.contains("not available")
            || d.contains("unavailable")
            || d.contains("not found")
            || d.contains("does not exist")
            || d.contains("not supported")
            || d.contains("no access")
            || d.contains("not allowed")
            || d.contains("invalid model"));
    if model_availability || d.contains("not_found_error") {
        ProbeStatus::Unavailable
    } else {
        ProbeStatus::Unknown
    }
}

// --- Anthropic proxy --------------------------------------------------------

const ANTHROPIC_API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION: &str = "2023-06-01";
/// Cap on the forwarded prompt+history payload.
pub const MAX_PROXY_BYTES: usize = 1024 * 1024;

/// Pass-through of Anthropic's response: status and body survive verbatim so
/// the client sees real error detail instead of a masked 5xx.
pub struct ProxyResponse {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

/// Forward a raw Anthropic Messages body upstream with the API version and the
/// given key, serving `/app/v1/llm/anthropic/messages`: the webview can't call
/// Anthropic directly (no CORS). The key comes from the caller so the UI can
/// forward the user's BYOK key, which never leaves loopback. Synchronous
/// (ureq); call from `spawn_blocking`.
pub fn anthropic_proxy(body: Vec<u8>, api_key: &str) -> Result<ProxyResponse, ProxyError> {
    use std::io::Read;

    let agent: ureq::Agent = ureq::Agent::config_builder()
        // Keep 4xx/5xx as normal responses so the upstream status and JSON
        // error body pass straight back to the client.
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(60)))
        .build()
        .into();

    let resp = agent
        .post(ANTHROPIC_API_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_API_VERSION)
        .header("content-type", "application/json")
        .send(&body[..])
        .map_err(|e| ProxyError::new(502, format!("Upstream Anthropic request failed: {e}")))?;

    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_string();

    let mut buf = Vec::new();
    resp.into_body()
        .into_reader()
        .read_to_end(&mut buf)
        .map_err(|e| ProxyError::new(502, format!("reading Anthropic response: {e}")))?;

    Ok(ProxyResponse { status, content_type, body: buf })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> Msg {
        Msg { role: role.to_string(), content: content.to_string() }
    }

    #[test]
    fn lone_user_turn_is_verbatim() {
        assert_eq!(format_history(&[msg("user", "hello")]), "hello");
    }

    #[test]
    fn system_turns_are_dropped_from_prompt() {
        let h = format_history(&[msg("system", "be calm"), msg("user", "hi")]);
        assert_eq!(h, "hi");
    }

    #[test]
    fn multi_turn_becomes_transcript() {
        let h = format_history(&[
            msg("user", "hi"),
            msg("assistant", "hello"),
            msg("user", "more"),
        ]);
        assert_eq!(h, "User: hi\n\nAssistant: hello\n\nUser: more");
    }

    #[cfg(unix)]
    fn failed_output(stdout: &str, stderr: &str) -> std::process::Output {
        use std::os::unix::process::ExitStatusExt;
        std::process::Output {
            status: std::process::ExitStatus::from_raw(256), // exit code 1
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[cfg(unix)]
    #[test]
    fn cli_failure_detail_prefers_stderr() {
        let out = failed_output("{\"result\": \"ignored\"}", "spawn error\n");
        assert_eq!(cli_failure_detail(&out), "spawn error");
    }

    #[cfg(unix)]
    #[test]
    fn cli_failure_detail_reads_json_result_from_stdout() {
        let out = failed_output(
            "{\"is_error\": true, \"result\": \"Claude usage limit reached\"}",
            "",
        );
        assert_eq!(cli_failure_detail(&out), "Claude usage limit reached");
    }

    #[cfg(unix)]
    #[test]
    fn cli_failure_detail_falls_back_to_raw_stdout() {
        let out = failed_output("not json at all", "  ");
        assert_eq!(cli_failure_detail(&out), "not json at all");
    }

    /// Real `claude` CLI round-trip. Needs the authenticated CLI and spends
    /// subscription quota, so ignored by default; run with
    /// `cargo test claude_cli_round_trip -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn claude_cli_round_trip() {
        let req = CompleteRequest {
            messages: vec![msg("user", "Reply with exactly the word: pong")],
            system: Some("You are a test fixture. Reply with one word only.".to_string()),
            model: Some("haiku".to_string()),
            max_tokens: Some(20),
        };
        let body = claude_complete(req, &std::env::temp_dir())
            .await
            .expect("claude completion");
        let text = body.get("text").and_then(|v| v.as_str()).unwrap_or("");
        assert!(!text.is_empty(), "empty completion text");
        assert!(body.get("tokens_used").and_then(|v| v.as_u64()).unwrap_or(0) > 0);
    }
}
