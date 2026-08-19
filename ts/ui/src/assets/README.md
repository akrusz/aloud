# ui/src/assets

Binary assets imported by the UI with Vite `?url` (hashed + copied into `dist/`).

## silero_vad_op18_ifless.onnx

Silero VAD, the speech-probability model behind `adapters/silero-vad.ts`.

| | |
|---|---|
| Source | https://github.com/snakers4/silero-vad/blob/v6.2.1/src/silero_vad/data/silero_vad_op18_ifless.onnx |
| Release | v6.2.1 (2026-02-24) |
| sha256 | `7671cd04b004e9076da0d4a7b1a5aec36adf161c39230c1cb94a4fd5db6bbd28` |
| License | MIT (silero-vad) - full text in [THIRD-PARTY-NOTICES.md](../../../../THIRD-PARTY-NOTICES.md) |

**Why the `_ifless` export and not the default `silero_vad.onnx`:** the default
export wraps the whole network in `If` nodes (an 8k branch and a 16k branch,
plus nested ones), and onnxruntime-web's If-subgraph inlining is buggy - session
create dies on some WebKit builds with `Could not find OrtValue with name
'If_0_else_branch__Inline_0__/stft/padding/Constant_output_0'` or `graph output
does not exist`, which read to the user as a completely deaf app
(meditation-pal-6z11). Upstream publishes this control-flow-free export for
exactly that class of runtime; it has no subgraphs at all, so the broken code
path can't run.

It expects **576 samples** per call (64 samples of previous audio as context +
512 new) - the context concat that the default export does internally. That
lives in `SileroRunner` in `adapters/silero-vad.ts`.

**Graph optimization is disabled** at session create for the same reason the
ifless export exists: ort-web's optimizer is the other 6z11 failure source,
including one that passes a load-time probe and then kills OrtRun mid-stream
(`Could not find OrtValue with name 'input'`, macOS 14 webview). And it buys
nothing on this model: 0.16ms/chunk either way (~32ms budget), create 6ms
unoptimized vs 114ms optimized.

Upgrading: drop in a newer release's `silero_vad_op18_ifless.onnx`, update the
table above and the version in `THIRD-PARTY-NOTICES.md`, and re-check the speech/silence decisions before shipping (feed a
speech clip through the model chunk by chunk and compare speaking-frame counts
against the current file - the v5.1.2 → v6.2.1 move agreed on 90-99% of frames
across voices and levels, differing only at utterance boundaries).
