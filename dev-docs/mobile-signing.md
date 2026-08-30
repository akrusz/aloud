# Mobile signing & release walkthrough (iOS TestFlight + Android Play)

How to sign and ship the app once the native projects build. This is the part
that needs *your* accounts and certificates - it can't be automated headlessly.
Pairs with [mobile.md](mobile.md) (generate + build) and the beta plan in bead
`meditation-pal-zp47` (US-only TestFlight / Play internal testing, web-purchase
credits, no IAP).

`ts/ios/` and `ts/android/` are **committed** (they carry hand-edited native
config: Info.plist permission strings, the Google URL scheme, the Sign in with
Apple capability, signing config, icons). `npx cap sync` updates web assets +
plugins in place; never re-run `cap add` over them. Keep secrets (keystore,
client secrets) out of git - see the checklist at the end.

## iOS → TestFlight

**Prerequisites**

- Apple Developer Program membership ($99/yr).
- The bundle id `app.aloud.meditation` registered as an App ID at
  developer.apple.com → Certificates, IDs & Profiles → Identifiers. Enable the
  **Sign in with Apple** capability on it (needed for native Apple sign-in,
  `tpj4`).
- An app record in App Store Connect (appstoreconnect.apple.com) using that
  bundle id.

**Sign & upload (Xcode GUI - simplest first time)**

1. `cd ts && npm run ui:build && npx cap sync ios`, then `npx cap open ios`.
2. Select the **App** target → **Signing & Capabilities**:
   - Check **Automatically manage signing**.
   - Pick your **Team**. Xcode creates the signing certificate + provisioning
     profile for you.
   - Confirm **Sign in with Apple** is listed under Capabilities (add it with
     "+ Capability" if not).
3. Set the **version** (e.g. 2.0.0) and **build number** (bump every upload).
4. Choose destination **Any iOS Device (arm64)** (not a simulator).
5. **Product → Archive**. When it finishes, the Organizer opens.
6. **Distribute App → App Store Connect → Upload**. Follow the prompts (it
   validates, signs, and uploads).
7. In App Store Connect → your app → **TestFlight**: once the build finishes
   processing, add **Internal Testers** (up to 100; no Beta App Review needed).
   Testers install via the **TestFlight** app on their device.

**External testers** (up to 10,000) need a one-time lightweight **Beta App
Review** - this is the "in beta for N weeks" gate. Internal testing does not.

**CLI path** (proven 2026-08-03; works with ZERO registered iOS devices).
With no devices on the team, Xcode can't mint a *development* profile, so a
normal signed archive fails ("Your team has no devices"). The workaround:
archive **unsigned**, then let the export step do App Store distribution
signing, which needs no device. `-allowProvisioningUpdates` (with Xcode signed
in to the Apple ID) auto-creates the distribution cert + profile and even
enables the Sign in with Apple capability on the App ID from App.entitlements.

```bash
cd ts && VITE_ALOUD_CLOUD_URL=https://aloud-cloud.fly.dev npm run cap:sync
cd ios/App
xcodebuild archive -workspace App.xcworkspace -scheme App \
  -destination "generic/platform=iOS" -archivePath /tmp/App.xcarchive \
  CODE_SIGNING_ALLOWED=NO
xcodebuild -exportArchive -archivePath /tmp/App.xcarchive \
  -exportOptionsPlist ExportOptions.plist -allowProvisioningUpdates
```

ExportOptions.plist: `method` = `app-store-connect`, `signingStyle` =
`automatic`, `teamID` = the team id, `destination` = `upload` (or `export`
for a local .ipa dry-run first). Build numbers are auto-assigned at export
(`manageAppVersionAndBuildNumber` defaults to true), so re-uploading never
collides - no need to touch `CURRENT_PROJECT_VERSION`. Keep
`MARKETING_VERSION` in `project.pbxproj` matched to the app version
(`ts/package.json`) before archiving.

[Fastlane](https://fastlane.tools) (`fastlane pilot upload`) is the usual way to
script the archive→upload→TestFlight loop for CI, if this ever needs CI.

---

## Android → Play internal testing

**Prerequisites**

- Google Play Console account ($25 one-time).
- An app created in the Play Console with package `app.aloud.meditation`.

**Create an upload keystore** (once - back it up; losing it is painful):

```bash
keytool -genkey -v -keystore aloud-upload.jks -alias aloud \
  -keyalg RSA -keysize 2048 -validity 10000
```

Keep `aloud-upload.jks` and its passwords **out of git**. Reference them from
`android/keystore.properties` (also gitignored) - `android/app/build.gradle`
already reads it and signs `bundleRelease` when the file exists (release builds
are unsigned without it, so CI and fresh clones still build):

```
# android/keystore.properties  (never commit)
storeFile=/absolute/path/aloud-upload.jks
storePassword=…
keyAlias=aloud
keyPassword=…
```

**Enroll in Play App Signing** (recommended): Google holds the real app-signing
key; your upload key only signs uploads, so a lost upload key is recoverable.

> **Google sign-in gotcha**: with Play App Signing, Google **re-signs** the
> store-delivered app with its app-signing key, so its certificate fingerprint
> differs from your upload and debug keys. Google sign-in on Android works by
> matching package + signing-cert SHA-1 against an Android OAuth client, which
> means you need one per fingerprint: debug key (dev installs), and the **App
> signing key** SHA-1 from Play Console → Protected with Play → Play Store
> distribution → Play app signing (store installs). Register only the debug
> SHA-1 and sign-in works in dev but fails in every Play-delivered build.

**Build a release bundle & upload**

```bash
scripts/android-aab.sh   # bumps versionCode, syncs versionName from
                         # ts/package.json, ui:build + cap sync + bundleRelease,
                         # commits the build.gradle bump, prints release notes
# → android/app/build/outputs/bundle/release/app-release.aab
```

(`--no-bump` rebuilds the current version. Manual equivalent:
`npm run ui:build && npx cap sync android`, then
`cd android && ./gradlew bundleRelease`.)

Upload the `.aab` to Play Console → **Testing → Internal testing** → create a
release, add testers by email. Internal testing has no review wait. Own-billing
/ external-purchase link-out for credits is sanctioned in the US/UK/EEA (per
`zp47`), so no Play Billing IAP is needed for the beta.

---

## Secrets checklist (never commit)

- iOS: signing certs/profiles live in your Keychain / Apple account (Xcode
  managed). Nothing app-repo-side if using automatic signing.
- Android: `aloud-upload.jks` + `keystore.properties`.
- Build-time client ids (`VITE_GOOGLE_IOS_CLIENT_ID`, etc.) are public and fine
  to bake, but keep them in your CI env, not hardcoded.

## Related

[store-submission-checklist.md](store-submission-checklist.md) (the end-to-end
checklist this walkthrough plugs into), `zp47` (beta plan), `tpj4` (native
sign-in - needs the Apple capability + Google URL scheme above), `mobile.md`
(build), `7rh` (store submission).
