//! Ollama model management: `/app/v1/ollama/pull` (streamed progress) and
//! `/app/v1/ollama/delete`, both proxied to the local daemon's HTTP API.
//!
//! Restart / upgrade / install of the daemon *itself* lives in
//! `ollama_tools.rs`, since those flows are platform-specific.

use serde::Deserialize;
use serde_json::{json, Value};

const OLLAMA_URL: &str = "http://localhost:11434";

#[derive(Deserialize)]
pub struct ModelReq {
    #[serde(default)]
    pub model: String,
}

/// Stream a pull from the daemon, calling `on_progress` once per forwarded line
/// with `{status, total?, completed?}` - the shape the settings UI's progress
/// bar expects. The caller serializes each value onto the response stream.
pub fn pull_stream<F: FnMut(Value)>(model: &str, mut on_progress: F) -> Result<(), String> {
    use std::io::{BufRead, BufReader};

    let url = format!("{OLLAMA_URL}/api/pull");
    let resp = ureq::post(&url)
        .config()
        // Pulls take minutes; only the initial connect should be quick.
        .timeout_global(Some(std::time::Duration::from_secs(600)))
        .build()
        .send_json(json!({ "model": model, "stream": true }))
        .map_err(|e| e.to_string())?;

    let reader = BufReader::new(resp.into_body().into_reader());
    for line in reader.lines() {
        let line = match line {
            Ok(l) if !l.trim().is_empty() => l,
            Ok(_) => continue,
            Err(e) => return Err(format!("read pull stream: {e}")),
        };
        let obj: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue, // skip a malformed line; Ollama is the source
        };
        // Ollama inlines errors in a 200-streamed body (e.g. 412 "requires newer
        // Ollama" arrives as a JSON `error` field). Reshape for the UI handler.
        if let Some(err) = obj.get("error").and_then(Value::as_str) {
            on_progress(json!({ "status": "error", "error": err }));
            continue;
        }
        let mut out = json!({
            "status": obj.get("status").and_then(Value::as_str).unwrap_or(""),
        });
        if let (Some(total), Some(completed)) = (obj.get("total"), obj.get("completed")) {
            out["total"] = total.clone();
            out["completed"] = completed.clone();
        }
        on_progress(out);
    }
    Ok(())
}

/// Delete a pulled model, Err carrying a 502-flavored message. Ollama's
/// `/api/delete` takes a JSON body, which ureq's typed `delete()` builder
/// forbids, hence the generic `http::Request` form via `ureq::run`.
pub fn delete(model: &str) -> Result<(), String> {
    use ureq::http::Request;
    let url = format!("{OLLAMA_URL}/api/delete");
    let body = serde_json::to_vec(&json!({ "model": model })).map_err(|e| e.to_string())?;
    let req = Request::builder()
        .method("DELETE")
        .uri(&url)
        .header("content-type", "application/json")
        .body(body)
        .map_err(|e| e.to_string())?;
    match ureq::run(req) {
        Ok(resp) if resp.status().is_success() => Ok(()),
        Ok(resp) => Err(format!("Ollama returned {}", resp.status().as_u16())),
        Err(ureq::Error::StatusCode(code)) => Err(format!("Ollama returned {code}")),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pull_stream_surfaces_bad_model() {
        // Two valid outcomes: no Ollama running → transport Err; Ollama running
        // but no such model → inline error line forwarded as a "status: error"
        // event with Ok overall. Assert one of them.
        let mut saw_error_event = false;
        let result = pull_stream("definitely-not-a-real-model:xyz", |v| {
            if v["status"] == "error" {
                saw_error_event = true;
            }
        });
        match result {
            Ok(()) => assert!(saw_error_event, "expected an error event from Ollama"),
            Err(e) => assert!(!e.is_empty(), "transport error should carry a message"),
        }
    }

    /// Real round-trip against a running Ollama. Ignored by default; run when
    /// iterating on the pull pipeline.
    #[test]
    #[ignore]
    fn pull_stream_round_trip() {
        let mut count = 0usize;
        pull_stream("qwen3.5:4b", |v| {
            count += 1;
            assert!(v["status"].is_string());
        })
        .expect("pull");
        assert!(count > 0, "no progress events received");
    }
}
