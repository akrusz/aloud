//! Ollama daemon lifecycle (restart / upgrade / install), as opposed to
//! `ollama.rs` which manages the *models*. Serves `/app/v1/ollama/restart`,
//! `/app/v1/ollama/upgrade`, `/app/v1/install/{tool}`, all streaming NDJSON
//! `{status}` lines for a live log, then `{status:"done"}` or
//! `{status:"error", error}`.
//!
//! Platform: upgrade/install use Homebrew on macOS and `install.sh` on Linux;
//! Windows has no automatic path, so the handler returns a download URL. The
//! restart dance (detect how Ollama runs, stop it, bring it back, wait for the
//! version endpoint) is Unix-only.

use serde_json::{json, Value};
use std::time::Duration;

const OLLAMA_URL: &str = "http://localhost:11434";
const DOWNLOAD_URL: &str = "https://ollama.com/download";

/// Progress sink: each `*_stream` fn emits status lines then a final done/error
/// event through it, which the handler serializes to NDJSON.
type Progress<'a> = dyn FnMut(Value) + 'a;

/// `Some(version)` means the daemon is up.
fn ping_version() -> Option<String> {
    let url = format!("{OLLAMA_URL}/api/version");
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_millis(500)))
        .build()
        .into();
    let resp = agent.get(&url).call().ok()?;
    let body: Value = serde_json::from_reader(resp.into_body().into_reader()).ok()?;
    body.get("version").and_then(Value::as_str).map(str::to_owned)
}

// --- restart ----------------------------------------------------------------

/// How Ollama runs now, so restart can bring it back the same way.
#[derive(Clone, Copy, PartialEq)]
enum RunMethod {
    /// macOS Ollama.app GUI process.
    App,
    /// Headless `ollama serve`.
    Serve,
    Unknown,
}

#[cfg(unix)]
fn detect_run_method() -> RunMethod {
    let out = std::process::Command::new("ps").args(["-Ao", "command="]).output();
    let Ok(out) = out else { return RunMethod::Unknown };
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.contains("Ollama.app/") || line.contains("/Ollama.app") {
            return RunMethod::App;
        }
        let first = line.split_whitespace().next().unwrap_or("");
        if first.ends_with("/ollama") || first == "ollama" {
            // A bare `ollama` process is almost always the daemon.
            return RunMethod::Serve;
        }
    }
    RunMethod::Unknown
}

#[cfg(target_os = "macos")]
fn has_ollama_app() -> bool {
    std::path::Path::new("/Applications/Ollama.app").is_dir()
}
#[cfg(not(target_os = "macos"))]
fn has_ollama_app() -> bool {
    false
}

/// Stop and restart the daemon, waiting for it to come back. Unix-only;
/// Windows gets a "not supported" error event.
#[cfg(unix)]
pub fn restart_stream(on: &mut Progress) {
    use std::thread::sleep;

    let running_method = detect_run_method();
    let pre_version = ping_version();

    on(json!({ "status": "Stopping Ollama..." }));

    // -i case-insensitive (matches `ollama` and `Ollama`), -x exact name.
    let _ = std::process::Command::new("pkill").args(["-i", "-x", "ollama"]).output();

    // Wait up to 10s for shutdown. If unconfirmed, bail before "starting":
    // otherwise the version poll below sees the still-running old daemon and
    // reports a false "done".
    let mut shut_down = false;
    for _ in 0..20 {
        if ping_version().is_none() {
            shut_down = true;
            break;
        }
        sleep(Duration::from_millis(500));
    }
    if !shut_down {
        on(json!({
            "status": "error",
            "error": "Could not stop the running Ollama process. It may need to be killed manually.",
        }));
        return;
    }

    on(json!({ "status": "Starting Ollama..." }));

    let ollama_bin = which::which("ollama").ok();
    let start_app = || -> bool {
        std::process::Command::new("open").args(["-a", "Ollama"]).spawn().is_ok()
    };
    let start_serve = || -> bool {
        let Some(bin) = ollama_bin.as_ref() else { return false };
        std::process::Command::new(bin)
            .arg("serve")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .is_ok()
    };

    // Prefer whatever was running; otherwise prefer the .app on macOS.
    let started = match running_method {
        RunMethod::App if has_ollama_app() => start_app() || start_serve(),
        RunMethod::Serve => {
            if has_ollama_app() {
                start_serve() || start_app()
            } else {
                start_serve()
            }
        }
        _ => {
            if has_ollama_app() {
                start_app() || start_serve()
            } else {
                start_serve()
            }
        }
    };
    if !started {
        on(json!({
            "status": "error",
            "error": "Could not restart Ollama automatically. Please start it manually.",
        }));
        return;
    }

    // Wait up to 90s: macOS may show a Gatekeeper prompt on first launch.
    for i in 0..180 {
        sleep(Duration::from_millis(500));
        if let Some(version) = ping_version() {
            let unchanged = pre_version.as_deref() == Some(version.as_str());
            let message = if unchanged && running_method == RunMethod::App {
                format!(
                    "Ollama is back up (v{version}), but the version is unchanged. \
                     Ollama.app's bundled server didn't get updated by brew. Either \
                     replace /Applications/Ollama.app with the latest from \
                     ollama.com/download, or quit Ollama.app and run `ollama serve` \
                     in a terminal to use the upgraded CLI binary."
                )
            } else {
                format!("Ollama is back up (v{version}).")
            };
            on(json!({ "status": "done", "version": version, "message": message }));
            return;
        }
        if i > 0 && i % 20 == 0 {
            let elapsed = (i + 1) / 2;
            on(json!({
                "status": format!(
                    "Still waiting for Ollama ({elapsed}s)... If you see a security prompt, click Open / Allow."
                ),
            }));
        }
    }

    on(json!({
        "status": "error",
        "error": "Ollama did not come back online within 90 seconds. If you saw a security prompt, finish it and then refresh.",
    }));
}

#[cfg(not(unix))]
pub fn restart_stream(on: &mut Progress) {
    on(json!({
        "status": "error",
        "error": "Automatic restart isn't supported on this platform. Quit and reopen Ollama manually.",
    }));
}

// --- upgrade -----------------------------------------------------------------

/// `Some((error, download_url))` when automatic upgrade isn't possible (Windows,
/// or macOS without Homebrew); the handler turns it into a 400 so the UI can
/// offer the download page. `None` → safe to stream an upgrade.
pub fn upgrade_precheck() -> Option<(String, String)> {
    if cfg!(target_os = "windows") {
        return Some((
            "Automatic upgrade not supported on Windows.".to_string(),
            DOWNLOAD_URL.to_string(),
        ));
    }
    if cfg!(target_os = "macos") && which::which("brew").is_err() {
        return Some((
            "Homebrew not found - please update from the Ollama site.".to_string(),
            DOWNLOAD_URL.to_string(),
        ));
    }
    None
}

/// Upgrade script by platform. macOS tries both the cask and the formula (a
/// user may have either); Linux re-runs the idempotent install script.
fn upgrade_script() -> &'static str {
    if cfg!(target_os = "macos") {
        "set +e; \
         has_cask=0; has_formula=0; upgraded=0; \
         if brew list --cask ollama >/dev/null 2>&1; then has_cask=1; fi; \
         if brew list --formula ollama >/dev/null 2>&1; then has_formula=1; fi; \
         if [ $has_cask -eq 1 ]; then echo \"==> Upgrading Ollama.app (cask)\"; brew upgrade --cask ollama && upgraded=1; fi; \
         if [ $has_formula -eq 1 ]; then echo \"==> Upgrading ollama CLI (formula)\"; brew upgrade ollama && upgraded=1; fi; \
         if [ $upgraded -eq 0 ]; then echo \"Ollama was not installed via Homebrew. Update from ollama.com/download.\"; exit 2; fi; \
         if [ $has_cask -eq 0 ] && [ -d /Applications/Ollama.app ]; then \
           echo \"\"; \
           echo \"WARNING: /Applications/Ollama.app exists but was not installed via Homebrew.\"; \
           echo \"Its bundled server has NOT been updated. If Ollama.app is what is running,\"; \
           echo \"download the latest from ollama.com/download and replace /Applications/Ollama.app,\"; \
           echo \"or quit Ollama.app and start a headless server with: ollama serve\"; \
         fi"
    } else {
        "curl -fsSL https://ollama.com/install.sh | sh"
    }
}

pub fn upgrade_stream(on: &mut Progress) {
    on(json!({ "status": "Upgrading Ollama..." }));
    stream_bash(
        upgrade_script(),
        on,
        "Upgrade finished. Click \"Restart Ollama\" to load the new version.",
    );
}

// --- install -----------------------------------------------------------------

/// Validate tool + platform. `Ok(())` → stream the install; `Err((status,
/// error, download_url?))` → the handler returns that status. Only `ollama` is
/// installable in the Tauri build; Piper is compiled in.
pub fn install_precheck(tool: &str) -> Result<(), (u16, String, Option<String>)> {
    if tool != "ollama" {
        return Err((400, format!("Unknown or unsupported tool: {tool}"), None));
    }
    if cfg!(target_os = "windows") {
        return Err((400, "Download Ollama manually on Windows".to_string(), Some(DOWNLOAD_URL.to_string())));
    }
    Ok(())
}

fn install_script() -> String {
    if cfg!(target_os = "macos") && which::which("brew").is_ok() {
        "brew install ollama".to_string()
    } else {
        "curl -fsSL https://ollama.com/install.sh | sh".to_string()
    }
}

pub fn install_stream(tool: &str, on: &mut Progress) {
    on(json!({ "status": format!("Installing {tool}...") }));
    stream_bash(&install_script(), on, "done");
}

// --- shared subprocess streaming --------------------------------------------

/// Run a bash script, forwarding each output line as `{status: line}`, then
/// `{status:"done", message}` (exit 0) or `{status:"error", error}`. stderr is
/// merged via `2>&1` because brew and curl write their progress there.
fn stream_bash(script: &str, on: &mut Progress, done_message: &str) {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    let merged = format!("{{ {script} ; }} 2>&1");
    let mut child = match Command::new("/bin/bash")
        .arg("-c")
        .arg(&merged)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            on(json!({ "status": "error", "error": format!("failed to start: {e}") }));
            return;
        }
    };

    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(l) if !l.trim().is_empty() => on(json!({ "status": l })),
                Ok(_) => {}
                Err(_) => break,
            }
        }
    }

    match child.wait() {
        Ok(status) if status.success() => {
            on(json!({ "status": "done", "message": done_message }))
        }
        Ok(status) => {
            let code = status.code().unwrap_or(-1);
            on(json!({ "status": "error", "error": format!("exited with code {code}") }))
        }
        Err(e) => on(json!({ "status": "error", "error": format!("wait failed: {e}") })),
    }
}
