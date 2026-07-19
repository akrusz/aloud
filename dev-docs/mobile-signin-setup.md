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

## 2. Apple Developer - Sign in with Apple

Certificates, IDs & Profiles → **Identifiers** → your App ID
(`app.aloud.meditation`) → enable **Sign in with Apple** → Save. That's all iOS
native Apple needs - the token's audience is the **bundle id**, so there's no
Services ID to create for the app (the Services ID is only for the *web* Apple
flow, which you already have). The `App.entitlements` file is already in the
project requesting this capability.

## 3. Info.plist - paste the reversed client id

In `ts/ios/App/App/Info.plist`, replace the placeholder:

```
com.googleusercontent.apps.REPLACE_WITH_REVERSED_IOS_CLIENT_ID
```

with your real reversed iOS client id from step 1. (Apple needs no URL scheme.)

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
