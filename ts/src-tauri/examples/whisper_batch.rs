//! Headless batch transcription with the desktop shell's Whisper settings.
//!
//! Mirrors `transcribe` in src/server.rs (the `/app/v1/stt/whisper` route), so
//! a script can measure what the app would hear without running the app. Keep
//! the two in step: a FullParams change there belongs here too.
//!
//!   cargo run --example whisper_batch -- --model <ggml-*.bin> [--lang en] [--prompt "<text>"] < wav-paths
//!
//! Reads 16 kHz mono 16-bit WAV paths from stdin, one per line, and prints one
//! JSON line per file: {"file", "text", "ms"} or {"file", "error"}. The model
//! loads once per process.

use std::io::{BufRead, Write};
use std::time::Instant;

use serde_json::json;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

const TARGET_SAMPLE_RATE: u32 = 16_000;

fn read_wav(path: &str) -> Result<Vec<f32>, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".into());
    }
    let mut at = 12;
    let mut format: Option<(u16, u16, u32, u16)> = None;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]]) as usize;
        let body = at + 8;
        // ffmpeg writes 0xFFFFFFFF for a data size it couldn't seek back to fix.
        let end = if size == u32::MAX as usize { bytes.len() } else { (body + size).min(bytes.len()) };
        if id == b"fmt " && end - body >= 16 {
            let b = &bytes[body..end];
            format = Some((
                u16::from_le_bytes([b[0], b[1]]),
                u16::from_le_bytes([b[2], b[3]]),
                u32::from_le_bytes([b[4], b[5], b[6], b[7]]),
                u16::from_le_bytes([b[14], b[15]]),
            ));
        } else if id == b"data" {
            let (tag, channels, rate, bits) = format.ok_or("data before fmt")?;
            if tag != 1 || channels != 1 || bits != 16 || rate != TARGET_SAMPLE_RATE {
                return Err(format!(
                    "want 16 kHz mono s16 PCM, got tag {tag} {channels} ch {rate} Hz {bits} bit"
                ));
            }
            // The route's i16 path, byte for byte.
            return Ok(bytes[body..end]
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
                .collect());
        }
        at = body + size + (size & 1);
    }
    Err("no data chunk".into())
}

fn transcribe(ctx: &WhisperContext, samples: &[f32], lang: &str, prompt: Option<&str>) -> Result<String, String> {
    let mut wstate = ctx.create_state().map_err(|e| e.to_string())?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some(lang));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    if let Some(p) = prompt {
        params.set_initial_prompt(p);
    }
    wstate.full(params, samples).map_err(|e| e.to_string())?;
    let mut text = String::new();
    for i in 0..wstate.full_n_segments() {
        if let Some(segment) = wstate.get_segment(i) {
            text.push_str(segment.to_str_lossy().map_err(|e| e.to_string())?.as_ref());
        }
    }
    Ok(text.trim().trim_end_matches('\u{FFFD}').to_string())
}

fn main() {
    let mut model: Option<String> = None;
    let mut lang = "en".to_string();
    let mut prompt: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--model" => model = args.next(),
            "--lang" => lang = args.next().expect("--lang needs a value"),
            "--prompt" => prompt = args.next().filter(|p| !p.is_empty()),
            other => {
                eprintln!("unknown argument {other}");
                std::process::exit(2);
            }
        }
    }
    let model = model.unwrap_or_else(|| {
        eprintln!("usage: whisper_batch --model <ggml-*.bin> [--lang en] [--prompt <text>] < wav-paths");
        std::process::exit(2);
    });

    whisper_rs::install_logging_hooks();
    let ctx = WhisperContext::new_with_params(&model, WhisperContextParameters::default())
        .unwrap_or_else(|e| {
            eprintln!("failed to load {model}: {e}");
            std::process::exit(1);
        });

    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let file = match line {
            Ok(l) if !l.trim().is_empty() => l.trim().to_string(),
            Ok(_) => continue,
            Err(_) => break,
        };
        let started = Instant::now();
        let result = read_wav(&file).and_then(|samples| transcribe(&ctx, &samples, &lang, prompt.as_deref()));
        let row = match result {
            Ok(text) => json!({ "file": file, "text": text, "ms": started.elapsed().as_millis() as u64 }),
            Err(error) => json!({ "file": file, "error": error }),
        };
        let _ = writeln!(out, "{row}");
        let _ = out.flush();
    }
}
