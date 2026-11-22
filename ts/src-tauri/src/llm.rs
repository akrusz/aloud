//! Desktop LLM bridge, serving `/app/v1/llm/claude_proxy/complete` and
//! `/probe`.
//!
//! The webview can't shell out, so the embedded server does: spawn
//! `claude -p … --output-format json` and return the `{text, finish_reason,
//! tokens_used}` shape the TS `ClaudeProxyHttpProvider` expects.

use std::collections::HashMap;
use std::path::Path;
use std::process::{Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
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

    let model = req.model.as_deref().filter(|s| !s.is_empty()).unwrap_or(DEFAULT_MODEL);
    let mut tail = Vec::new();
    if let Some(system) = req.system.as_deref().filter(|s| !s.is_empty()) {
        tail.extend(["--system-prompt".to_string(), system.to_string()]);
    }
    // `--` ends the options. A lone user turn is passed verbatim, and without
    // it one starting with a dash was parsed as a CLI option (`--help` printed
    // the usage; `--settings`/`--mcp-config` take inline config).
    tail.extend(["--".to_string(), format_history(&req.messages)]);

    let output = match run_claude(&binary, cwd, model, &tail, TIMEOUT).await {
        Ok(o) => o,
        Err(RunError::Spawn(e)) => {
            return Err(ProxyError::new(500, format!("failed to run claude: {e}")))
        }
        Err(RunError::Timeout) => return Err(ProxyError::new(504, "claude CLI timed out")),
    };

    if !output.status.success() {
        return Err(ProxyError::new(
            500,
            format!("claude CLI failed ({}): {}", output.status, cli_failure_detail(&output)),
        ));
    }

    let data: Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| ProxyError::new(500, format!("claude CLI returned invalid JSON: {e}")))?;

    if is_error(&data) {
        let detail = error_detail(&data).unwrap_or("unknown");
        return Err(ProxyError::new(500, format!("claude CLI error: {detail}")));
    }

    let tokens_used = data.get("usage").map(|u| {
        u["input_tokens"].as_u64().unwrap_or(0) + u["output_tokens"].as_u64().unwrap_or(0)
    });
    Ok(json!({
        "text": data["result"].as_str().unwrap_or(""),
        "finish_reason": data["stop_reason"],
        "tokens_used": tokens_used,
    }))
}

/// The `claude -p` invocation shared by completions and probes, taking `model`
/// and printing JSON. `cwd` is an app-owned, per-user scratch dir (under the
/// app data dir) - never the .app's launch cwd, never a world-writable temp dir:
///   - the CLI reads CLAUDE.md/.claude from its working dir, so an empty
///     app-owned dir blocks config injection (on a shared /tmp another local
///     user could plant config the CLI would obey);
///   - it's outside home/Documents, so the CLI's first-run project scan
///     doesn't trip the macOS "allow access to your files" prompt.
///
/// The cwd can't keep out the user's own Claude Code setup (their hooks,
/// ~/.claude/CLAUDE.md): `safe_mode` does, and `run_claude` decides it.
fn claude_command(binary: &Path, cwd: &Path, model: &str, safe_mode: bool) -> Command {
    let mut cmd = Command::new(binary);
    cmd.current_dir(cwd)
        .args(["-p", "--tools", "", "--no-session-persistence", "--disable-slash-commands"])
        // `--tools ""` only drops the built-in tools: without this the user's
        // MCP servers and claude.ai connectors are still included, every tool
        // definition in every turn (32,604 input tokens against 579 for a
        // two-word prompt, measured 2026-10-11) and callable mid-session.
        .arg("--strict-mcp-config")
        .args(["--output-format", "json", "--model", model]);
    if safe_mode {
        // Leaves out the user's hooks, every CLAUDE.md (~/.claude/CLAUDE.md
        // too, which no cwd avoids), their plugins and auto-memory; sign-in,
        // settings and `--model` are untouched. Without it a SessionStart
        // hook's output and the global CLAUDE.md sat in front of the
        // facilitator in every turn (1,853 input tokens against 625 for a
        // two-word turn, measured 2026-11-22). `--bare` drops these too but
        // signs in only with an API key, so it would lose the subscription.
        cmd.arg("--safe-mode");
    }
    // tokio's `output()`, unlike std's, inherits stdin. On a pipe that never
    // closes (a dev run started from a script) the CLI waits 3 s for stdin
    // data before every turn.
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // On timeout the `output()` future is dropped mid-flight; without this
        // the CLI is orphaned and keeps burning quota in the background.
        .kill_on_drop(true);
    cmd
}

/// Set once the installed CLI has rejected `--safe-mode` (the flag arrived in
/// Claude Code 2.1.169), so later calls leave it out instead of failing first.
/// It lasts for the app's run: a CLI upgraded meanwhile gets the flag after a
/// relaunch.
static SAFE_MODE_REJECTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug)]
enum RunError {
    Spawn(std::io::Error),
    Timeout,
}

/// Run `claude_command` followed by `tail` (system prompt, prompt) within
/// `limit`, with `--safe-mode` unless this CLI has rejected it. A CLI too old
/// for the flag exits at once (about 0.1 s, no quota) on the unknown option;
/// that run is repeated without it and the rejection remembered, so an old CLI
/// costs the isolation, never the turn.
async fn run_claude(
    binary: &Path,
    cwd: &Path,
    model: &str,
    tail: &[String],
    limit: Duration,
) -> Result<Output, RunError> {
    run_claude_with(&SAFE_MODE_REJECTED, binary, cwd, model, tail, limit).await
}

async fn run_claude_with(
    rejected: &AtomicBool,
    binary: &Path,
    cwd: &Path,
    model: &str,
    tail: &[String],
    limit: Duration,
) -> Result<Output, RunError> {
    let attempts = async {
        let safe_mode = !rejected.load(Ordering::Relaxed);
        let mut cmd = claude_command(binary, cwd, model, safe_mode);
        let output = cmd.args(tail).output().await?;
        if !(safe_mode && rejects_safe_mode(&output)) {
            return Ok(output);
        }
        rejected.store(true, Ordering::Relaxed);
        let mut cmd = claude_command(binary, cwd, model, false);
        cmd.args(tail).output().await
    };
    match timeout(limit, attempts).await {
        Ok(Ok(o)) => Ok(o),
        Ok(Err(e)) => Err(RunError::Spawn(e)),
        Err(_) => Err(RunError::Timeout),
    }
}

/// Did the CLI fail because it doesn't know `--safe-mode`? Its option parser
/// (commander) exits 1 with `error: unknown option '--safe-mode'` on stderr,
/// sometimes followed by a "(Did you mean ...?)" line.
fn rejects_safe_mode(output: &Output) -> bool {
    if output.status.success() {
        return false;
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    stderr.contains("unknown option") && stderr.contains("--safe-mode")
}

/// The CLI can report failure in-band (`is_error`), even on a zero exit.
fn is_error(v: &Value) -> bool {
    v["is_error"].as_bool().unwrap_or(false)
}

fn error_detail(v: &Value) -> Option<&str> {
    v.get("result").or_else(|| v.get("api_error_status")).and_then(Value::as_str)
}

/// Error string of a failed CLI run: stderr, or when that's empty (with
/// `--output-format json` the CLI puts usage-limit/auth/API errors in a JSON
/// `result` on stdout) the stdout result.
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
/// takes. A leading system turn is dropped (`--system-prompt` carries it); a
/// later one is a mid-sit note (a phase change, a setting, a timer event) and
/// goes inline as user text, the same wrapping as core's `formatHistory`
/// (`ts/src/llm/claude-proxy.ts`, `systemNoteAsUserText`). A lone user turn is
/// verbatim; otherwise turns become a `User:`/`Assistant:` transcript.
fn format_history(messages: &[Msg]) -> String {
    let convo: Vec<(&str, String)> = messages
        .iter()
        .enumerate()
        .filter(|(i, m)| !(*i == 0 && m.role == "system"))
        .map(|(_, m)| {
            if m.role == "system" {
                ("user", format!("<system-reminder>\n{}\n</system-reminder>", m.content))
            } else {
                (m.role.as_str(), m.content.clone())
            }
        })
        .collect();
    if convo.is_empty() {
        return String::new();
    }
    if convo.len() == 1 && convo[0].0 == "user" {
        return convo[0].1.clone();
    }
    convo
        .iter()
        .map(|(role, content)| {
            let role = if *role == "user" { "User" } else { "Assistant" };
            format!("{role}: {content}")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

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
    let Ok(binary) = which::which("claude") else {
        return ProbeStatus::CliMissing;
    };
    let tail = ["Reply with just: ok".to_string()];
    let output = match run_claude(&binary, cwd, model, &tail, PROBE_TIMEOUT).await {
        Ok(o) => o,
        // Couldn't launch or timed out: inconclusive, not a removal.
        Err(_) => return ProbeStatus::Unknown,
    };

    if !output.status.success() {
        return classify_probe_detail(&cli_failure_detail(&output));
    }
    match serde_json::from_slice::<Value>(&output.stdout) {
        Ok(v) if is_error(&v) => classify_probe_detail(error_detail(&v).unwrap_or("")),
        _ => ProbeStatus::Available,
    }
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
    fn leading_system_turn_is_dropped_from_prompt() {
        let h = format_history(&[msg("system", "be calm"), msg("user", "hi")]);
        assert_eq!(h, "hi");
    }

    // A system turn inside the conversation is a mid-sit note. Dropping it
    // (as this did) meant a Claude Subscription sit on desktop never saw a
    // phase change or a setting note.
    #[test]
    fn mid_conversation_system_turn_goes_inline_as_user_text() {
        let h = format_history(&[
            msg("user", "hi"),
            msg("assistant", "hello"),
            msg("system", "phase: ask"),
            msg("user", "more"),
        ]);
        assert_eq!(
            h,
            "User: hi\n\nAssistant: hello\n\n\
             User: <system-reminder>\nphase: ask\n</system-reminder>\n\nUser: more"
        );
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

    fn args_of(cmd: &Command) -> Vec<String> {
        cmd.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn safe_mode_flag_is_the_only_difference() {
        let cmd = |safe| claude_command(Path::new("claude"), Path::new("."), "haiku", safe);
        let with = args_of(&cmd(true));
        let without = args_of(&cmd(false));
        assert_eq!(
            without,
            [
                "-p", "--tools", "", "--no-session-persistence", "--disable-slash-commands",
                "--strict-mcp-config", "--output-format", "json", "--model", "haiku",
            ]
        );
        assert_eq!(with.iter().filter(|a| *a == "--safe-mode").count(), 1);
        let rest: Vec<String> = with.into_iter().filter(|a| a != "--safe-mode").collect();
        assert_eq!(rest, without);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_safe_mode_only_on_the_parser_error_for_it() {
        assert!(rejects_safe_mode(&failed_output("", "error: unknown option '--safe-mode'\n")));
        assert!(rejects_safe_mode(&failed_output(
            "",
            "error: unknown option '--safe-mode'\n(Did you mean --some-mode?)\n",
        )));
        assert!(!rejects_safe_mode(&failed_output("", "error: unknown option '--effort'\n")));
        assert!(!rejects_safe_mode(&failed_output(
            "{\"is_error\": true, \"result\": \"Claude usage limit reached\"}",
            "",
        )));
        let mut ok = failed_output("{}", "error: unknown option '--safe-mode'");
        ok.status = {
            use std::os::unix::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(0)
        };
        assert!(!rejects_safe_mode(&ok));
    }

    /// A stand-in `claude` in its own temp dir that appends each run's args to
    /// `calls.log` and prints a JSON result. With `old` it rejects
    /// `--safe-mode` the way a CLI older than 2.1.169 does.
    #[cfg(unix)]
    fn fake_cli(name: &str, old: bool) -> (std::path::PathBuf, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir()
            .join(format!("aloud-llm-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("calls.log");
        let reject = if old {
            r#"for a in "$@"; do if [ "$a" = --safe-mode ]; then echo "error: unknown option '--safe-mode'" >&2; exit 1; fi; done"#
        } else {
            ""
        };
        let script = format!(
            "#!/bin/sh\necho \"$*\" >> '{}'\n{reject}\nprintf '%s' '{{\"result\":\"ok\"}}'\n",
            log.display()
        );
        let bin = dir.join("claude");
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        (bin, log)
    }

    #[cfg(unix)]
    async fn run_fake(rejected: &AtomicBool, bin: &Path) -> Output {
        let tail = ["--".to_string(), "hi".to_string()];
        let out = run_claude_with(rejected, bin, bin.parent().unwrap(), "haiku", &tail, TIMEOUT)
            .await
            .expect("fake CLI ran");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout), "{\"result\":\"ok\"}");
        out
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn current_cli_gets_safe_mode() {
        let (bin, log) = fake_cli("current", false);
        let rejected = AtomicBool::new(false);
        run_fake(&rejected, &bin).await;
        assert!(!rejected.load(Ordering::Relaxed));
        let calls = std::fs::read_to_string(&log).unwrap();
        assert_eq!(calls.lines().count(), 1);
        assert!(calls.contains("--safe-mode") && calls.contains(" -- hi"));
        let _ = std::fs::remove_dir_all(bin.parent().unwrap());
    }

    // An old CLI fails every turn on an unknown flag, which is far worse than
    // the leak the flag closes: the turn is rerun without it, and later turns
    // leave it out from the start.
    #[cfg(unix)]
    #[tokio::test]
    async fn old_cli_runs_without_safe_mode_and_is_remembered() {
        let (bin, log) = fake_cli("old", true);
        let rejected = AtomicBool::new(false);
        run_fake(&rejected, &bin).await;
        assert!(rejected.load(Ordering::Relaxed));
        run_fake(&rejected, &bin).await;
        let calls = std::fs::read_to_string(&log).unwrap();
        let calls: Vec<&str> = calls.lines().collect();
        assert_eq!(calls.len(), 3, "{calls:?}");
        assert!(calls[0].contains("--safe-mode"));
        assert!(!calls[1].contains("--safe-mode") && calls[1].ends_with(" -- hi"));
        assert!(!calls[2].contains("--safe-mode") && calls[2].ends_with(" -- hi"));
        let _ = std::fs::remove_dir_all(bin.parent().unwrap());
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

    /// Live check that the user's own Claude Code setup stays out of the
    /// facilitator's conversation: the model quotes what came before the
    /// prompt, and a hook's output or a CLAUDE.md must not be in it. Telling
    /// only on a machine with a global CLAUDE.md or a SessionStart hook. Spends
    /// subscription quota, so ignored by default; run with
    /// `cargo test claude_cli_leaves_out_user_setup -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn claude_cli_leaves_out_user_setup() {
        let binary = which::which("claude").expect("claude on PATH");
        let tail = [
            "--system-prompt",
            "Answer literally and briefly.",
            "--",
            "Quote the first three lines of each block of text you were given before \
             this message, apart from the system prompt. If there is none, reply NONE.",
        ]
        .map(String::from);
        let out = run_claude(&binary, &std::env::temp_dir(), "haiku", &tail, TIMEOUT)
            .await
            .expect("claude ran");
        let data: Value = serde_json::from_slice(&out.stdout).expect("claude printed JSON");
        let input: u64 = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
            .iter()
            .map(|k| data["usage"][k].as_u64().unwrap_or(0))
            .sum();
        let reply = data["result"].as_str().unwrap_or("");
        println!("input tokens: {input}\nreply: {reply}");
        let lower = reply.to_lowercase();
        for tell in ["claude.md", "sessionstart", "hook"] {
            assert!(!lower.contains(tell), "the user's setup reached the model ({tell}): {reply}");
        }
    }
}
