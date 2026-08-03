# App store submission checklist

The path from where aloud is now to live on the App Store and Google Play. This
is the **map**; the how-to lives in [mobile.md](mobile.md) (build the native
projects) and [mobile-signing.md](mobile-signing.md) (sign + upload). Tracks
bead `meditation-pal-7rh`.

Right-sized for a small project: get onto TestFlight / Play internal testing
fast, validate on a real device, then go live. Phase 0 is the only part that can
actually get you rejected; the rest is chores you work through once.

## Where we are

Already done:

- [x] Native projects generated + committed (`ts/ios`, `ts/android`); iOS builds for the simulator.
- [x] iOS Info.plist: mic + speech permission strings, Google URL scheme, Sign in with Apple wiring. Android manifest: `RECORD_AUDIO` + `INTERNET`.
- [x] App icons (iOS set, Android adaptive). AGPL App Store exception (`LICENSE-EXCEPTION.md`, bead `84x`). *(Re-done 2026-07-23: the Capacitor projects were still shipping the stock placeholder icons; both now use the orb. Android adaptive foreground source: `assets/app-icon-android-fg.svg`.)*
- [x] Privacy policy + terms live (`docs/privacy`, `docs/terms`). Android `targetSdk 36` clears Play's floor.
- [x] Apple Developer Program membership (already used for macOS notarization).

What the beta build actually does on a phone: the LLM is **aloud cloud**
(sign-in + credits). Noting runs with no AI; Exploration / FeltSense call cloud.
The bundled on-device model tier (beads `dbd` / `7ej`) is not shipped yet, so
device RAM gates nothing in this build.

## Phase 0 - Validate on a real device (the critical path)

The one thing paperwork can't stand in for. Needs hardware.

- [x] Dev-install on your Android: Developer options (tap Build number 7x) → USB debugging → `npx cap run android` (from `ts/`). Detail in [mobile.md](mobile.md). *(Working 2026-07-20.)*
- [ ] Dev-install on an iPhone: Developer Mode → automatic signing → Run. Wanted but skippable for the first TestFlight; a base current iPhone is enough since the LLM is cloud.
- [ ] Audio session holds: mic during TTS (barge-in), 30-min session with screen off, survives backgrounding. Beads `nn1` / `0ao`. *(Partly validated - short sessions good; long screen-off run still owed. Internal testing is the natural place to finish this.)*
- [x] Native STT is good enough on real speech, or falls back to cloud cleanly. *(After the plugin patch + watchdog fix, 2026-07-21; cloud STT stays one tap away in the picker.)*

## Phase 1 - Sign-in + signing setup

- [ ] Google / Apple sign-in consoles (bead `tpj4`): Google iOS OAuth client + both client ids in server `GOOGLE_CLIENT_IDS`; Apple Services ID + "Sign in with Apple" capability. Guideline 4.8: offering Google on iOS requires Apple too.
- [ ] Google **Android** OAuth clients - one per signing cert: debug SHA-1 (dev installs) AND, once the Play app exists, the **App signing key** SHA-1 from Play Console → App integrity (store installs get re-signed by Google). See the gotcha in [mobile-signing.md](mobile-signing.md).
- [x] iOS: automatic signing (team id now in `project.pbxproj`; distribution cert + profile auto-created, Sign in with Apple capability enabled on the App ID via `-allowProvisioningUpdates`, 2026-08-03). Server `APPLE_CLIENT_IDS` must include the bundle id for the native Apple button to work.
- [ ] Android: create the upload keystore, enroll in Play App Signing, back the keystore up. Steps in [mobile-signing.md](mobile-signing.md). *(Gradle side is wired: `app/build.gradle` reads gitignored `android/keystore.properties` when present; `versionName` tracks the app version - bump it and `versionCode` each upload.)*

## Phase 2 - First beta deploy (no store review)

Fastest route to real testers.

- [ ] iOS: create the App Store Connect app record → Archive → Upload → add **internal** TestFlight testers (up to 100, no review). *(Record created; first build uploaded 2026-08-03: 2.6.1 (1), no Google URL scheme yet. Left: add internal testers; TestFlight for Mac on Apple Silicon can stand in for an iPhone.)*
- [ ] Android: create the Play Console app → **internal testing** track → upload `.aab` → add testers by email (no review).

## Phase 3 - Store paperwork (before production)

Easy to forget, because it's separate from the privacy *page*.

- [ ] Apple **App Privacy** labels + Google **Data Safety** form, filled from the real data flows (account email, transcribed audio, credits). **Email has two purposes, not one**: account management *and* product-update emails, since the signup opt-in (`Account.emailUpdates`, `sign-in-modal.ts` + the account page) keeps an opted-in address for that. In Play → Data safety → Personal info → Email address, add the **Developer communications** purpose and mark the collection **optional** (users can choose); in App Store Connect → App Privacy → Contact Info → Email Address, add **Developer's Advertising or Marketing**. The two labels differ because the taxonomies do, not because the behavior does: Play's "Advertising or marketing" means ads and promos and is **not** ticked, while Apple has no "developer communications" bucket and defines its marketing label to cover exactly this (email sent directly to users). Both consoles are the deploy - editing this file doesn't change the live answers. **Audio is a three-path answer**, matching `docs/privacy/index.html` → "Your voice": on-device (Whisper, desktop), the **platform recognizer** the mobile apps default to (Android's may route audio to Google - the app's own labels cover what *we* collect, so this is disclosed in the policy, not claimed as on-device), and aloud cloud (relayed to an STT provider, not retained). Nothing here should imply mobile speech never leaves the device - `580e049` removed exactly that claim from the UI.
- [x] iOS **privacy manifest** (`ts/ios/App/App/PrivacyInfo.xcprivacy`): tracking = false, UserDefaults required-reason (CA92.1), wired into the App target. Collected-data-types left empty; the App Store Connect labels above are the source of truth.
- [x] iOS **export compliance**: `ITSAppUsesNonExemptEncryption` = `false` in Info.plist (HTTPS-only is exempt) skips the per-upload prompt.
- [ ] **Reviewer note**: Noting works free with no account; give a demo path for the credit flow (heads off a Guideline 5.1.1 "why must I sign in" rejection).
- [ ] Listing assets: screenshots (required sizes), description, keywords, support + privacy URLs, age / content rating. Copy direction in bead `7ej` (lead with values, no device-spec claims). Play also wants a 1024x500 feature graphic + 512 icon.
- [ ] **Promo video** (optional; Play takes a YouTube URL, not a file). Beta-grade
      recipe: screen-record one short real session on the phone (system settings →
      screen recorder, audio source **"media and mic"** so both the facilitator's
      TTS and your voice land in the file), then run
      `./scripts/build-promo-video.sh <recording.mp4>` to top and tail it with
      `assets/store/video-title-card.png` / `video-end-card.png`. Upload
      **unlisted** to YouTube and paste the full `watch?v=` URL - Play rejects
      `youtu.be` short links, playlist/timestamp params, age-restricted videos,
      and videos with ads enabled. Aim for 30s-2min. Do a proper landscape cut
      for the production listing.

## Phase 4 - Go live (production)

- [ ] iOS: submit for App Store review (a few days). External TestFlight testers need a one-time light Beta App Review; internal testers don't.
- [ ] Android: promote internal → closed / open → production (review, a few days). If the Play account is personal and created after Nov 13 2023, production access needs 20 testers for 14 days first; internal testing doesn't.

## Optional, not blocking the beta

- [ ] Trademark the stylized "aloud." mark (bead `lkh`) - for clone takedowns later, not for approval.
- [ ] Native StoreKit / Play Billing consumable credit packs (deferred; the beta uses the web Stripe link-out, which is sanctioned in the US/UK/EEA per bead `zp47`).
