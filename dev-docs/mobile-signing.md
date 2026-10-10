# Mobile signing & release walkthrough (iOS TestFlight + Android Play)

How to sign and ship the app once the native projects build. This is the part
that needs *your* accounts and certificates - it can't be automated headlessly.
Pairs with [mobile.md](mobile.md) (build) and the beta plan in bead
`meditation-pal-zp47` (US-only TestFlight / Play internal testing, web-purchase
credits, no IAP). Where each store stands:
[store-submission-checklist.md](store-submission-checklist.md).

`ts/ios/` and `ts/android/` are committed and carry hand-edited native config:
`npx cap sync` updates them in place; never re-run `cap add` over them.

## iOS → TestFlight

Already in place: the App ID `app.aloud.meditation` (developer.apple.com →
Identifiers) with the **Sign in with Apple** capability, and the App Store
Connect app record on that bundle id.

**Xcode GUI path**: `cd ts && npm run cap:ios`, then on the **App** target →
**Signing & Capabilities** check **Automatically manage signing**, pick the
Team, and confirm **Sign in with Apple** is listed. Set the version and bump the
build number, choose **Any iOS Device (arm64)**, **Product → Archive**, then
**Distribute App → App Store Connect → Upload**.

In App Store Connect → **TestFlight**, add **Internal Testers** once the build
finishes processing (up to 100, no review). **External testers** (up to 10,000)
need a one-time lightweight **Beta App Review**.

**CLI path** (proven 2026-08-03; works with ZERO registered iOS devices).
With no devices on the team, Xcode can't mint a *development* profile, so a
normal signed archive fails ("Your team has no devices"). The workaround:
archive **unsigned**, then let the export step do App Store distribution
signing, which needs no device. `-allowProvisioningUpdates` (with Xcode signed
in to the Apple ID) auto-creates the distribution cert + profile and even
enables the Sign in with Apple capability on the App ID from App.entitlements.

```bash
cd ts && npm run cap:sync
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

---

## Android → Play internal testing

The Play Console app (`app.aloud.meditation`) and the upload keystore exist
(`~/keys/aloud-upload.jks`, created 2026-07-30 - back it up). It was made with:

```bash
keytool -genkey -v -keystore aloud-upload.jks -alias aloud \
  -keyalg RSA -keysize 2048 -validity 10000
```

Keep the keystore and its passwords **out of git**. Reference them from
`android/keystore.properties` (also gitignored) - `android/app/build.gradle`
reads it and signs `bundleRelease` when the file exists (release builds are
unsigned without it, so CI and fresh clones still build):

```
# android/keystore.properties  (never commit)
storeFile=/absolute/path/aloud-upload.jks
storePassword=…
keyAlias=aloud
keyPassword=…
```

The app is enrolled in **Play App Signing**: Google holds the real app-signing
key and the upload key only signs uploads, so a lost upload key is recoverable.
It also means Google **re-signs** the store-delivered app, so its certificate
fingerprint differs from the upload and debug keys, and Google sign-in needs an
Android OAuth client per fingerprint. The registered ones are recorded in
[mobile-signin-setup.md](mobile-signin-setup.md#registered-fingerprints-keep-this-current).

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

Related beads: `zp47` (beta plan), `tpj4` (native sign-in), `7rh` (store
submission).
