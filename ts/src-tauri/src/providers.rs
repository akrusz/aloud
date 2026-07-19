//! Provider availability + Ollama model management for the desktop backend.
//!
//! Builds the `/app/v1/providers` and `/app/v1/models/{provider}` bodies,
//! including the Ollama recommendation block the Settings page uses to help
//! users pick local models: RAM + GPU detection, curated tier list, "fits this
//! machine" / "installed" annotations, and a version-outdated banner.

use serde_json::{json, Value};

const OLLAMA_URL: &str = "http://localhost:11434";
/// Minimum version that can pull the recommended models: below this the
/// manifest format is too old and pulls fail with HTTP 412.
const MIN_OLLAMA_VERSION: &str = "0.21.0";

/// One curated Ollama tier. Project-curated, not provider-supplied.
struct OllamaTier {
    model: &'static str,
    label: &'static str,
    min_gb: u32,
    download: &'static str,
    ram: &'static str,
    note: &'static str,
    /// `false` = visible in the picker but skipped by the auto-pick: dense
    /// models that work but are too slow to be a default recommendation.
    auto_recommend: bool,
}

const DEFAULT_TIERS: &[OllamaTier] = &[
    OllamaTier {
        model: "gemma4:31b",
        label: "Very Good But Slow",
        min_gb: 32,
        download: "~20GB",
        ram: "~24GB",
        auto_recommend: false,
        note: "Highest quality. Dense model that's excellent with nuance, but slow even on serious hardware (~15 words/sec on an M5 MacBook Pro). Only for very fast machines.",
    },
    OllamaTier {
        model: "gemma4:26b",
        label: "Good",
        min_gb: 24,
        download: "~18GB",
        ram: "~22GB",
        auto_recommend: true,
        note: "Mixture-of-experts model; rich knowledge but stays fast. Noted to have a warm conversational tone well-suited for meditation.",
    },
    OllamaTier {
        model: "gemma4:e4b",
        label: "Decent",
        min_gb: 16,
        download: "~9.6GB",
        ram: "~10GB",
        auto_recommend: true,
        note: "Google's edge model, surprisingly capable for its size. Solid balance of warmth and speed.",
    },
    OllamaTier {
        model: "qwen3.5:4b",
        label: "Acceptable",
        min_gb: 0,
        download: "~3.4GB",
        ram: "~5GB",
        auto_recommend: true,
        note: "Smallest size and fast on any hardware. Reliable choice even on systems with low memory.",
    },
];

/// `GET /app/v1/providers` body. Synchronous (shells out via `which`, probes
/// localhost, inspects RAM/GPU), so callers run it on a blocking thread.
pub fn providers() -> Value {
    let has_claude = which::which("claude").is_ok();
    let has_ollama_bin = which::which("ollama").is_ok();
    let (ollama_running, raw_models) = probe_ollama_tags();
    let ollama_version = probe_ollama_version();

    json!({
        "claude_proxy": {
            "available": has_claude,
            "installed": has_claude,
            "hint": if has_claude {
                ""
            } else {
                "The Claude Code command-line tool isn't installed. Install the \
                 CLI with `npm install -g @anthropic-ai/claude-code` - not the \
                 Claude desktop app, which can't sign in here - then run \
                 `claude` once to log in with your Pro/Max subscription."
            },
        },
        "anthropic": api_key_provider("ANTHROPIC_API_KEY"),
        "openai": api_key_provider("OPENAI_API_KEY"),
        "openrouter": api_key_provider("OPENROUTER_API_KEY"),
        "venice": api_key_provider("VENICE_API_KEY"),
        "groq": api_key_provider("GROQ_API_KEY"),
        "ollama": ollama_section(
            has_ollama_bin,
            ollama_running,
            &raw_models,
            ollama_version.as_deref(),
        ),
    })
}

/// `GET /app/v1/models/<provider>` body: `[{value, label}]` fetched live from
/// the provider's API. `api_key` is the BYOK key the UI forwards from its
/// localStorage as `x-provider-key`. OpenRouter needs no key and claude_proxy
/// is a static alias list. Any failure returns `[]`, on which the model picker
/// falls back to a free-form text input.
pub fn models(provider: &str, api_key: Option<&str>) -> Value {
    let list = match provider {
        "openai" => fetch_openai(api_key),
        "anthropic" => fetch_anthropic(api_key),
        "claude_proxy" => claude_proxy_models(),
        "openrouter" => fetch_openrouter(),
        "venice" => fetch_venice(api_key),
        "groq" => fetch_groq(api_key),
        _ => Vec::new(),
    };
    Value::Array(list)
}

/// GET a JSON body with a short timeout. `None` on any transport/parse error;
/// callers degrade to an empty model list.
fn get_json(url: &str, headers: &[(&str, &str)], timeout_secs: u64) -> Option<Value> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(timeout_secs)))
        .build()
        .into();
    let mut req = agent.get(url);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let resp = req.call().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    serde_json::from_reader(resp.into_body().into_reader()).ok()
}

/// `{value, label}` option object.
fn opt(value: &str, label: &str) -> Value {
    json!({ "value": value, "label": label })
}

// ---- OpenAI ----------------------------------------------------------------

fn fetch_openai(api_key: Option<&str>) -> Vec<Value> {
    let Some(key) = api_key.filter(|k| !k.is_empty()) else { return Vec::new() };
    let body = match get_json(
        "https://api.openai.com/v1/models",
        &[("Authorization", &format!("Bearer {key}"))],
        5,
    ) {
        Some(b) => b,
        None => return Vec::new(),
    };
    let chat_prefixes = ["gpt-5", "gpt-4", "gpt-3.5", "o1", "o3", "o4", "chatgpt"];
    let exclude = [
        "realtime", "audio", "search", "transcription", "embedding", "moderation",
        "tts", "whisper", "dall-e", "instruct",
    ];
    let mut rows: Vec<(i64, String)> = body
        .get("data")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let id = m.get("id").and_then(Value::as_str)?;
                    if !chat_prefixes.iter().any(|p| id.starts_with(p)) {
                        return None;
                    }
                    if exclude.iter().any(|t| id.contains(t)) {
                        return None;
                    }
                    let created = m.get("created").and_then(Value::as_i64).unwrap_or(0);
                    Some((created, id.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    // Newest first.
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    rows.iter().map(|(_, id)| opt(id, &openai_label(id))).collect()
}

/// `gpt-4.1-mini` -> `GPT-4.1 Mini`, `o3-mini` -> `o3 Mini`.
fn openai_label(id: &str) -> String {
    let parts: Vec<String> = id
        .split('-')
        .map(|p| {
            let lower = p.to_lowercase();
            if lower == "gpt" {
                "GPT".to_string()
            } else if lower == "chatgpt" {
                "ChatGPT".to_string()
            } else if p.chars().all(|c| c.is_ascii_alphabetic()) {
                // Capitalize a plain alpha segment (e.g. "mini" -> "Mini").
                let mut c = p.chars();
                match c.next() {
                    Some(f) => f.to_uppercase().chain(c).collect(),
                    None => String::new(),
                }
            } else {
                p.to_string()
            }
        })
        .collect();
    parts
        .join(" ")
        .replace("GPT ", "GPT-")
        .replace("ChatGPT ", "ChatGPT-")
}

// ---- Anthropic --------------------------------------------------------------

fn fetch_anthropic(api_key: Option<&str>) -> Vec<Value> {
    let Some(key) = api_key.filter(|k| !k.is_empty()) else { return Vec::new() };
    let body = match get_json(
        "https://api.anthropic.com/v1/models",
        &[("x-api-key", key), ("anthropic-version", "2023-06-01")],
        5,
    ) {
        Some(b) => b,
        None => return Vec::new(),
    };
    let mut rows: Vec<(String, String, String)> = body
        .get("data")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let id = m.get("id").and_then(Value::as_str)?.to_string();
                    let label = m
                        .get("display_name")
                        .and_then(Value::as_str)
                        .unwrap_or(&id)
                        .to_string();
                    let created =
                        m.get("created_at").and_then(Value::as_str).unwrap_or("").to_string();
                    Some((created, id, label))
                })
                .collect()
        })
        .unwrap_or_default();
    // Newest first: created_at is ISO, so a lexical sort works.
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    rows.iter().map(|(_, id, label)| opt(id, label)).collect()
}

// ---- Claude subscription (static aliases) ----------------------------------

fn claude_proxy_models() -> Vec<Value> {
    // Aliases the `claude` CLI resolves to the latest of each family. Fable is
    // the one Anthropic has hinted it may drop from subscriptions, so the UI
    // probes it (/llm/claude_proxy/probe) before offering it. Order matters:
    // the picker auto-selects the first option for a fresh pick, and Opus is
    // the right default for most sessions. Heavier tracks better in general,
    // but not far enough to lead with Fable.
    vec![
        opt("opus", "Opus (latest)"),
        opt("fable", "Fable (latest)"),
        opt("sonnet", "Sonnet (latest)"),
        opt("haiku", "Haiku (latest)"),
    ]
}

// ---- OpenRouter (public) ----------------------------------------------------

fn fetch_openrouter() -> Vec<Value> {
    let body = match get_json("https://openrouter.ai/api/v1/models", &[], 8) {
        Some(b) => b,
        None => return Vec::new(),
    };
    let keep_orgs = [
        "anthropic", "openai", "google", "meta-llama", "deepseek", "mistralai",
        "qwen", "moonshotai",
    ];
    let mut rows: Vec<(i64, String, String)> = body
        .get("data")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let id = m.get("id").and_then(Value::as_str)?;
                    let org = id.split('/').next().unwrap_or("");
                    if !keep_orgs.contains(&org) {
                        return None;
                    }
                    if id.ends_with(":free") || id.ends_with(":extended") {
                        return None;
                    }
                    let label =
                        m.get("name").and_then(Value::as_str).unwrap_or(id).to_string();
                    let ctx = m.get("context_length").and_then(Value::as_i64).unwrap_or(0);
                    Some((ctx, id.to_string(), label))
                })
                .collect()
        })
        .unwrap_or_default();
    // Context length as a proxy for recency/capability; cap at 30.
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    rows.iter().take(30).map(|(_, id, label)| opt(id, label)).collect()
}

// ---- Venice -----------------------------------------------------------------

fn fetch_venice(api_key: Option<&str>) -> Vec<Value> {
    let Some(key) = api_key.filter(|k| !k.is_empty()) else { return Vec::new() };
    let body = match get_json(
        "https://api.venice.ai/api/v1/models",
        &[("Authorization", &format!("Bearer {key}"))],
        5,
    ) {
        Some(b) => b,
        None => return Vec::new(),
    };
    body.get("data")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let id = m.get("id").and_then(Value::as_str)?;
                    // Venice mixes in image/code models; keep text/chat.
                    let mtype = m.get("type").and_then(Value::as_str).unwrap_or("");
                    if !matches!(mtype, "" | "text" | "chat") {
                        return None;
                    }
                    let label = m
                        .get("name")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(id);
                    Some(opt(id, label))
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---- Groq -------------------------------------------------------------------

fn fetch_groq(api_key: Option<&str>) -> Vec<Value> {
    let Some(key) = api_key.filter(|k| !k.is_empty()) else { return Vec::new() };
    let body = match get_json(
        "https://api.groq.com/openai/v1/models",
        &[("Authorization", &format!("Bearer {key}"))],
        5,
    ) {
        Some(b) => b,
        None => return Vec::new(),
    };
    let exclude = ["whisper", "tts", "guard", "embed"];
    let mut rows: Vec<(i64, String)> = body
        .get("data")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let id = m.get("id").and_then(Value::as_str)?;
                    if id.is_empty() || m.get("active").and_then(Value::as_bool) == Some(false) {
                        return None;
                    }
                    let lower = id.to_lowercase();
                    if exclude.iter().any(|t| lower.contains(t)) {
                        return None;
                    }
                    let ctx = m.get("context_window").and_then(Value::as_i64).unwrap_or(0);
                    Some((ctx, id.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    rows.iter().map(|(_, id)| opt(id, &groq_label(id))).collect()
}

/// `meta-llama/llama-3.1-70b` -> `Llama 3.1 70b`.
fn groq_label(id: &str) -> String {
    let tail = id.rsplit('/').next().unwrap_or(id);
    tail.split('-')
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().chain(c).collect::<String>(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// --- API-key providers -----------------------------------------------------

fn api_key_provider(env_var: &str) -> Value {
    json!({
        "available": std::env::var(env_var).is_ok_and(|v| !v.is_empty()),
        "hint": format!("Add your API key in Settings or set {env_var} in your environment."),
    })
}

// --- Ollama ----------------------------------------------------------------

/// One entry from Ollama's `/api/tags`.
struct RawOllamaModel {
    name: String,
    size_bytes: u64,
}

/// `running == true` means the daemon responded; models may still be empty
/// (nothing pulled).
fn probe_ollama_tags() -> (bool, Vec<RawOllamaModel>) {
    let url = format!("{OLLAMA_URL}/api/tags");
    let resp = match ureq::get(&url)
        .config()
        .timeout_global(Some(std::time::Duration::from_millis(1500)))
        .build()
        .call()
    {
        Ok(r) => r,
        Err(_) => return (false, Vec::new()),
    };
    let body: Value = match serde_json::from_reader(resp.into_body().into_reader()) {
        Ok(v) => v,
        Err(_) => return (true, Vec::new()),
    };
    let models = body
        .get("models")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    Some(RawOllamaModel {
                        name: m.get("name").and_then(Value::as_str)?.to_string(),
                        size_bytes: m.get("size").and_then(Value::as_u64).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    (true, models)
}

fn probe_ollama_version() -> Option<String> {
    let url = format!("{OLLAMA_URL}/api/version");
    let resp = ureq::get(&url)
        .config()
        .timeout_global(Some(std::time::Duration::from_millis(1500)))
        .build()
        .call()
        .ok()?;
    let body: Value = serde_json::from_reader(resp.into_body().into_reader()).ok()?;
    body.get("version").and_then(Value::as_str).map(String::from)
}

/// The Ollama section of the providers response: availability, hint, models
/// with sizes, version/outdated info, and the per-machine recommendation.
fn ollama_section(
    has_bin: bool,
    running: bool,
    raw_models: &[RawOllamaModel],
    version: Option<&str>,
) -> Value {
    let model_names: Vec<String> = raw_models.iter().map(|m| m.name.clone()).collect();
    let model_sizes = build_model_sizes(raw_models);
    let ram_gb = system_ram_gb();
    let has_gpu = has_fast_gpu();
    let recommendation = build_recommendation(ram_gb, has_gpu, raw_models);
    let available = running && !model_names.is_empty();
    let installed = has_bin || running;
    let hint = ollama_hint(running, has_bin, &model_names, &recommendation);

    let mut section = json!({
        "available": available,
        "installed": installed,
        "models": model_names,
        "model_sizes": model_sizes,
        "hint": hint,
        "recommendation": recommendation,
        "min_version": MIN_OLLAMA_VERSION,
    });
    if let Some(v) = version {
        section["version"] = json!(v);
        section["outdated"] = json!(version_outdated(v));
    } else {
        section["version"] = Value::Null;
        section["outdated"] = json!(false);
    }
    section
}

fn ollama_hint(
    running: bool,
    has_bin: bool,
    models: &[String],
    recommendation: &Value,
) -> String {
    if running && !models.is_empty() {
        return String::new();
    }
    if running {
        let rec = recommendation
            .get("recommended_model")
            .and_then(Value::as_str)
            .unwrap_or("qwen3.5:4b");
        return format!(
            "Ollama is running but has no models. Run `ollama pull {rec}` to start."
        );
    }
    if has_bin {
        "Ollama is installed but not running. Start it from the menu bar or `ollama serve`."
            .to_string()
    } else {
        "Ollama is not installed. Visit ollama.ai to install.".to_string()
    }
}

/// `{ <name>: "X.XGB" or "XMB" }` per pulled model, which the settings UI shows
/// next to each installed model.
fn build_model_sizes(raw_models: &[RawOllamaModel]) -> Value {
    let mut sizes = serde_json::Map::new();
    for m in raw_models {
        if m.size_bytes == 0 {
            continue;
        }
        sizes.insert(m.name.clone(), json!(format_bytes(m.size_bytes)));
    }
    Value::Object(sizes)
}

fn format_bytes(bytes: u64) -> String {
    let gb = bytes as f64 / 1024f64.powi(3);
    if gb >= 1.0 {
        format!("{gb:.1}GB")
    } else {
        let mb = bytes as f64 / 1024f64.powi(2);
        format!("{mb:.0}MB")
    }
}

/// The per-machine recommendation block behind the "Recommended models"
/// picker: auto-picked tier, detected RAM, and every tier annotated with `fits`
/// (does its `min_gb` fit?) and `installed` (is a matching variant pulled?).
fn build_recommendation(
    ram_gb: Option<u32>,
    has_gpu: bool,
    raw_models: &[RawOllamaModel],
) -> Value {
    let rec = pick_tier(ram_gb);
    let mut claimed: std::collections::HashSet<String> = std::collections::HashSet::new();
    let tier_list: Vec<Value> = DEFAULT_TIERS
        .iter()
        .map(|t| {
            // Installed if a pulled model shares the tier's base name AND its
            // suffix, so tier qwen3.5:4b matches a pulled
            // qwen3.5:4b-instruct-q5_K_M.
            let base = t.model.split(':').next().unwrap_or(t.model);
            let suffix = t.model.split(':').next_back().unwrap_or("");
            let mut installed = false;
            for m in raw_models {
                let m_base = m.name.split(':').next().unwrap_or(&m.name);
                if m_base == base && (suffix.is_empty() || m.name.contains(suffix)) {
                    installed = true;
                    claimed.insert(m.name.clone());
                }
            }

            // High-RAM tiers on a machine without a fast GPU get a heads-up
            // that integrated graphics will be slow. Apple Silicon's unified
            // memory always counts as fast.
            let mut note = t.note.to_string();
            if !has_gpu && t.min_gb >= 24 {
                if !note.is_empty() {
                    note.push_str(". ");
                }
                note.push_str("May be slow with your current GPU");
            }

            let fits = ram_gb.map(|r| r >= t.min_gb).unwrap_or(false);
            json!({
                "model": t.model,
                "label": t.label,
                "download": t.download,
                "ram": t.ram,
                "note": note,
                "min_gb": t.min_gb,
                "fits": fits,
                "installed": installed,
            })
        })
        .collect();

    // Models pulled outside the curated tiers still need to be manageable from
    // the settings list.
    let model_sizes_map = build_model_sizes(raw_models);
    let other_installed: Vec<Value> = raw_models
        .iter()
        .filter(|m| !claimed.contains(&m.name))
        .map(|m| {
            json!({
                "model": m.name,
                "size": model_sizes_map.get(&m.name).cloned().unwrap_or(Value::String(String::new())),
            })
        })
        .collect();

    json!({
        "ram_gb": ram_gb,
        "recommended_model": rec.model,
        "recommended_label": rec.label,
        "tiers": tier_list,
        "other_installed": other_installed,
    })
}

/// Largest tier that fits the machine's RAM, falling back to the smallest when
/// RAM is unknown. `auto_recommend = false` tiers are visible in the UI but
/// skipped here, being too slow even when they fit.
fn pick_tier(ram_gb: Option<u32>) -> &'static OllamaTier {
    let last = DEFAULT_TIERS.last().expect("non-empty tier list");
    let Some(ram_gb) = ram_gb else {
        return last;
    };
    DEFAULT_TIERS
        .iter()
        .find(|t| t.auto_recommend && ram_gb >= t.min_gb)
        .unwrap_or(last)
}

// --- Hardware detection ----------------------------------------------------

pub(crate) fn system_ram_gb() -> Option<u32> {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let bytes = sys.total_memory();
    if bytes == 0 {
        return None;
    }
    Some((bytes / 1024 / 1024 / 1024) as u32)
}

/// Apple Silicon's unified memory is fast enough that macOS always counts as
/// "has fast GPU". Elsewhere, look for an NVIDIA card via `nvidia-smi` with at
/// least `min_vram_gb` of VRAM.
fn has_fast_gpu() -> bool {
    #[cfg(target_os = "macos")]
    {
        true
    }
    #[cfg(not(target_os = "macos"))]
    {
        nvidia_has_vram(20)
    }
}

#[cfg(not(target_os = "macos"))]
fn nvidia_has_vram(min_vram_gb: u64) -> bool {
    use std::process::Command;
    let output = match Command::new("nvidia-smi")
        .args([
            "--query-gpu=memory.total",
            "--format=csv,noheader,nounits",
        ])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return false,
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|l| l.trim().parse::<u64>().ok())
        .any(|mb| mb >= min_vram_gb * 1024)
}

// --- Version compare -------------------------------------------------------

fn parse_version(v: &str) -> Vec<u32> {
    v.trim()
        .trim_start_matches('v')
        .split('.')
        .filter_map(|p| p.parse::<u32>().ok())
        .collect()
}

/// True if `version` is below `MIN_OLLAMA_VERSION`. Empty/garbage returns
/// false: no outdated banner when we can't tell.
fn version_outdated(version: &str) -> bool {
    let v = parse_version(version);
    let min = parse_version(MIN_OLLAMA_VERSION);
    if v.is_empty() || min.is_empty() {
        return false;
    }
    v < min
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(name: &str, size_bytes: u64) -> RawOllamaModel {
        RawOllamaModel { name: name.to_string(), size_bytes }
    }

    #[test]
    fn picks_largest_fitting_auto_tier() {
        // 32 GB auto-picks "Good" (gemma4:26b, min 24); the 31b tier is
        // auto_recommend=false even though it fits.
        assert_eq!(pick_tier(Some(32)).model, "gemma4:26b");
        // 16 GB → "Decent".
        assert_eq!(pick_tier(Some(16)).model, "gemma4:e4b");
        // 8 GB → "Acceptable" (only tier with min_gb 0).
        assert_eq!(pick_tier(Some(8)).model, "qwen3.5:4b");
        // Unknown RAM falls back to smallest.
        assert_eq!(pick_tier(None).model, "qwen3.5:4b");
    }

    #[test]
    fn version_compare_against_min() {
        assert!(version_outdated("0.20.5"));
        assert!(!version_outdated("0.21.0"));
        assert!(!version_outdated("0.22.0"));
        assert!(!version_outdated("v1.0.0"));
        // Unknown/garbage → not outdated.
        assert!(!version_outdated(""));
        assert!(!version_outdated("nightly"));
    }

    #[test]
    fn byte_format_switches_units_at_one_gb() {
        assert_eq!(format_bytes(500 * 1024 * 1024), "500MB");
        assert_eq!(format_bytes(3 * 1024 * 1024 * 1024 + 400 * 1024 * 1024), "3.4GB");
    }

    #[test]
    fn tiers_carry_fits_and_installed_flags() {
        let pulled = vec![raw("qwen3.5:4b-instruct-q5_K_M", 3_500_000_000)];
        let rec = build_recommendation(Some(16), true, &pulled);
        let tiers = rec["tiers"].as_array().unwrap();
        // 16GB fits Decent (e4b, min 16) and below, not Good (24) or Slow (32).
        let lookup = |model: &str| -> &Value {
            tiers.iter().find(|t| t["model"] == model).unwrap()
        };
        assert_eq!(lookup("gemma4:31b")["fits"], json!(false));
        assert_eq!(lookup("gemma4:e4b")["fits"], json!(true));
        assert_eq!(lookup("qwen3.5:4b")["fits"], json!(true));
        assert_eq!(lookup("qwen3.5:4b")["installed"], json!(true));
        assert_eq!(lookup("gemma4:e4b")["installed"], json!(false));
    }

    #[test]
    fn other_installed_omits_tier_matches() {
        // One model matching a tier, one not.
        let pulled = vec![
            raw("qwen3.5:4b-instruct-q5_K_M", 3_500_000_000),
            raw("mistral:latest", 4_100_000_000),
        ];
        let rec = build_recommendation(Some(8), false, &pulled);
        let others = rec["other_installed"].as_array().unwrap();
        assert_eq!(others.len(), 1);
        assert_eq!(others[0]["model"], json!("mistral:latest"));
        assert!(
            others[0]["size"].as_str().unwrap().ends_with("GB")
                || others[0]["size"].as_str().unwrap().ends_with("MB")
        );
    }

    #[test]
    fn no_gpu_high_ram_tiers_get_slow_warning() {
        let rec = build_recommendation(Some(48), false, &[]);
        let tiers = rec["tiers"].as_array().unwrap();
        let slow_tier = tiers.iter().find(|t| t["model"] == "gemma4:26b").unwrap();
        assert!(slow_tier["note"].as_str().unwrap().contains("May be slow"));
        // Low-RAM tier shouldn't get the warning.
        let small = tiers.iter().find(|t| t["model"] == "qwen3.5:4b").unwrap();
        assert!(!small["note"].as_str().unwrap().contains("May be slow"));
    }

    #[test]
    fn providers_response_carries_every_expected_key() {
        let v = providers();
        for k in [
            "claude_proxy",
            "anthropic",
            "openai",
            "openrouter",
            "venice",
            "groq",
            "ollama",
        ] {
            assert!(v.get(k).is_some(), "missing provider key: {k}");
            assert!(v[k].get("available").is_some(), "{k} missing `available`");
        }
        // Ollama enrichment fields the TS UI looks up.
        let o = &v["ollama"];
        for k in ["models", "model_sizes", "recommendation", "min_version", "version", "outdated"] {
            assert!(o.get(k).is_some(), "ollama missing `{k}`");
        }
        let rec = &o["recommendation"];
        for k in ["ram_gb", "recommended_model", "recommended_label", "tiers", "other_installed"] {
            assert!(rec.get(k).is_some(), "recommendation missing `{k}`");
        }
    }
}
