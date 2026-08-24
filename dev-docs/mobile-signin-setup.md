# Native mobile sign-in - console + config checklist

Everything needed to turn on native Google + Apple sign-in in the iOS app
(bead `meditation-pal-tpj4`). The **code is done and compiles**; what's left is
console setup + a few values only you can create. Do these and the native
buttons light up; skip any and that provider's button simply doesn't render
(email still works, and it stays App-Store-compliant).

App Store Guideline 4.8: on iOS, offering Google requires also offering Apple.
The code renders both when configured - Apple needs no client id on iOS (below),
so doing Google means doing Apple too. Both are set up here.

## The short version

| # | Where | What | Feeds |
|---|-------|------|-------|
| 1 | Google Cloud | Create an **iOS OAuth client** (bundle `app.aloud.meditation`) | client id + reversed id |
| 2 | Apple Developer | Enable **Sign in with Apple** capability on the App ID | (entitlement already in the project) |
| 3 | `Info.plist` | Paste the **reversed** iOS client id into the URL scheme | Google redirect |
| 4 | Build env | `VITE_GOOGLE_IOS_CLIENT_ID` (+ `VITE_GOOGLE_CLIENT_ID` for Android) | the app |
| 5 | Server (Fly) | `GOOGLE_CLIENT_IDS` += iOS client id; `APPLE_CLIENT_IDS` += `app.aloud.meditation` | token verification |
| 6 | Xcode | Confirm **Sign in with Apple** shows under Signing & Capabilities | signing |

## 1. Google Cloud - iOS OAuth client

APIs & Services → Credentials → **Create credentials → OAuth client ID → iOS**.
Bundle ID: `app.aloud.meditation`. You get:
- an **iOS client ID** like `1234567890-abc.apps.googleusercontent.com`
- its **reversed** form `com.googleusercontent.apps.1234567890-abc` (Google shows
  both; the reversed one is the URL scheme).

Keep your existing **web** client ID (`VITE_GOOGLE_CLIENT_ID`) - it stays the
Android/web audience.

## 1b. Google Cloud - Android OAuth client (SHA-1)

Android needs a second thing beyond the web client id: an **Android OAuth
client** in the same project, tied to the app's signing certificate. Without it
the account sheet opens, but picking an account fails - surfaced by the plugin
as "Google sign-in canceled by user".

Credentials → **Create credentials → OAuth client ID → Android**:
- Package name: `app.aloud.meditation`
- SHA-1: the signing cert of the build being tested. For dev installs that's
  the debug keystore:
  ```bash
  keytool -list -v -keystore ~/.android/debug.keystore \
    -alias androiddebugkey -storepass android | grep SHA1
  ```
- No client id lands in the app or server config - registration alone is what
  authorizes the signature. Nothing to bake or deploy.

Repeat with the **upload keystore's** SHA-1 when it exists, and - after
enrolling in Play App Signing - add **Play's app-signing SHA-1** (Play Console →
Test and release → App integrity), or store builds will fail the same way.

### Registered fingerprints (keep this current)

That "nothing to bake or deploy" is also why this step keeps getting silently
un-done: it's the only part of sign-in config that leaves **no artifact in the
repo**, so nothing fails at build time and there's no way to tell "done" from
"never done". Paired with the plugin reporting the failure as a user cancel
(`meditation-pal-7bi9`), a missing registration looks exactly like the button
not working. So record the state here.

Google Cloud project **1033783393687** (same project as the web + desktop client
ids in `ts/server/.env` - an Android client in any other project does nothing).
Package `app.aloud.meditation`:

| Signing key | SHA-1 | Registered |
|---|---|---|
| Debug (`~/.android/debug.keystore`, created 2026-07-05) | `4E:AD:8D:D0:70:77:56:28:CA:17:3B:E9:22:27:57:E8:29:67:CD:1E` | 2026-08-23 |
| Upload keystore | - | not yet |
| Play app-signing | - | not yet |

To check what's actually running on a device rather than what you assume is - the
signature that matters is the installed APK's, not the keystore you meant to use:

```bash
adb shell pm path app.aloud.meditation                  # → /data/app/.../base.apk
adb pull <that path> /tmp/aloud.apk
$ANDROID_HOME/build-tools/*/apksigner verify --print-certs /tmp/aloud.apk | grep SHA-1
```

A `CN=Android Debug` in that output means a debug-signed build, so it needs the
debug row above - a release-signed install needs a different row entirely.

## 2. Apple Developer - Sign in with Apple

Certificates, IDs & Profiles → **Identifiers** → your App ID
(`app.aloud.meditation`) → enable **Sign in with Apple** → Save. That's all iOS
native Apple needs - the token's audience is the **bundle id**, so there's no
Services ID to create for the app (the Services ID is only for the *web* Apple
flow, which you already have). The `App.entitlements` file is already in the
project requesting this capability.

## 3. Info.plist - add the reversed client id

`ts/ios/App/App/Info.plist` ships with **no** `CFBundleURLTypes` block - App
Store Connect rejects a placeholder scheme (underscores are invalid,
ITMS-90158). Add the block once the real reversed iOS client id from step 1
exists, next to the comment that marks the spot:

```xml
<key>CFBundleURLTypes</key>
<array><dict><key>CFBundleURLSchemes</key>
  <array><string>com.googleusercontent.apps.1234567890-abcdef</string></array>
</dict></array>
```

(Apple needs no URL scheme.)

## 4. Build-time env

Bake alongside `VITE_ALOUD_CLOUD_URL` when building the web bundle:

```bash
VITE_ALOUD_CLOUD_URL=https://aloud-cloud.fly.dev \
VITE_GOOGLE_IOS_CLIENT_ID=1234567890-abc.apps.googleusercontent.com \
VITE_GOOGLE_CLIENT_ID=<your existing web client id> \
npm run ui:build && npx cap sync ios
```

- `VITE_GOOGLE_IOS_CLIENT_ID` - required for Google on **iOS**.
- `VITE_GOOGLE_CLIENT_ID` - only needed for Google on **Android** (webClientId).
- Apple on iOS needs **no** env var (system flow off the bundle id).

## 5. Server (Fly) - accept the new token audiences

No code change; two env vars, then redeploy. The native tokens are verified by
`aud`:
- Google native iOS token `aud` = the **iOS client id** → add it to `GOOGLE_CLIENT_IDS`.
- Apple native iOS token `aud` = the **bundle id** → add `app.aloud.meditation` to `APPLE_CLIENT_IDS`.

```bash
fly secrets set \
  GOOGLE_CLIENT_IDS="<web client id>,<ios client id>" \
  APPLE_CLIENT_IDS="<existing services id>,app.aloud.meditation" \
  --app aloud-cloud
```

(Comma-separated; keep the existing web values. Verified against
`ts/server/src/auth/google.ts` / `apple.ts`, which check `aud ∈ *_CLIENT_IDS`.)

## 6. Xcode - confirm the capability

Open `npx cap open ios` → App target → **Signing & Capabilities**. With the
entitlement in the project, **Sign in with Apple** appears here automatically;
confirm it's listed and your Team is selected (automatic signing). If Xcode
flags it, it means step 2 (App ID capability) isn't done yet.

## Verifying after setup

Build to a device/simulator, open the sign-in modal: you should see **Continue
with Google**, **Continue with Apple**, then the email form. Tapping either runs
the native picker and lands you signed in (the token flows into the same
`googleSignIn`/`appleSignIn` the web app uses). If a button is missing, its
config (steps 1/3/4 for Google, step 2/6 for Apple) is incomplete.

Related: `dev-docs/mobile.md` (build), `dev-docs/mobile-signing.md` (TestFlight),
bead `tpj4`.
