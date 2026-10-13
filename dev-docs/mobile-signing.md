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

**CLI path** (proven 2026-08-03; works with ZERO registered iOS devices):

```bash
scripts/ios-archive.sh            # sync MARKETING_VERSION from ts/package.json,
                                  # ui:build + cap sync ios, archive, sign with
                                  # App.entitlements, check, commit the version
# → ts/ios/App/build/App.xcarchive
scripts/ios-archive.sh --upload   # sign that archive for distribution and send
                                  # it to App Store Connect
```

`scripts/release.sh` offers the build at the end of a release, with the Android
bundle. The upload is its own step, run by hand.

With no devices on the team, Xcode can't mint a *development* profile, so a
normal signed archive fails ("Your team has no devices"). The workaround:
archive **unsigned**, then let the export step do App Store distribution
signing, which needs no device. `-allowProvisioningUpdates` (with Xcode signed
in to the Apple ID) auto-creates the distribution cert + profile, and the
profile carries the App ID's Sign in with Apple capability. What the script
runs, the last command being `--upload`:

```bash
cd ts && npm run ui:build && npx cap sync ios
cd ios/App
xcodebuild archive -workspace App.xcworkspace -scheme App \
  -destination "generic/platform=iOS" -archivePath build/App.xcarchive \
  CODE_SIGNING_ALLOWED=NO
APP=build/App.xcarchive/Products/Applications/App.app
codesign -f -s - "$APP"/Frameworks/*.framework
codesign -f -s - --entitlements App/App.entitlements "$APP"
xcodebuild -exportArchive -archivePath build/App.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/export \
  -allowProvisioningUpdates
```

**The two `codesign` lines are not optional.** An unsigned archive carries no
entitlements, and the export signs with what the archive carries plus the four
it always adds (`application-identifier`, the team id, `get-task-allow`,
`beta-reports-active`). What the profile *allows* does not get claimed for you.
2.15.0 went up without them, so without `com.apple.developer.applesignin`, and
Sign in with Apple failed in the app with `AuthorizationError error 1000`
before any request reached the server. The export reported success throughout.
An ad-hoc signature is enough to carry `App.entitlements` through; the export
replaces it with the distribution one (frameworks first, since `codesign`
refuses an app whose nested code is unsigned). The script stops, after the
archive and again before the upload, if the archive lacks any entitlement
`App.entitlements` declares.

The same check by hand, on the archive and on a build already out:

```bash
codesign -d --entitlements - "$APP" | grep applesignin          # the archive
codesign -d --entitlements - "/Applications/aloud 2.app/Wrapper/App.app"
```

The second is a TestFlight build installed on an Apple Silicon Mac (the name
gets a number when the desktop app holds `aloud.app`). For an .ipa, set
`destination` to `export`, unzip it and point the same command at
`Payload/App.app`.

`ts/ios/App/ExportOptions.plist`: `method` = `app-store-connect`,
`signingStyle` = `automatic`, `teamID` = the team id, `destination` = `upload`
(or `export` for a local .ipa dry-run first). Build numbers are auto-assigned
at export (`manageAppVersionAndBuildNumber` defaults to true), so re-uploading
never collides - no need to touch `CURRENT_PROJECT_VERSION`.
`MARKETING_VERSION` in `project.pbxproj` follows the app version
(`ts/package.json`): `release.sh` sets it in the version-bump commit, and the
script syncs it again before archiving.

`error: exportArchive Failed to Use Accounts` means Xcode has no Apple account
signed in (it can drop one between uploads): Xcode → Settings → Accounts, add
it back, rerun the export. The archive is still good.

An upload that sits at `Preparing to upload 'App.ipa'…` for more than a minute
or two is stuck, not slow (a good one took 16 seconds there, 2026-10-11). Xcode
27's upload helper (`swinfo`) asks `xcrun` for `dwarfdump-classic`, which Xcode
no longer ships, so the lookup falls through to
`/Library/Developer/CommandLineTools`. If that is an old Intel-only install on a
Mac without Rosetta, the tool cannot start and the helper waits on it forever,
with no error and no child process. Check with
`file "$(xcrun -sdk iphoneos -f dwarfdump-classic)"`: a path under
CommandLineTools that reports only `x86_64` is the problem. Fix: kill the
export, `sudo mv /Library/Developer/CommandLineTools{,-old} && xcrun --kill-cache`,
rerun. With no such tool to find, the helper uses Xcode's own `dwarfdump`.

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
