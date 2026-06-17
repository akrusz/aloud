//! Desktop LLM bridge — runs the local `claude` CLI for subscription routing,
//! serving `/app/v1/llm/claude_proxy/complete`.
//!
//! The browser/webview can't shell out, so the embedded server does it: spawn
//! `claude -p … --output-format json`, parse the result, and return the same
//! `{text, finish_reason, tokens_used}` shape the TS `ClaudeProxyHttpProvider`
//! already expects.

use std::process::Stdio;
use std::time::Duration;

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
    // Accepted for wire-compatibility; the `claude` CLI has no max-tokens flag,
    // so it's not forwarded.
    #[serde(default)]
    #[allow(dead_code)]
    max_tokens: Option<u32>,
}

#[derive(Deserialize)]
struct Msg {
    role: String,
    content: String,
}

/// An error carrying the HTTP status the handler should return. 503 means the
/// `claude` CLI is missing or unauthenticated (the TS client renders that as a
/// friendly "install Claude Code" message).
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

/// Run one `claude` completion. Returns the `{text, finish_reason,
/// tokens_used}` JSON body on success.
pub async fn claude_complete(req: CompleteRequest) -> Result<Value, ProxyError> {
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
    // Run from a neutral temp dir, not the cwd the .app happened to launch with.
    // A facilitation turn needs no project context (the system prompt is passed
    // via --system-prompt), and letting the CLI scan the inherited working dir
    // for CLAUDE.md/.claude on first run is what triggers the macOS "allow
    // access to your files" prompt mid-session. temp_dir is app-accessible and
    // not a TCC-protected location, so no consent dialog fires.
    cmd.current_dir(std::env::temp_dir());
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
    // On timeout the `cmd.output()` future is dropped mid-flight — without this
    // the spawned CLI would be orphaned and keep burning quota in the background.
    cmd.kill_on_drop(true);

    let output = match timeout(TIMEOUT, cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(ProxyError::new(500, format!("failed to run claude: {e}"))),
        Err(_) => return Err(ProxyError::new(504, "claude CLI timed out")),
    };

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(ProxyError::new(
            500,
            format!("claude CLI failed (exit {}): {}", output.status, err.trim()),
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

/// Encode multi-turn history as the single prompt string the `claude` CLI
/// takes. System turns are dropped (the system prompt goes via
/// `--system-prompt`); a lone user turn is sent verbatim; otherwise prior turns
/// become a `User:`/`Assistant:` transcript.
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

// --- Anthropic proxy --------------------------------------------------------

const ANTHROPIC_API_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION: &str = "2023-06-01";
/// Cap on the forwarded prompt+history payload.
pub const MAX_PROXY_BYTES: usize = 1024 * 1024;

/// A pass-through of Anthropic's HTTP response: its status and body survive
/// verbatim so the client sees real error detail instead of a masked 5xx.
pub struct ProxyResponse {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

/// Forward a raw Anthropic Messages request body upstream, injecting the API
/// version and the given key. Serves `/app/v1/llm/anthropic/messages`: the
/// webview can't call Anthropic directly (no CORS), so the embedded server
/// relays it. The key comes from the caller, so the desktop UI can forward the
/// user's bring-your-own key (it never leaves the loopback). Synchronous
/// (ureq); call from `spawn_blocking`.
pub fn anthropic_proxy(body: Vec<u8>, api_key: &str) -> Result<ProxyResponse, ProxyError> {
    use std::io::Read;

    let agent: ureq::Agent = ureq::Agent::config_builder()
        // Keep 4xx/5xx as normal responses so we can pass the upstream status
        // and JSON error body straight back to the client.
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

    /// Real `claude` CLI round-trip — needs the authenticated CLI and spends
    /// subscription quota, so ignored by default. Run with
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
        let body = claude_complete(req).await.expect("claude completion");
        let text = body.get("text").and_then(|v| v.as_str()).unwrap_or("");
        assert!(!text.is_empty(), "empty completion text");
        // tokens_used should be a positive number from the usage block.
        assert!(body.get("tokens_used").and_then(|v| v.as_u64()).unwrap_or(0) > 0);
    }
}
