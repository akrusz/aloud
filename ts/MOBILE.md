# Mobile build (Capacitor)

The TS UI under `ui/` is the same code that runs in the browser preview
*and* inside the iOS / Android Capacitor wrappers. The Vite build output
in `ui/dist/` is what Capacitor packages.

## First-time setup

Prerequisites:
- **iOS**: Xcode + command-line tools, a paid Apple Developer account
  (only for shipping to TestFlight / App Store; local builds work
  without one)
- **Android**: Android Studio + an emulator or device

Generate the native projects:

```bash
cd ts
npm run ui:build         # produces ui/dist
npx cap add ios          # creates ios/ — opens an Xcode project
npx cap add android      # creates android/ — Gradle project
```

The `ios/` and `android/` directories are currently in `.gitignore`.
**Before you commit them**, decide on the rebrand bundle identifier and
app name in `capacitor.config.ts` — those values are baked into the
generated projects and changing them later is annoying.

To commit the native projects: remove the `ios/` and `android/` lines
from `ts/.gitignore`, then `git add ts/ios ts/android` and commit.

## Daily workflow

```bash
# Live reload — Capacitor loads from the Vite dev server.
# Edit ui/src/, see changes on the device immediately.
npm run ui:dev                                 # one terminal
npx cap run ios --livereload --external        # another terminal
# (or `npx cap run android --livereload --external`)

# Without live reload — packaged build each time.
npm run cap:ios          # builds + syncs + opens Xcode
npm run cap:android      # builds + syncs + opens Android Studio
```

### `VITE_ALOUD_CLOUD_URL` is required for packaged builds

`cap:sync` / `cap:ios` / `cap:android` **fail fast if `VITE_ALOUD_CLOUD_URL`
is unset** (the `cap:require-cloud-url` guard in `package.json`). The cloud
origin is baked into the Vite build; without it, a packaged app ships with
aloud cloud (sign-in, credits, metered STT/LLM/TTS) silently disabled. For a
production build use the hosted origin:

```bash
VITE_ALOUD_CLOUD_URL=https://aloud-cloud.fly.dev npm run cap:sync
```

(Live-reload dev via `ui:dev` is unaffected — the Vite dev proxy handles
`/cloud` there.)

## What's wired up

- **STT**: `CapacitorSttEngine` wraps `@capacitor-community/speech-recognition`.
  Uses `SFSpeechRecognizer` on iOS, `SpeechRecognizer` on Android. No Whisper
  bundled. Validation pending — see beads ticket `meditation-pal-0ao`.
- **TTS**: `BrowserTtsEngine` (speechSynthesis) works inside Capacitor's
  WKWebView and Android WebView. We may swap to a Capacitor TTS plugin
  later for higher-quality iOS voices.
- **Storage**: `LocalStorageKv`. Works inside Capacitor but doesn't survive
  WebView data clears; long-term we should swap to Capacitor Preferences.
- **LLM**: Anthropic via the aloud cloud proxy (`dbd` in beads),
  Ollama via the user's own LAN if reachable — same code as the web preview.

## iOS Info.plist additions

After `cap add ios`, edit `ios/App/App/Info.plist` to add usage strings
for permissions the speech-recognition plugin requires:

```xml
<key>NSSpeechRecognitionUsageDescription</key>
<string>Used to transcribe what you say during meditation sessions.</string>
<key>NSMicrophoneUsageDescription</key>
<string>Used to listen to your voice during meditation sessions.</string>
```

Without these, iOS will reject the permission prompt at runtime and the
plugin's `requestPermissions()` will return denied.
