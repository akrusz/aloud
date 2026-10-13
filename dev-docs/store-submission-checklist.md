# App store submission checklist

What is left between aloud and live listings on Google Play and the App Store.
This is the **map**; the how-to lives in [mobile.md](mobile.md) (build the native
projects), [mobile-signing.md](mobile-signing.md) (sign + upload) and
[mobile-signin-setup.md](mobile-signin-setup.md) (OAuth consoles). Tracks bead
`meditation-pal-7rh`. Finished steps are deleted, not ticked: if it isn't here,
it's done.

## Where we are (2026-10-11)

**Android** is on Play **internal testing** at **2.15.0, versionCode 43**,
installed by a few hand-added testers. Signing, Play App Signing, the
App-signing-key OAuth client (sign-in works in Play-delivered builds), the
reviewer demo account + App access instructions, the content rating, the Data
Safety form, the current descriptions and the promo video are all in.

**Production is gated.** The console requires a closed test with 12 opted-in
testers for 14 days before production access can even be applied for, and open
testing stays locked until then. So the public beta is a **closed test**,
recruited on Twitter, and production follows the application.

2.14.0 (versionCode 39) was the first Play build since 2.7.0 in August, so the
first to carry the recognizer session model (`lbl5`), the speaker re-request
after a lock (`wxj5`) and voice commands. Everything in between was verified on
dev installs only. A first test sit on it (2026-10-10) ran through, and left
two things to settle before testers are recruited: Bluetooth headphones
(`4xkx`, fixed in the tree, not yet run on a phone) and a long gap before a
check-in (`v85a`, shorter default waits and a truthful second ask are in, not
yet heard in a session).

**iOS** has a TestFlight build, 2.15.0 (2026-10-11; the one before was 2.6.1 in
August), with testers added, and **Sign in with Apple cannot work on it**: it
was signed without the entitlement, and email sign-up carries no credits. It
needs a new upload before anyone is sent to it (first item under "iOS").
Still run on the simulator and a Mac only, never an iPhone. Test Information
is not entered. Google sign-in is **not** wired (no URL scheme in
`Info.plist`), and is being skipped for testing builds.

What the mobile build does: the LLM is **aloud cloud** (sign-in + credits).
**Noting defaults to a circle of one sound participant**, which calls no model
and needs no account; swapping in an AI companion puts you on cloud.

Known and accepted: no barge-in on native STT (`x4h4`), no anonymous first sit on
iPhone **web** (`2dy1`; the native apps are unaffected).

## Android: the road through the closed test

The console's Production page (2026-10-10) asks for three things before
"Apply for access to production" opens: a published closed testing release, at
least 12 testers opted in, and 14 days of that test with 12 or more opted in
the whole time. This file used to say the account was old enough to be exempt.
It is not, and the console is the authority. Open testing "is available when
you have production access", so it is not a way around. Internal testers do not
count.

A closed test still gives what the open beta was for: testers **cannot leave
public ratings or reviews**, their feedback arrives privately in the console.

- [ ] **Bluetooth headphones (`4xkx`): retest on a build with the fix.** The
      phone's route log settled it: `MainActivity`'s speaker re-request
      outranked the WebView's own request for the headset, and the system
      picker cannot move a call stream. `MainActivity` now asks for a headset
      before the speaker (`AudioRoutePolicy`), unit-tested, not yet run on a
      device. With headphones on and aloud cloud speech recognition: begin,
      lock for ~30s, unlock - the reply is still in the headphones. Then switch
      the headphones off and on mid-session - the voice moves to the phone
      speaker and back.
- [ ] **Check-ins after a quiet stretch (`v85a`): hear it in a session.** Two
      passes stay. The default waits at the lower three stops are 12m / 5m / 3m
      now, and the second ask no longer tells the model its pass was an
      unanswered check-in. With Settings → Developer → "Check-in debug HUD" on,
      go quiet at Balanced and read what each ask decided.
- [ ] **The test sit, on the Play-installed build.** Uninstall the dev build
      first: same `applicationId`, different signing key, so Play cannot install
      over it (and the wipe gives a true first run). In one sitting:
      - Signed-out noting on the default circle: no sign-in modal (the claim the
        reviewer note rests on).
      - Google sign-in on the Play-signed build, and still signed in after a
        force-stop.
      - **30 minutes, with one lock/unlock in the middle.** The app keeps the
        screen on and a sit does not run with it off (`31zj`), so the check is
        that it picks up again after ~30s locked. Listen to the loudness after
        the unlock (`wxj5`), and do it once with Bluetooth headphones on.
      - Unplugged, three minutes without a touch: the screen goes black, and a
        tap brings it back with the session still running (`screen-dim.ts`,
        not yet run on a phone).
      - Start speaking a few seconds after the facilitator stops: the transcript
        begins where the sentence begins. That closes `0l0w` and the open half
        of `wlp9`.
      - One reply on an Inworld voice (Luna, Wren, Silas, Clive): first phoneme
        intact (`2igi`).
      - One spoken command.
      - From the first build after 2.15.0: the opening and closing sounds play
        whole at a sensible level, and the opening is not taken as a turn
        (`signature-sound.ts`; no store build has carried them).
      - No buy button anywhere: the Account page shows the balance and "at
        aloud.rest/account" as text that does nothing when tapped, and "What are ☁?"
        offers only "Got it" once signed in.
- [ ] **Listing pass**: recheck screenshots against the current UI (2+ phone,
      portrait 9:16; they live only in the console), feature graphic and 512
      icon (`assets/store/`), support + privacy URLs. The descriptions and the
      promo video are in.
- [ ] **Data Safety: three rows to add, two to change** (Play Console → App
      content → Data safety). The form declares messages, audio, email and
      purchase history; the server also keeps account ids, usage rows and
      error records, which the privacy policy has described since September. A
      form that says less than the policy is what Play flags. And messages and
      audio go from ephemeral to not. All of it is under "Privacy answers on
      file".
- [ ] **A tester list people can join by link.** Closed testing takes email
      lists or Google Groups. A Google Group anyone can join turns "invite by
      email" into something to tweet; add its address under Closed testing →
      Testers, with the feedback email.
- [ ] **Closed testing release**: Create new release → **Add from library** →
      the tested bundle (promote only goes up the ladder, the library works in
      any direction). Pick countries (billing no longer limits the choice), send
      for review. The first closed release is reviewed.
- [ ] **Turn on the beta bonus** (`bb4k`): 40 ☁ once for a Google/Apple
      sign-in from the store build, the thing to offer in the recruiting post.
      Set `ALOUD_BETA_BONUS_CLIENT_IDS` on Fly to the Play app-signing Android
      client id (Google Cloud → Credentials) plus `app.aloud.meditation`, the
      audience of an iOS Apple sign-in, for TestFlight, and deploy the server.
      iOS has no Google sign-in, so there is no iOS Google id to list. The first
      Android sign-in logs `beta bonus check` with the token's clients: if
      `eligible` is false there, the id in the list is not the one the build
      presents. Testers already signed in get it on their next sign-in.
- [ ] **Recruit, well past 12.** Two links, in this order: join the group, then
      the opt-in link the console shows under Testers
      (`https://play.google.com/apps/testing/app.aloud.meditation`), then
      install from Play with the same Google account. The 12 must hold for the
      14 days running before the application, and people drop out, so ask
      testers to stay opted in. The site's platform line (`docs/index.html`:
      "iOS and Android are in closed beta") can carry the group link once the
      release is approved; a `docs/` push goes live at once, so not before.
- [ ] **Keep notes as it runs**: how testers were recruited, what they said,
      what changed because of it. The application asks exactly that ("Preview
      questions" on the Production page shows them now).

## Android: production (after the closed test)

- [ ] **Apply for production access** on the Dashboard, once 12 or more testers
      have been opted in for the last 14 days without a gap.
- [ ] **The design push** ([design-push.md](design-push.md)): a day with Claude
      on session sounds and setup, before the wider audience arrives.
- [ ] **End the beta bonus** (`b73h`): admin panel → Free credits → Beta bonus
      → 0, then the code comes out. ☁ already granted stay.
- [ ] **Promote to production** once it is granted, roll out. Another review, a
      few days. Public reviews open here. Open testing unlocks too, if a wider
      beta is still wanted then.
- [ ] Then the site's platform line again, the README (it has no mobile mention
      at all today) and the store links.

## Each store update (do it in one pass)

- [ ] `scripts/android-aab.sh` (it bumps `versionCode` and syncs `versionName`
      in `ts/android/app/build.gradle` itself; Play refuses a reused
      `versionCode`), then upload the `.aab` to the track.
- [ ] Release notes ("What's new") for the track.
- [ ] **Store copy**: `dev-docs/store-descriptions.md` is the source, the
      consoles are the deploy. Paste any changed paragraph into Play Console
      and into TestFlight's Test Information (What to Test is per build).
- [ ] **Data handling changed?** Then the Data Safety form (and Apple's App
      Privacy labels) change with the privacy policy, in the same pass. The
      answers on file are below.
- [ ] Screenshots, if the setup or session screen changed.
- [ ] **Promo video**, if it was rebuilt: a fresh YouTube upload is a new id.
      Play takes the full `watch?v=` URL, not a file, and rejects `youtu.be`
      links, playlist or timestamp params, age-restricted videos and videos
      with ads on. The site carries the same id (`#film` in `docs/index.html`).

## Privacy answers on file

Both consoles are the deploy; editing this file changes nothing live. Google's
form is **Data safety** (Play Console → App content); Apple's is **App
Privacy** (App Store Connect), needed to submit to the App Store, with its own
answers at the end of this section.

- **Messages → other in-app messages**: collected, **not ephemeral** (see
  below; the console says ephemeral until edited), optional, app
  functionality, not shared (LLM / STT / TTS / classifier vendors fall under the
  service-provider exemption). Voice commands sit in this row: `routes/judge.ts`
  relays the utterance to TypeSafe and keeps a classifier id, a latency and
  token counts, with failures cut down to a status code (`failureLabel`).
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

**To add** (found 2026-10-11 by reading what the server stores per account;
not in the console yet). All collected, not ephemeral, optional (no account,
no rows), not shared:

- **Personal info → User IDs**: the account id and the Google/Apple `sub`
  (`Identity` in `credits/store.ts`). App functionality, account management,
  fraud prevention (one free grant per identity). Removed on deletion. Apple:
  Identifiers → User ID.
- **App activity → App interactions**: the usage rows (`UsageEvent` in
  `credits/usage.ts`), one per metered call: session id, provider, model or
  voice, token and byte counts, never content. App functionality (billing),
  analytics, fraud prevention. Anonymized on deletion, not removed. Apple:
  Usage Data → Other Usage Data.
- **App info and performance → Diagnostics**: the error records (`Incident` in
  `credits/incidents.ts`), some reported by the app itself
  (`POST /cloud/v1/incidents`): a kind, provider, model, counts, an error's
  first line. App functionality, analytics. Anonymized on deletion. Apple:
  Diagnostics → Other Diagnostic Data.

Looked at and left out: the **signup IP** (no Play type fits an IP that is
only checked for abuse and never turned into a location; the policy discloses
it), names (the sign-in tokens carry one, the server reads only `sub` and
email) and passwords (stored as a hash; not a Data Safety type). The app ships
no analytics or ads SDK and sends no device or install id.

**Ephemeral: answer "no" on messages and audio** (recommended 2026-10-11).
Play's test is "only stored in memory and retained for no longer than
necessary to service the specific request in real-time". Our server passes
it. The vendors act on our behalf and are not ours to vouch for: Inworld keeps
text until zero-retention is on (bead `2igi`), and the others' retention terms
are theirs to change. An ephemeral row is also left off the store listing
altogether, so a voice app that sends speech to cloud vendors was showing no
audio or messages row at all. "No" stays true whatever a vendor does, costs
two visible rows marked not shared, and matches Apple's test.

**Apple's App Privacy labels**, from the same facts. Apple counts data as
collected when we *or a partner* can reach it past the request, so the relayed
content goes on the label. Tracking: none.

- **Contact Info → Email Address**: App Functionality, Developer's
  Advertising or Marketing (the update emails). Linked.
- **User Content → Audio Data** and **Other User Content**: App
  Functionality. **Not linked**: the server stores none of it, and nothing in
  `ts/server/src/providers/` hands a vendor an account id.
- **Identifiers → User ID**: App Functionality. Linked.
- **Purchases → Purchase History**: App Functionality. Linked.
- **Usage Data → Other Usage Data**: App Functionality, Analytics. Linked.
- **Diagnostics → Other Diagnostic Data**: App Functionality, Analytics.
  Linked.
- **Account deletion URL**: `https://aloud.rest/delete-account/`.
- **GenAI policy**: in-session ⓘ → "Report AI content", on both session views.

## iOS

The iOS build signs in with **Apple or email**: the Apple button always shows,
Google only once an iOS client id is built in (`isNativeGoogleConfigured`).
Free credits come with Apple, not with email (`decideConnectGrant`), and the
build sells nothing, so Apple is the only way a tester reaches Exploration or
Felt Sense. The App ID has the capability, the server takes the bundle id as
an audience (`APPLE_CLIENT_IDS` on Fly, confirmed 2026-10-11), and
`PrivacyInfo.xcprivacy` and the export-compliance flag are in.

- [ ] **A TestFlight build that can sign in.** 2.15.0 was signed without
      `com.apple.developer.applesignin`, so Apple fails on it with
      `AuthorizationError error 1000` on every device. The cause and the fixed
      recipe are in [mobile-signing.md](mobile-signing.md) → "CLI path" (two
      `codesign` lines between the archive and the export, and a check). The
      upload itself is the dev's to run.
- [ ] **The Mac: on for the dev, off for everyone else.** Two separate
      switches. *TestFlight*: each tester group has "Test iPhone and iPad apps
      on Apple silicon Macs" in its settings. Leave it on for the dev's own
      group (with no iPhone, it is the only place he can run the signed
      build) and off for the external group. *App Store*: Pricing and
      Availability → "iPhone and iPad Apps on Apple Silicon Macs" → "Make this
      app available" unticked before the first store release; it does not
      touch TestFlight. On a Mac the build is good for sign-in, credits and
      layout only: the web view has no `getUserMedia` there, so setup reads
      "aloud can't reach a microphone on this device" and no session starts,
      and it wears a system title bar that only a Catalyst app can hide. The
      desktop app is the Mac version.
- [ ] **TestFlight Test Information**, from `store-descriptions.md` →
      "TestFlight": the beta description, the feedback email, What to Test and
      the Beta App Review notes with the demo account. Testers see the first
      three. The review notes and the demo account go to Apple only, which is
      why What to Test sends testers through Sign in with Apple.
- [ ] **Run it on a real iPhone**: Developer Mode → automatic signing → Run, then
      section 3 of [manual-smoke.md](manual-smoke.md). Nothing on iOS has been
      proven on hardware, and the Mac is no stand-in (see the item above).
- [ ] **External testers**, for the people who asked on Twitter. Internal
      testers (up to 100, no review) have to be users on the App Store Connect
      team, so everyone else goes in an external group, by email or by a public
      link that can cap the count. The first build of a version sent to an
      external group goes through Beta App Review, about a day; later builds of
      that version usually skip it. They install through the TestFlight app,
      a build lasts 90 days, and TestFlight builds cannot be rated or reviewed
      on the App Store. There is no store-listed beta like Play's.
- [ ] **Google iOS sign-in** (bead `tpj4`), optional and skipped for testing
      builds: create the Google iOS OAuth client, put its **reversed client
      id** in `Info.plist` as the URL scheme (App Store Connect rejects a
      placeholder, ITMS-90158, so the file carries only a comment today), and
      add its audience to the server's `GOOGLE_CLIENT_IDS`. Steps in
      [mobile-signin-setup.md](mobile-signin-setup.md). Guideline 4.8 only
      asks that Apple be offered wherever Google is, which it already is.
- [ ] **App Privacy labels**, from "Privacy answers on file" → "Apple's App
      Privacy labels". Needed for the App Store submission, not for TestFlight.
- [ ] **Reviewer note**: Noting works free with no account. It **defaults** to a
      circle of one sound participant and a static opener, so a reviewer who
      taps straight through never meets the sign-in modal. Say so, say that an
      AI companion is what switches it to the paid cloud path, and give the demo
      account for the credit flow (heads off a Guideline 5.1.1 "why must I sign
      in" rejection). The Play App access text is the template.
- [ ] **iPad**: wanted, and the build already declares it
      (`TARGETED_DEVICE_FAMILY = "1,2"`), so an iPad installs it as an iPad
      app. In the simulator (iPad Air 11", portrait, 2026-10-11) it takes the
      desktop layout, top nav and three columns, with nothing out of place at
      rest. Not looked at: landscape, a resized window, audio. Ask for an iPad
      or two among the external testers; the 13" screenshots the listing needs
      can come from the simulator. A device family cannot be dropped after the
      first App Store release, so if no iPad has run a session by then, ship
      iPhone-only and add iPad in an update.
- [ ] Listing assets: screenshots in Apple's required sizes, description,
      keywords, support + privacy URLs, age rating. **App previews** are
      optional and are not the Play video: Apple takes an uploaded file of 15
      to 30 seconds at its own device sizes, made of footage of the app itself
      (Guideline 2.3.4), not a YouTube link. The 81.7s cut would need a recut.
      TestFlight has no video slot at all.
- [ ] Submit for App Store review (a few days).

## Buying ☁ in the store builds

Nothing is sold in the mobile app: `purchaseChannel()` (`purchase-channel.ts`)
is `'none'` there, and every buy entry point asks it. ☁ bought on the web land
in the same account. The words follow it too: the out-of-credits line a store
build shows and speaks (`outOfCreditsNotice`, the server's
`OUT_OF_CREDITS_PLAIN_MESSAGE`) and the cloud error (`describeCloudError`) carry
no "add more" or "purchase". The rules as read on 2026-10-10 (they move, reread them):

- **Play**: Payments policy section 4 bars in-app "buttons, links, messaging ...
  or other calls to action" toward another payment method, in every country.
  Each exception is a program to enroll in first, with an API integration and a
  service fee (external content links in the US, external offers in the EEA,
  billing choice in the UK). Bead `zp47` called the Stripe link-out sanctioned;
  it is not. A consumption-only app **may** say where to buy in plain text with
  no link, which is what `topUpHint` does on Android. Naming the domain is
  within that: Google's own example reads "any movie you rent through our
  website.com will be immediately available to view in the app". If a reviewer
  flags it anyway, the fallback is "on our website", one string.
- **App Store**: 3.1.1 requires in-app purchase for credits, and 3.1.3(b) lets
  web-bought credits be spent in the app only if they are also sold there.
  3.1.3(f) allows no call to action for an outside purchase at all, so iOS says
  nothing. The US storefront permits links, with the commission in litigation.

- [ ] **Store-billed packs** (Play Billing, StoreKit), priced up to cover the
      store's cut: the third value of `purchaseChannel()`. The same modal, a
      native billing plugin, and a server check that credits the ledger the way
      the Stripe webhook does. On Play a link-out would save only the 5% billing
      fee (the service fee applies either way), so it is not worth a program.
      Credits bought in-app may not expire (3.1.1). **iOS needs this before its
      review**; Android can run the beta without it.

## Optional, not blocking

- [ ] Trademark the stylized "aloud." mark (bead `lkh`): for clone takedowns
      later, not for approval.
