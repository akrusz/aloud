# Mobile build guide (Capacitor — iOS & Android)

How to build and run the aloud mobile app. The shell is **Capacitor** (not
Tauri mobile — decision in bead `meditation-pal-zp47` / `-nn1`): it wraps the
same `ts/ui` web app in the OS system WebView (WKWebView / Android System
WebView) and adds native plugins for the things a browser can't do. Desktop
stays on Tauri; only the mobile shell + a few platform adapters differ.

This doc is the source of truth for the **native-side config that isn't
checked in**. The generated `ts/ios/` and `ts/android/` projects are
`.gitignore`d (they're regenerated with `npx cap add`), so anything you'd
normally edit inside them — permission strings, icons — is documented here so a
fresh clone can reproduce a working build.

## What runs where

- **UI**: `ts/ui` built to `ts/ui/dist` (`webDir` in `capacitor.config.ts`),
  loaded from `capacitor://localhost` (iOS) / `https://localhost` (Android).
- **App mode**: a production Capacitor build resolves to **web mode**
  automatically (`app-mode.ts` → not Tauri, not `import.meta.env.DEV` → `web`).
  So Ollama / claude-proxy are hidden and **aloud cloud** is the default
  provider, exactly like the hosted website.
- **Backends**: there is no on-device backend. `/app/v1` (catalogs, system-info)
  and `/cloud/v1` (auth, credits, metered LLM/STT/TTS) both resolve **off-origin
  to aloud cloud**, via `VITE_ALOUD_CLOUD_URL` baked into the build. You MUST
  build with that set (see below) or the app has no backend.

### Native adapters (swap on `isCapacitor()`)

Everything mobile-specific is gated on `isCapacitor()` (`ui/src/is-desktop.ts`)
and is a no-op on web/desktop, so these changes never touch the other builds:

| Concern | Native (Capacitor) | Web / desktop | File |
|---|---|---|---|
| Storage | `CapacitorKv` (@capacitor/preferences — durable UserDefaults / SharedPreferences) | `LocalStorageKv` | `adapters/kv.ts`, `adapters/capacitor-kv.ts` |
| STT | `CapacitorSttEngine` (SFSpeechRecognizer / Android SpeechRecognizer) | web-speech / server-whisper / aloud cloud | `adapters/stt-picker.ts`, `adapters/capacitor-stt.ts` |
| Keep-awake | `@capacitor-community/keep-awake` | web Wake Lock API | `wakelock.ts` |
| External links / Stripe | `@capacitor/browser` (in-app SFSafariViewController / Custom Tab) | Tauri opener / full-page redirect | `external-links.ts` |
| Sign-in | email (works from any origin); Google/Apple hidden until native (`tpj4`) | web GIS / Apple JS, or desktop loopback PKCE | `sign-in-modal.ts` |

## Prerequisites

- **Node** (repo's version) + the deps: `cd ts && npm install`.
- **iOS**: macOS, Xcode, and **CocoaPods** (`sudo gem install cocoapods` or
  `brew install cocoapods`). An Apple Developer account for signing / TestFlight.
- **Android**: Android Studio (or the SDK command-line tools), a **JDK 17+**,
  and `ANDROID_HOME` set. A Play Console account for internal testing.

> The dev machine used for the platform-layer work had the `cap` CLI + Xcode but
> **no CocoaPods, no Android SDK, no JDK** — enough to write and test the
> web-side TS, not to generate/build the native projects. That split is why this
> guide exists: the TS layer is committed and CI-tested; the native build is
> reproduced from here on a properly tooled machine.

## First build

```bash
cd ts
npm run ui:build                          # produces ui/dist (webDir)
# Bake the hosted origin so /app/v1 + /cloud/v1 resolve to aloud cloud:
VITE_ALOUD_CLOUD_URL=https://aloud-cloud.fly.dev npm run ui:build

npx cap add ios                           # generates ts/ios/ (gitignored)
npx cap add android                       # generates ts/android/ (gitignored)
npx cap sync                              # copies ui/dist + plugins into native

npx cap open ios                          # → Xcode  (run on simulator/device)
npx cap open android                      # → Android Studio
```

After any UI change: `npm run ui:build && npx cap sync` (or `npx cap copy` for
web-asset-only changes). For fast iteration use live-reload: uncomment the
`server` block in `capacitor.config.ts` (point `url` at your LAN Vite dev
server) or run `npx cap run ios --livereload --external`.

## Required native config (re-apply after `cap add`)

### iOS — `ios/App/App/Info.plist`

The mic + speech-recognition permission strings. Without these iOS **crashes**
the moment the plugin asks for the mic, rather than showing a prompt:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>aloud listens while you speak so it can respond in your practice.</string>
<key>NSSpeechRecognitionUsageDescription</key>
<string>aloud transcribes your speech on your device to understand what you share.</string>
```

(These are visible user-facing copy — keep them honest and warm, and mind the
brand copy rules: no em-dashes, no "AI" tells.)

### Android — `android/app/src/main/AndroidManifest.xml`

```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.INTERNET" />
```

`INTERNET` is present by default; `RECORD_AUDIO` must be added. The
speech-recognition plugin requests it at runtime (first mic use).

### App icons

iOS **rejects icons with an alpha channel**, so the transparent orb
(`ts/ui/public/aloud.png`) can't be used directly. A flattened, alpha-stripped
source is ready at `assets/aloud-orb-icon-opaque-1024.png` (orb on white, RGB,
1024²). Use it for the iOS icon set; Android allows alpha + adaptive icons, so
the transparent orb is fine there. Finalize the iOS background (white vs
warm-gradient vs dark) before store submission. See bead `meditation-pal-3k5`.

## Payments (beta)

Zero IAP code for the beta. Credits are bought on **aloud.rest via Stripe** and
are account-bound, so they appear in the app after purchase via the existing
ledger/auth. The buy-credits modal opens Stripe in `@capacitor/browser` and
polls `/me` for the balance to land (Stripe can't redirect back into the
`capacitor://` origin, so there's no return URL — same waiting flow as desktop).
USDC/x402 is hidden on mobile (App Store 3.1.1 forbids crypto unlocks; the modal
already hides it when `window.ethereum` is absent). Native StoreKit / Play
Billing consumable packs are deferred to public launch — see `zp47`, `czr`,
`a2j`.

## Still device-dependent (not done, needs real hardware)

The TS layer is complete and tested, but these can only be validated on a
device/simulator and are tracked separately:

- **iOS audio session** — `playAndRecord` + concurrent mic during TTS playback
  (barge-in), 30-min playback with the screen off, survives backgrounding. This
  is the crux from `meditation-pal-nn1`. WKWebView's `getUserMedia` should work
  once `NSMicrophoneUsageDescription` is set, but the session category behavior
  under TTS playback is the open risk.
- **Native STT quality** for meditation speech (long pauses, soft/whispered
  speech, 1–2 word noting) — `meditation-pal-0ao`. If native cuts off, the
  cloud-Whisper fallback (`aloud` STT) already works on mobile.
- **Keep-awake** actually holding the screen on across a full session.
- **Native Google/Apple sign-in** from the `capacitor://` origin —
  `meditation-pal-tpj4` (decision + plugin choice; email works meanwhile).

## Related beads

`zp47` (beta plan) · `3k5` (wrapper) · `7rh` (store submission) · `nn1` (shell
decision) · `0ao` (STT validation) · `dbd` (LLM tiers) · `7ej` (capability
comms) · `czr` (cross-platform credits) · `tpj4` (native sign-in).
