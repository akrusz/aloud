# App store submission checklist

What is left between aloud and live listings on Google Play and the App Store.
This is the **map**; the how-to lives in [mobile.md](mobile.md) (build the native
projects), [mobile-signing.md](mobile-signing.md) (sign + upload) and
[mobile-signin-setup.md](mobile-signin-setup.md) (OAuth consoles). Tracks bead
`meditation-pal-7rh`. Finished steps are deleted, not ticked: if it isn't here,
it's done.

## Where we are (2026-09-19)

**Android** is on Play **internal testing**, installed by a few hand-added
testers. Signing, Play App Signing, the App-signing-key OAuth client (sign-in
works in Play-delivered builds), the reviewer demo account + App access
instructions, the content rating and the Data Safety form are all in. The six
phone fixes that gated the beta are verified on a device.

**iOS** is parked behind Android: one TestFlight build (2.6.1, 2026-08-03), run
on the simulator only, some App Store Connect info filled in. Google sign-in is
**not** wired (no URL scheme in `Info.plist` yet).

What the mobile build does: the LLM is **aloud cloud** (sign-in + credits).
**Noting defaults to a circle of one sound participant**, which calls no model
and needs no account; swapping in an AI companion puts you on cloud.

Known and accepted: no barge-in on native STT (`x4h4`), no anonymous first sit on
iPhone **web** (`2dy1`; the native apps are unaffected).

## Android: the road to production

The Play account is personal but long predates Nov 13 2023, so the closed-test
rule for new personal accounts (N opted-in testers for 14 days) **does not
apply**: internal testing can be promoted straight to production review.

- [ ] **Listing pass** (see "Each store update" below for the copy): recheck
      screenshots against the current UI (2+ phone, portrait 9:16), short + full
      description, feature graphic and 512 icon (`assets/store/`), support +
      privacy URLs.
- [ ] **Long-sit audio check** on a Play-installed build: a 30-minute session
      with the screen off, and one round trip through backgrounding. Short
      sessions are good; this one was still owed.
- [ ] **Promote to production**: create the production release from the tested
      build, pick countries, roll out. **Review takes a few days**, then it is
      live. Once it is public, update the site's platform line
      (`docs/index.html`: "iOS and Android are in closed beta"), the README
      platform notes and the store links.
- [ ] **Promo video** (optional, its own session). Play takes a YouTube URL, not
      a file. Screen-record one short real session on the phone (screen
      recorder, audio source **"media and mic"** so both voices land in the
      file), then `./scripts/build-promo-video.sh <recording.mp4>` tops and tails
      it with `assets/store/video-title-card.png` / `video-end-card.png`. Upload
      **unlisted** and paste the full `watch?v=` URL: Play rejects `youtu.be`
      links, playlist or timestamp params, age-restricted videos and videos with
      ads on. 30s to 2min; a proper landscape cut for the production listing.

## Each store update (do it in one pass)

- [ ] Bump `versionCode` **and** `versionName` in `ts/android/app/build.gradle`
      (Play refuses a reused `versionCode`), then `scripts/android-aab.sh` and
      upload the `.aab` to the track.
- [ ] Release notes ("What's new") for the track.
- [ ] **Store copy**: `dev-docs/store-descriptions.md` is the source, the
      consoles are the deploy. Paste any changed paragraph into Play Console
      (and App Store Connect once iOS is live).
- [ ] **Data handling changed?** Then the Data Safety form (and Apple's App
      Privacy labels) change with the privacy policy, in the same pass. The
      answers on file are below.
- [ ] Screenshots, if the setup or session screen changed.

For the release after 2.9.0 specifically: the new voice-commands paragraph in
the store description, and a look at Data Safety. Voice commands send what is
said through aloud cloud to a classifier, which is the same "in-app messages,
ephemeral, not shared" row hosted sessions already declare, so no change is
expected. Confirm it reads true rather than assume.

## Privacy answers on file

Both consoles are the deploy; editing this file changes nothing live. Kept here
because Apple's labels are still to be filled from the same facts.

- **Messages → other in-app messages**: collected, **ephemeral**, optional, app
  functionality, not shared (LLM / STT / TTS / classifier vendors fall under the
  service-provider exemption).
- **Audio → voice recordings**: the same. It is a **three-path** answer, matching
  `docs/privacy/index.html` → "Your voice": on-device (Whisper, desktop), the
  **platform recognizer** the mobile apps default to (Android's may route audio
  to Google: the labels cover what *we* collect, so that is disclosed in the
  policy, not claimed as on-device), and aloud cloud (relayed, not retained).
  Nothing may imply mobile speech never leaves the device.
- **Email address**: collected, not ephemeral, optional, deletable. **Two
  purposes**: account management *and* product-update emails (the signup opt-in,
  `Account.emailUpdates`). On Play that is the **Developer communications**
  purpose, with "Advertising or marketing" left unticked (Play means ads). Apple
  has no such bucket and defines **Developer's Advertising or Marketing** to
  cover exactly this, so on Apple that one is ticked. The labels differ because
  the taxonomies do.
- **Purchase history**: collected, not ephemeral, optional, deletable.
- **Account deletion URL**: `https://aloud.rest/delete-account/`.
- **GenAI policy**: in-session ⓘ → "Report AI content", on both session views.

## iOS

Guideline 4.8: shipping Google sign-in on iOS makes Sign in with Apple
mandatory. The Apple side exists already (automatic signing, the capability on
the App ID, `PrivacyInfo.xcprivacy`, export-compliance flag).

- [ ] **Google iOS sign-in** (bead `tpj4`): create the Google iOS OAuth client,
      put its **reversed client id** in `Info.plist` as the URL scheme (App
      Store Connect rejects a placeholder, ITMS-90158, so the file carries only
      a comment today), and add both audiences to the server's
      `GOOGLE_CLIENT_IDS` / `APPLE_CLIENT_IDS`. Steps in
      [mobile-signin-setup.md](mobile-signin-setup.md).
- [ ] **Run it on a real iPhone**: Developer Mode → automatic signing → Run, then
      section 3 of [manual-smoke.md](manual-smoke.md). Nothing on iOS has been
      proven on hardware. TestFlight for Mac on Apple Silicon can stand in for a
      first look, not for the audio path.
- [ ] New TestFlight build with sign-in working → add **internal** testers (up to
      100, no review). External testers need a one-time light Beta App Review.
- [ ] **App Privacy labels**, from "Privacy answers on file" above.
- [ ] **Reviewer note**: Noting works free with no account. It **defaults** to a
      circle of one sound participant and a static opener, so a reviewer who
      taps straight through never meets the sign-in modal. Say so, say that an
      AI companion is what switches it to the paid cloud path, and give the demo
      account for the credit flow (heads off a Guideline 5.1.1 "why must I sign
      in" rejection). The Play App access text is the template.
- [ ] Listing assets: screenshots in Apple's required sizes, description,
      keywords, support + privacy URLs, age rating.
- [ ] Submit for App Store review (a few days).

## Optional, not blocking

- [ ] Trademark the stylized "aloud." mark (bead `lkh`): for clone takedowns
      later, not for approval.
- [ ] Native StoreKit / Play Billing credit packs. Deferred: the beta uses the
      web Stripe link-out, sanctioned in the US/UK/EEA per bead `zp47`.
