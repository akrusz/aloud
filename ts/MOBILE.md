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
# Android: build + sync + install + launch on the connected device in one
# step, no Android Studio. The main way to run the current code on a phone.
npm run cap:android:run

# Live reload — Capacitor loads from the Vite dev server.
# Edit ui/src/, see changes on the device immediately.
npm run ui:dev                                 # one terminal
npx cap run ios --livereload --external        # another terminal
# (or `npx cap run android --livereload --external`)

# Without live reload, via the IDEs.
npm run cap:ios          # builds + syncs + opens Xcode
npm run cap:android      # builds + syncs + opens Android Studio
```

Note a rebuild from inside Android Studio repackages the last-synced
`ui/dist` — it never rebuilds it. If the app looks stale, run
`cap:android:run` (or `cap:sync`) so the web bundle is rebuilt first.

### `VITE_ALOUD_CLOUD_URL` is required for packaged builds

The cloud origin is baked into the Vite build; without it, a packaged app
ships with aloud cloud (sign-in, credits, metered STT/LLM/TTS) silently
disabled. The hosted origin is committed as a production-build default in
`ui/.env.production` (Vite loads env files from `ui/`, its project root -
NOT from the shell's `.env` or `server/.env`), so a plain
`npm run cap:sync` / `cap:android` / `cap:ios` just works. An environment
variable overrides the file (that's how CI's `ALOUD_CLOUD_URL` repo var
feeds it), and the `cap:require-cloud-url` guard in `package.json` fails
fast if both are missing.

(Live-reload dev via `ui:dev` is unaffected — `.env.production` only
applies to builds, and the Vite dev proxy handles `/cloud` there.)

## What's wired up

- **STT**: `CapacitorSttEngine` wraps `@capacitor-community/speech-recognition`.
  Uses `SFSpeechRecognizer` on iOS, `SpeechRecognizer` on Android. No Whisper
  bundled. Validation pending — see beads ticket `meditation-pal-0ao`.
  - The Android plugin is **patched** (`patches/`, applied by `postinstall`
    via patch-package; the Android build compiles plugin source straight from
    `node_modules`). Stock v7 leaves `onReadyForSpeech` empty and, in
    partial-results mode, rejects an already-resolved call on `onError` — so
    JS could see neither "recognizer is live" nor any error (NO_MATCH,
    SPEECH_TIMEOUT, BUSY). The patch emits `listeningState: 'ready'` and
    `listeningState: 'error'` events; `CapacitorSttEngine` keys its startup
    watchdog and silence handling on them. Note the stock `'started'` event
    is `onBeginningOfSpeech` — user speech, not launch.
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
