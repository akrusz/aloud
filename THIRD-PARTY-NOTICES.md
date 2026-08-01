# Third-party notices

aloud itself is licensed under the AGPL-3.0 ([LICENSE](LICENSE), with an
[App Store distribution exception](LICENSE-EXCEPTION.md)). The shipped web,
desktop, and mobile builds also contain third-party components, listed here with
their licenses.

## Vendored assets (committed to this repo, shipped in every build)

### Silero VAD - `ts/ui/src/assets/silero_vad_op18_ifless.onnx`

The speech-probability model behind on-device voice activity detection
(`ts/ui/src/adapters/silero-vad.ts`).

| | |
|---|---|
| Project | [silero-vad](https://github.com/snakers4/silero-vad) |
| Version | v6.2.1 (`silero_vad_op18_ifless.onnx`) |
| License | MIT |
| Copyright | Copyright (c) 2020-present Silero Team |

> Permission is hereby granted, free of charge, to any person obtaining a copy of
> this software and associated documentation files (the "Software"), to deal in
> the Software without restriction, including without limitation the rights to
> use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
> of the Software, and to permit persons to whom the Software is furnished to do
> so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

Why this particular export, and how to upgrade it, is in
[`ts/ui/src/assets/README.md`](ts/ui/src/assets/README.md).

## Dependencies

npm and Cargo packages are declared, not vendored - they arrive at build time and
each carries its own license. The authoritative lists are `ts/package.json`,
`ts/ui/package.json`, `ts/server/package.json`, and
`ts/src-tauri/Cargo.toml`; resolved trees with licenses come from
`npm ls --all` / `cargo tree` (or `npx license-checker`).

Notable runtime components in the client bundle:

| Component | License | Role |
|---|---|---|
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) | MIT | Runs the Silero model in WASM |

## Keeping this current

Adding a **vendored** binary or source file from another project means a section
here, not just a note in a directory README. Declared dependencies do not - the
manifests cover those.
