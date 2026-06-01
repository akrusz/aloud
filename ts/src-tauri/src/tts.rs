//! TTS catalog + synthesis for the desktop backend.
//!
//! Replaces Flask's `/app/v1/voices` and `/app/v1/voices/preview` with native Rust:
//! Piper (neural, ONNX via `piper-rs`) cross-platform, plus macOS `say` as a
//! zero-setup local engine on Darwin. Shapes mirror `src/tts/` (PIPER_VOICES,
//! aggregate_voices, the preview WAV contract) so the existing TS adapters
//! (`voices.ts`, `cloud-tts.ts`) are unchanged.
//!
//! Piper models are downloaded on demand: the first preview/synthesis of a
//! voice pulls its `.onnx`/`.onnx.json` from Hugging Face into `piper_dir`,
//! mirroring how the Whisper model loads on first run. (The TS voice picker
//! has no working Download button yet — same as the web build — so
//! download-on-demand is what actually makes Piper usable on desktop.)

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use piper_rs::Piper;
use serde_json::{json, Value};

/// One entry in the Piper voice catalogue. Mirror of `PIPER_VOICES` in
/// `src/tts/piper.py`. `model` is the shared `.onnx` basename (== `name` for
/// single-speaker voices); `speaker` is the speaker key for multi-speaker
/// models, resolved to a numeric id via the model's `speaker_id_map`.
struct PiperVoice {
    name: &'static str,
    lang: &'static str,
    size_mb: u32,
    recommended: bool,
    model: &'static str,
    speaker: Option<&'static str>,
}

const PIPER_VOICES: &[PiperVoice] = &[
    // Recommended — curated libritts-high speakers (one 105 MB download for all).
    PiperVoice { name: "Libritts p3922 (F)", lang: "en_US", size_mb: 105, recommended: true,
                 model: "en_US-libritts-high", speaker: Some("p3922") },
    PiperVoice { name: "Libritts p4356 (F)", lang: "en_US", size_mb: 105, recommended: true,
                 model: "en_US-libritts-high", speaker: Some("p4356") },
    PiperVoice { name: "Libritts p3368 (M)", lang: "en_US", size_mb: 105, recommended: true,
                 model: "en_US-libritts-high", speaker: Some("p3368") },
    PiperVoice { name: "Libritts p2053 (M)", lang: "en_US", size_mb: 105, recommended: true,
                 model: "en_US-libritts-high", speaker: Some("p2053") },
    // Other voices (single-speaker: model == name).
    PiperVoice { name: "en_US-joe-medium", lang: "en_US", size_mb: 63, recommended: false, model: "en_US-joe-medium", speaker: None },
    PiperVoice { name: "en_US-kristin-medium", lang: "en_US", size_mb: 63, recommended: false, model: "en_US-kristin-medium", speaker: None },
    PiperVoice { name: "en_US-norman-medium", lang: "en_US", size_mb: 63, recommended: false, model: "en_US-norman-medium", speaker: None },
    PiperVoice { name: "en_US-lessac-medium", lang: "en_US", size_mb: 63, recommended: false, model: "en_US-lessac-medium", speaker: None },
    PiperVoice { name: "en_US-lessac-high", lang: "en_US", size_mb: 105, recommended: false, model: "en_US-lessac-high", speaker: None },
    PiperVoice { name: "en_US-amy-medium", lang: "en_US", size_mb: 63, recommended: false, model: "en_US-amy-medium", speaker: None },
    PiperVoice { name: "en_US-arctic-medium", lang: "en_US", size_mb: 63, recommended: false, model: "en_US-arctic-medium", speaker: None },
    PiperVoice { name: "en_US-ryan-medium", lang: "en_US", size_mb: 63, recommended: false, model: "en_US-ryan-medium", speaker: None },
    PiperVoice { name: "en_US-ryan-high", lang: "en_US", size_mb: 105, recommended: false, model: "en_US-ryan-high", speaker: None },
    PiperVoice { name: "en_GB-alan-medium", lang: "en_GB", size_mb: 63, recommended: false, model: "en_GB-alan-medium", speaker: None },
    PiperVoice { name: "en_GB-cori-medium", lang: "en_GB", size_mb: 63, recommended: false, model: "en_GB-cori-medium", speaker: None },
    PiperVoice { name: "en_GB-jenny_dioco-medium", lang: "en_GB", size_mb: 63, recommended: false, model: "en_GB-jenny_dioco-medium", speaker: None },
];

/// Caches the last-loaded Piper model (model name → loaded `Piper`), an
/// LRU-of-1 matching Flask's `_preview_tts_cache`: streaming a session's
/// sentences through `/app/v1/voices/preview` must not reload the ONNX model on
/// every call.
pub type PiperCache = Mutex<Option<(String, Piper)>>;

fn find_piper(name: &str) -> Option<&'static PiperVoice> {
    PIPER_VOICES.iter().find(|v| v.name == name)
}

/// Which engine should synthesize a given voice when the caller didn't say.
/// Piper catalogue first, then macOS on Darwin (mirrors `engine_for_voice`).
pub fn engine_for_voice(name: &str) -> Option<&'static str> {
    if find_piper(name).is_some() {
        return Some("piper");
    }
    if cfg!(target_os = "macos") {
        return Some("macos");
    }
    None
}

fn piper_model_path(piper_dir: &Path, model: &str) -> PathBuf {
    piper_dir.join(format!("{model}.onnx"))
}

/// `[(url, filename), ...]` for a Piper model's files (mirror of
/// `_voice_hf_urls`). `model` is the resolved model basename, e.g.
/// `en_US-lessac-medium`.
fn piper_hf_urls(model: &str) -> Vec<(String, String)> {
    let parts: Vec<&str> = model.split('-').collect();
    let locale = parts[0]; // en_US
    let quality = parts[parts.len() - 1]; // medium
    let speaker = parts[1..parts.len() - 1].join("-"); // lessac, jenny_dioco
    let lang = locale.split('_').next().unwrap_or(locale); // en
    let base = format!(
        "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/{lang}/{locale}/{speaker}/{quality}"
    );
    vec![
        (format!("{base}/{model}.onnx"), format!("{model}.onnx")),
        (format!("{base}/{model}.onnx.json"), format!("{model}.onnx.json")),
    ]
}

// --- /app/v1/voices -----------------------------------------------------------

/// Build the `/app/v1/voices` JSON array. `engine` (Some) restricts to one engine
/// (the Settings page does this); `lang` filters by language prefix. With no
/// engine override the list aggregates Piper then macOS, deduped by name —
/// matching Flask's `aggregate_voices`.
pub fn list_voices(engine: Option<&str>, lang: Option<&str>, piper_dir: &Path) -> Value {
    let mut voices: Vec<Value> = Vec::new();

    match engine {
        Some("piper") => voices.extend(piper_voices(piper_dir)),
        Some("macos") => voices.extend(macos_voices()),
        Some(_) => {} // elevenlabs/unknown: no local catalogue
        None => {
            // Aggregate: Piper first, then macOS voices not already present.
            voices.extend(piper_voices(piper_dir));
            let seen: std::collections::HashSet<String> = voices
                .iter()
                .filter_map(|v| v.get("name").and_then(Value::as_str).map(String::from))
                .collect();
            for v in macos_voices() {
                let name = v.get("name").and_then(Value::as_str).unwrap_or("");
                if !seen.contains(name) {
                    voices.push(v);
                }
            }
        }
    }

    if let Some(lang) = lang {
        voices.retain(|v| {
            v.get("lang")
                .and_then(Value::as_str)
                .map(|l| l.split('_').next().unwrap_or(l) == lang)
                .unwrap_or(false)
        });
    }

    Value::Array(voices)
}

fn piper_voices(piper_dir: &Path) -> Vec<Value> {
    PIPER_VOICES
        .iter()
        .map(|v| {
            let downloaded = piper_model_path(piper_dir, v.model).exists();
            let mut entry = json!({
                "name": v.name,
                "lang": v.lang,
                "engine": "piper",
                "downloaded": downloaded,
                "size_display": format!("{} MB", v.size_mb),
                "needs_download": true,
                // The shared .onnx basename. Multi-speaker voices repeat it, so
                // the UI can group speakers that download/uninstall together.
                "model": v.model,
            });
            if v.recommended {
                entry["recommended"] = json!(true);
            }
            entry
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn macos_voices() -> Vec<Value> {
    use std::process::Command;
    let output = match Command::new("say").arg("-v").arg("?").output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut voices = Vec::new();
    for line in stdout.lines() {
        // Format: "Voice Name    xx_XX    # description". Names can contain
        // spaces/parentheses; split on 2+ spaces before the lang code.
        if let Some((name, rest)) = split_macos_voice_line(line) {
            let mut entry = json!({ "name": name, "lang": rest, "engine": "macos" });
            // Mark Premium voices recommended so they sort into the top tier.
            if name.to_lowercase().contains("premium") {
                entry["recommended"] = json!(true);
            }
            voices.push(entry);
        }
    }
    voices
}

#[cfg(not(target_os = "macos"))]
fn macos_voices() -> Vec<Value> {
    Vec::new()
}

/// Parse one `say -v ?` line into (name, lang). Returns None for blank lines or
/// lines without a `xx_XX` locale code. Splits the name off at the first run of
/// 2+ spaces that is followed by a locale code.
#[cfg(target_os = "macos")]
fn split_macos_voice_line(line: &str) -> Option<(String, String)> {
    let line = line.trim_end();
    if line.is_empty() {
        return None;
    }
    // Find the locale token: 2 letters, underscore, 2 letters (e.g. en_US).
    for (idx, _) in line.match_indices("  ") {
        let rest = line[idx..].trim_start();
        let lang: String = rest.chars().take(5).collect();
        let bytes = lang.as_bytes();
        let looks_like_locale = lang.len() == 5
            && bytes[2] == b'_'
            && bytes[..2].iter().all(|b| b.is_ascii_alphabetic())
            && bytes[3..].iter().all(|b| b.is_ascii_alphabetic());
        if looks_like_locale {
            let name = line[..idx].trim().to_string();
            if !name.is_empty() {
                return Some((name, lang));
            }
        }
    }
    None
}

// --- /app/v1/voices/preview ---------------------------------------------------

/// Synthesize `text` for `voice` into WAV bytes. `engine` forces a backend;
/// when None it's inferred (`engine_for_voice`). `rate` is words-per-minute
/// (the GET contract); Piper maps it to a length_scale, macOS passes it to
/// `say -r`. Returns the WAV bytes or a human-readable error.
pub fn synth_preview(
    piper_dir: &Path,
    cache: &PiperCache,
    voice: &str,
    engine: Option<&str>,
    text: &str,
    rate: Option<u32>,
) -> Result<Vec<u8>, String> {
    let engine = engine
        .map(str::to_string)
        .or_else(|| engine_for_voice(voice).map(str::to_string))
        .ok_or_else(|| format!("no engine for voice '{voice}'"))?;

    match engine.as_str() {
        "piper" => synth_piper(piper_dir, cache, voice, text, rate),
        "macos" => synth_macos(voice, text, rate),
        other => Err(format!("unsupported engine '{other}'")),
    }
}

fn synth_piper(
    piper_dir: &Path,
    cache: &PiperCache,
    voice: &str,
    text: &str,
    rate: Option<u32>,
) -> Result<Vec<u8>, String> {
    let v = find_piper(voice).ok_or_else(|| format!("unknown Piper voice '{voice}'"))?;

    let onnx = piper_model_path(piper_dir, v.model);
    let config = piper_dir.join(format!("{}.onnx.json", v.model));
    // Models are downloaded explicitly via /app/v1/tts/download-model (the picker's
    // Download button), never on demand — a session must not stall on a 100 MB
    // fetch mid-synthesis. Matches the Flask preview, which also required the
    // model to be present.
    if !onnx.exists() || !config.exists() {
        return Err(format!("Piper voice '{voice}' not downloaded"));
    }

    // Piper's native pace at length_scale 1.0 is ~220 WPM (see piper.py).
    let length_scale = rate.map(|r| 220.0 / r.max(1) as f32);

    let mut guard = cache.lock().unwrap();
    let need_load = guard
        .as_ref()
        .map(|(name, _)| name != v.model)
        .unwrap_or(true);
    if need_load {
        let piper = Piper::new(&onnx, &config).map_err(|e| format!("load Piper model: {e}"))?;
        *guard = Some((v.model.to_string(), piper));
    }
    let (_, piper) = guard.as_mut().unwrap();

    let speaker_id = match v.speaker {
        Some(key) => Some(resolve_speaker_id(piper, key)?),
        None => None,
    };

    let (samples, sample_rate) = piper
        .create(text, false, speaker_id, length_scale, None, None)
        .map_err(|e| format!("Piper synthesis failed: {e}"))?;

    Ok(encode_wav_pcm16(&samples, sample_rate))
}

/// Map a speaker key (e.g. "p3922") to the model's numeric speaker id via the
/// `speaker_id_map` loaded from the model JSON (exposed by `piper.voices()`).
fn resolve_speaker_id(piper: &Piper, key: &str) -> Result<i64, String> {
    let map: Option<&HashMap<String, i64>> = piper.voices();
    map.and_then(|m| m.get(key))
        .copied()
        .ok_or_else(|| format!("speaker '{key}' not found in model"))
}

// --- /app/v1/tts/download-model + /app/v1/tts/uninstall-model --------------------

/// Download a Piper voice's model files, reporting progress through
/// `on_progress` as NDJSON-shaped values wire-compatible with Flask's
/// `/app/v1/tts/download-model`: a stream of `{status:"downloading", total,
/// completed, file}` then a terminal `{status:"done"}` (or, if the shared
/// model is already present, just `{status:"already_downloaded"}`).
///
/// Multi-speaker voices share one `.onnx`, so downloading any speaker brings
/// the whole family on disk — the caller re-reads `/app/v1/voices` afterward and
/// every speaker for that model unlocks (its `downloaded` flag is per file).
pub fn download_model<F: FnMut(Value)>(
    piper_dir: &Path,
    engine: &str,
    voice: &str,
    mut on_progress: F,
) -> Result<(), String> {
    if engine != "piper" {
        return Err(format!("Unknown engine: {engine}"));
    }
    let v = find_piper(voice).ok_or_else(|| format!("unknown Piper voice '{voice}'"))?;
    if piper_model_path(piper_dir, v.model).exists() {
        on_progress(json!({ "status": "already_downloaded" }));
        return Ok(());
    }

    std::fs::create_dir_all(piper_dir).map_err(|e| e.to_string())?;
    let mut total_downloaded: u64 = 0;
    for (url, filename) in piper_hf_urls(v.model) {
        let dest = piper_dir.join(&filename);
        if dest.exists() {
            continue;
        }
        // Download to a .part sibling and rename on success, so an interrupted
        // download can't masquerade as a complete model.
        let tmp = dest.with_extension("part");
        let res = download_file_with_progress(
            &url,
            &tmp,
            &filename,
            &mut total_downloaded,
            &mut on_progress,
        );
        if let Err(e) = res {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
        std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    }

    on_progress(json!({ "status": "done" }));
    Ok(())
}

fn download_file_with_progress<F: FnMut(Value)>(
    url: &str,
    tmp: &Path,
    filename: &str,
    total_downloaded: &mut u64,
    on_progress: &mut F,
) -> Result<(), String> {
    use std::io::{Read, Write};
    let resp = ureq::get(url).call().map_err(|e| e.to_string())?;
    let file_total: u64 = resp
        .headers()
        .get("content-length")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let mut reader = resp.into_body().into_reader();
    let mut file = std::fs::File::create(tmp).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 65536];
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        *total_downloaded += n as u64;
        on_progress(json!({
            "status": "downloading",
            "total": file_total,
            "completed": *total_downloaded,
            "file": filename,
        }));
    }
    Ok(())
}

/// Remove a downloaded Piper voice's model files. Resolves multi-speaker
/// display names to the shared model basename first (so uninstalling e.g.
/// "Libritts p3922 (F)" removes `en_US-libritts-high.onnx`, freeing the whole
/// family). Returns "removed" or "not_found".
pub fn uninstall_model(piper_dir: &Path, engine: &str, voice: &str) -> Result<&'static str, String> {
    if engine != "piper" {
        return Err("uninstall not supported for this engine".to_string());
    }
    let v = find_piper(voice).ok_or_else(|| format!("unknown Piper voice '{voice}'"))?;
    let mut removed = false;
    for suffix in [".onnx", ".onnx.json"] {
        let f = piper_dir.join(format!("{}{}", v.model, suffix));
        if f.exists() {
            std::fs::remove_file(&f).map_err(|e| e.to_string())?;
            removed = true;
        }
    }
    Ok(if removed { "removed" } else { "not_found" })
}

#[cfg(target_os = "macos")]
fn synth_macos(voice: &str, text: &str, rate: Option<u32>) -> Result<Vec<u8>, String> {
    use std::process::Command;
    // Unique temp path; `say` writes the WAV here and we read it back.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("aloud-preview-{nanos}.wav"));

    let mut cmd = Command::new("say");
    cmd.arg("-v").arg(voice);
    if let Some(r) = rate {
        cmd.arg("-r").arg(r.to_string());
    }
    cmd.arg("-o")
        .arg(&tmp)
        .arg("--file-format=WAVE")
        .arg("--data-format=LEI16")
        .arg(text);

    let status = cmd.status().map_err(|e| format!("run say: {e}"))?;
    let result = if status.success() {
        std::fs::read(&tmp).map_err(|e| format!("read say output: {e}"))
    } else {
        Err(format!("say exited with {status}"))
    };
    let _ = std::fs::remove_file(&tmp);
    result
}

#[cfg(not(target_os = "macos"))]
fn synth_macos(_voice: &str, _text: &str, _rate: Option<u32>) -> Result<Vec<u8>, String> {
    Err("macOS 'say' engine is only available on macOS".to_string())
}

/// Encode mono f32 samples (range ~[-1, 1]) as a 16-bit PCM WAV. Piper returns
/// raw samples; the TS adapter plays the bytes through an HTMLAudioElement, so
/// a standard WAV container is all it needs.
fn encode_wav_pcm16(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let num_samples = samples.len();
    let bytes_per_sample = 2u32;
    let channels = 1u16;
    let byte_rate = sample_rate * channels as u32 * bytes_per_sample;
    let data_len = (num_samples as u32) * bytes_per_sample;

    let mut buf = Vec::with_capacity(44 + data_len as usize);
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&(36 + data_len).to_le_bytes());
    buf.extend_from_slice(b"WAVE");
    buf.extend_from_slice(b"fmt ");
    buf.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    buf.extend_from_slice(&1u16.to_le_bytes()); // audio format = PCM
    buf.extend_from_slice(&channels.to_le_bytes());
    buf.extend_from_slice(&sample_rate.to_le_bytes());
    buf.extend_from_slice(&byte_rate.to_le_bytes());
    buf.extend_from_slice(&(channels * bytes_per_sample as u16).to_le_bytes()); // block align
    buf.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&data_len.to_le_bytes());
    for &s in samples {
        let clamped = s.clamp(-1.0, 1.0);
        let i = (clamped * i16::MAX as f32) as i16;
        buf.extend_from_slice(&i.to_le_bytes());
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hf_urls_single_speaker() {
        let urls = piper_hf_urls("en_US-lessac-medium");
        assert_eq!(urls.len(), 2);
        assert_eq!(
            urls[0].0,
            "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx"
        );
        assert_eq!(urls[1].1, "en_US-lessac-medium.onnx.json");
    }

    #[test]
    fn hf_urls_underscore_speaker() {
        // jenny_dioco must keep its underscore in the path.
        let urls = piper_hf_urls("en_GB-jenny_dioco-medium");
        assert!(urls[0].0.contains("/en_GB/jenny_dioco/medium/"));
    }

    #[test]
    fn engine_inference_prefers_piper() {
        assert_eq!(engine_for_voice("en_US-lessac-medium"), Some("piper"));
        assert_eq!(engine_for_voice("Libritts p3922 (F)"), Some("piper"));
        // Unknown voice → macOS on Darwin, None elsewhere.
        let inferred = engine_for_voice("Samantha");
        if cfg!(target_os = "macos") {
            assert_eq!(inferred, Some("macos"));
        } else {
            assert_eq!(inferred, None);
        }
    }

    #[test]
    fn wav_header_is_well_formed() {
        let wav = encode_wav_pcm16(&[0.0, 1.0, -1.0], 22050);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[36..40], b"data");
        // 3 samples * 2 bytes = 6 bytes of PCM data after the 44-byte header.
        assert_eq!(wav.len(), 44 + 6);
        // Full-scale +1.0 → i16::MAX (32767) little-endian.
        assert_eq!(&wav[46..48], &32767i16.to_le_bytes());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_say_voice_lines() {
        assert_eq!(
            split_macos_voice_line("Samantha            en_US    # Hello"),
            Some(("Samantha".to_string(), "en_US".to_string()))
        );
        // Name with parens but still 2+ spaces before the locale.
        assert_eq!(
            split_macos_voice_line("Grandma (German)    de_DE    # Hallo"),
            Some(("Grandma (German)".to_string(), "de_DE".to_string()))
        );
        // Long names that overflow the column have only ONE space before the
        // locale (e.g. "Eddy (English (UK)) en_GB"). The 2-space requirement
        // skips them — matching the Python regex (`\s{2,}`), which drops these
        // duplicate-named regional variants too.
        assert_eq!(split_macos_voice_line("Eddy (English (UK)) en_GB    # Hi"), None);
        assert_eq!(split_macos_voice_line(""), None);
    }

    /// Real end-to-end Piper synthesis: downloads a model and runs ONNX
    /// inference. Network + ~63 MB + slow, so it's ignored by default; run
    /// explicitly with `cargo test piper_synthesizes_audio -- --ignored`.
    #[test]
    #[ignore]
    fn piper_synthesizes_audio() {
        let dir = std::env::temp_dir().join("aloud-piper-test");
        let cache: PiperCache = Mutex::new(None);
        download_model(&dir, "piper", "en_US-lessac-medium", |_| {}).expect("download");
        let wav = synth_preview(
            &dir,
            &cache,
            "en_US-lessac-medium",
            Some("piper"),
            "Hello there.",
            Some(180),
        )
        .expect("piper synthesis");
        assert_eq!(&wav[0..4], b"RIFF");
        // A real utterance should be well more than just a header.
        assert!(wav.len() > 10_000, "tiny WAV ({} bytes)", wav.len());
    }

    #[test]
    #[ignore]
    fn piper_multispeaker_resolves_speaker() {
        let dir = std::env::temp_dir().join("aloud-piper-test");
        let cache: PiperCache = Mutex::new(None);
        // Download via one speaker; all four share the model file.
        download_model(&dir, "piper", "Libritts p3922 (F)", |_| {}).expect("download");
        let wav = synth_preview(&dir, &cache, "Libritts p3922 (F)", Some("piper"), "Hello there.", Some(180))
            .expect("multispeaker synthesis");
        assert!(wav.len() > 10_000, "tiny WAV ({} bytes)", wav.len());
    }

    #[test]
    fn synth_errors_when_model_absent() {
        let dir = std::env::temp_dir().join("aloud-piper-absent-xyz");
        let _ = std::fs::remove_dir_all(&dir);
        let cache: PiperCache = Mutex::new(None);
        let err = synth_preview(&dir, &cache, "en_US-lessac-medium", Some("piper"), "hi", Some(180))
            .unwrap_err();
        assert!(err.contains("not downloaded"), "unexpected error: {err}");
    }
}
