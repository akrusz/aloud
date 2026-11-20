# App store submission checklist

What is left between aloud and testers, then live listings, on Google Play and
the App Store. The how-to lives in [mobile.md](mobile.md) (native projects),
[mobile-signing.md](mobile-signing.md) (sign + upload) and
[mobile-signin-setup.md](mobile-signin-setup.md) (OAuth consoles). Bead
`meditation-pal-7rh`. Finished steps are deleted, not ticked.

## Where we are (2026-11-20)

- **Android**: Play has granted production access, so open testing is
  unlocked. The closed test ran from 2.17.0 (approved 2026-10-14) through the
  Google Group. Signing, the app-signing OAuth client, demo account + App
  access text, Data Safety, descriptions and promo video are all in. `main`
  is at 2.20.1 / versionCode 55 in `ts/android/app/build.gradle`;
  `scripts/android-aab.sh` bumps it.
- **Beta bonus is on** (`ALOUD_BETA_BONUS_CLIENT_IDS` set on Fly, `bb4k`) and
  stays on through the open beta.
- **iOS**: TestFlight 2.17.0, Sign in with Apple works. Never run on an
  iPhone. No Google sign-in. The App Store listing is filled in but not
  submitted (section 2 holds what blocks it).
- **Both**: the model is aloud cloud (sign-in + ☁). Noting defaults to a circle
  of one sound participant: no model, no account. The phone builds sell
  nothing.
- **Known and accepted**: no barge-in on native STT (`x4h4`) or on an
  iPhone's speaker (`hi6f`, headphones only), no anonymous
  first session on iPhone web (`2dy1`, native apps unaffected).

## 1. Before the Android open beta

In order. A step marked (Claude) is one to ask for; the rest are Alex's.
Delete this section once the open test is live.

**A. Now, no build needed**

- [ ] **Push `main`, then run "Deploy server (Fly)"** on GitHub (it deploys
      GitHub's `main`, so the push comes first). Carries Harper's lead check.
- [ ] **Play Console, content and listing** (`meditation-pal-p6ml.1`):
      the content rating questionnaire answered so it lands at Teen; "Restrict
      Minor Access" left off; Brazil unticked in the countries; the full
      description pasted again from
      [store-descriptions.md](store-descriptions.md) (modes in the order
      Exploration, Felt Sense, Noting, and the new last paragraph saying the
      facilitator is an AI).

**B. Desktop, before the phone**

- [ ] **The tour read aloud, once more**, in `npm run tauri:dev` on MacBook
      speakers with aloud cloud speech recognition. "Next" and "back" over
      several lines at an ordinary level, one of them quiet; "back" a few
      seconds into the focus line; a cough over a line does nothing; the
      first line plays without a break. Then tell Claude, which reads
      `.probe-data/dev-diag/`.
- [ ] (Claude) The agreed simplifications with no change in behaviour, after
      that tour so a regression has one cause. One more quick tour after them.

**C. The phone pass**

- [ ] **Plug the phone in and say so.** (Claude) installs a build from `main`
      and starts the clip receiver and the timing log.
- [ ] **"This release" in [manual-smoke.md](manual-smoke.md)**: what is left
      to hear and see, the store age check's first run among it
      (`meditation-pal-p6ml.9`).
- [ ] **Look once at what has not been seen**: the About panel's AI note and
      the welcome card's line; the mic's grey breathing look; the noting
      tab's "Introduction voice" and two-line sound label.
- [ ] **Decide from what was heard**: native playback for the sounds if the
      close still wavers (`meditation-pal-grfo`); a short hold before the
      tour's first line on Android if it is cut; stopping a tour line on any
      clear speech if commands over it are still unreliable.

**D. The release**

- [ ] (Claude) **The pre-release check**
      ([pre-release-checklist.md](pre-release-checklist.md)). The last one
      covered up to 2026-11-18.
- [ ] **`scripts/release.sh`**, answering Android at the stores prompt:
      publishes the release (server, then web) and builds the `.aab`.
- [ ] **Screenshots**, since the setup screen changed:
      `node scripts/site-screenshots.mjs` for the site and
      `node scripts/store-screenshots.mjs` for the listing
      (`<device>/cap-*.png`).
- [ ] **Upload the `.aab` to Internal testing** (no review), uninstall the
      dev build from the phone (same `applicationId`, different key) and
      install from Play.
- [ ] **Smoke the Play-installed build**: sign in with Google and see the
      beta bonus land (if not, the server logs `beta bonus check`); one
      Exploration session end to end; signed-out noting on the default circle
      with no sign-in modal (the App access text claims it); no buy button
      anywhere (Account shows "at aloud.rest/account" as plain text); the app
      opens with no age screen.

**E. Open testing, in Play Console**

- [ ] **Testing → Open testing → Create release**, promoting the bundle just
      smoked. Release notes, countries without Brazil, the feedback email,
      and a tester cap if wanted. Upload the new screenshots. Send for
      review.
- [ ] **EU trader status**, if the console asks for it here: **trader**, same
      contact details as Apple's (section 2). Where Play keeps it has not
      been looked up.
- [ ] The closed track can stay as it is: a tester on both gets whichever
      track holds the highest versionCode.

**F. When Play approves**

- [ ] **Publish the site copy**: `git cherry-pick pending/open-beta-site`
      (the hero line and the mobile beta page's Android section, Alex's
      wording), then push. A push to `docs/` is live at once, which is why it
      waits on a branch.
- [ ] Tell the closed testers and post it.
- [ ] (Claude) Delete "This release" from manual-smoke.md, this section, and
      the open-beta reminders in `CLAUDE.md`; close `meditation-pal-k8gf`.

**Nice to have on the Play build**, none of it blocking:

- [ ] **Bluetooth (`4xkx`)**: headphones on, aloud cloud speech recognition,
      lock ~30s, unlock: the reply is still in the headphones. Then
      headphones off and on mid-session: the voice moves to the speaker and
      back.
- [ ] **Device checks**: a lock/unlock mid-session picks up again at full
      loudness (`wxj5`); 30 minutes; unplugged, three minutes untouched →
      screen goes black with "Screen dimmed, tap to brighten" still faintly
      readable, a tap brings it back (`screen-dim.ts`); speak a few seconds
      after the facilitator stops → the transcript starts where the sentence
      does (`0l0w`, `wlp9`).
- [ ] **Check-ins after quiet (`v85a`)**: with Settings → Developer →
      "Check-in debug HUD", go quiet at Balanced and read what each ask
      decided.

## 2. Do later (production and App Store launch)

**Android**

- [ ] The design push ([design-push.md](design-push.md)), before the wider
      audience.
- [ ] End the beta bonus (`b73h`): admin panel → Free credits → Beta bonus → 0,
      then remove the code. Granted ☁ stay.
- [ ] EU trader status: **trader**, same contact details as Apple's (below).
      Not yet looked up where Play Console keeps it.
- [ ] Promote to production, roll out (another review, a few days; public
      reviews open here).
- [ ] Then the site's platform line, the README (no mobile mention yet) and the
      store links.

**iOS**

- [ ] **External TestFlight group**: by email or a public link with a cap.
      Testers need only an Apple ID and the TestFlight app. The first build
      of a version goes through Beta App Review, about a day.
- [ ] **A real iPhone run** (section 3 of
      [manual-smoke.md](manual-smoke.md)). The dev has no iPhone, so until
      someone lends one the first external testers are the first hardware.
- [ ] **An iPad or two among the testers.** The build declares iPad
      (`TARGETED_DEVICE_FAMILY = "1,2"`); the simulator showed the desktop
      layout fine at rest. Landscape, resizing and audio are unchecked.
- [ ] **Store-billed packs** (StoreKit; Play Billing too, but Android's beta
      doesn't need it). **Required before iOS review**, see "Buying ☁".
- [ ] **No Brazil**, both stores (decided 2026-11-20, `meditation-pal-p6ml.3`):
      Play Console → the release's countries, and App Store Connect → Pricing
      and Availability. Brazil's ECA Digital presumes a conversational AI is
      covered and asks for a local legal representative, among other things.
      Revisit if aloud gains Portuguese.
- [ ] **Declared Age Range**, before 2027-01-01: enable the capability in
      Xcode (App target → Signing & Capabilities), which writes
      `com.apple.developer.declared-age-range` into `App.entitlements` and
      registers it on the App ID. Until then the iOS age check answers
      "unavailable" and every account counts as adult
      ([age-tier.md](age-tier.md)). `scripts/ios-archive.sh` then refuses an
      archive without it.
- [ ] Reviewer note: noting works free with no account and by default never
      shows the sign-in modal; an AI companion switches it to the paid cloud
      path; give the demo account (heads off a 5.1.1 "why must I sign in").
      The Play App access text is the template.
- [ ] iPad decision: a device family can't be dropped after the first release,
      so if no iPad has run a session by then, ship iPhone-only and add iPad
      later.
- [ ] Listing: entered 2026-10-14 (captioned screenshots, promotional text,
      support URL, App Privacy, category, copyright, content rights, free),
      so only a recheck if the screens or copy change. The support URL is
      `docs/support/`, live once `docs/` is pushed. App previews are optional,
      15-30s of footage of the app at Apple's device sizes (2.3.4), not the
      Play YouTube video.
- [ ] EU trader status (DSA): **trader** (decided 2026-10-13). Account level
      (Account Holder or Admin), then per app: App Information → App Store
      Regulations and Permits → Digital Services Act. The EU page shows a
      verified address, phone and email; a P.O. box or mailbox service works
      with a bill or receipt tying you to it plus a current ID document, which
      keeps the home address and personal phone off the page. TestFlight
      doesn't need it; launching with EU storefronts off would defer it. Not
      "not a trader": that tells EU users their consumer rights don't apply.
- [ ] Mac App Store: Pricing and Availability → "iPhone and iPad Apps on Apple
      Silicon Macs" → untick "Make this app available" (separate from the
      TestFlight switch). Same page, Apple Vision Pro: on by default for an
      iPad app; untick unless someone has run a session on one.
- [ ] Google iOS sign-in (`tpj4`), optional: Google iOS OAuth client, its
      reversed client id as a URL scheme in `Info.plist` (a placeholder fails
      upload, ITMS-90158), audience into `GOOGLE_CLIENT_IDS`. Steps in
      [mobile-signin-setup.md](mobile-signin-setup.md). Apple is already
      offered, so 4.8 is met either way.
- [ ] Submit for App Store review (a few days). First rename the version
      record from "1.0" to the build's version (2.17.0 or later).

**Optional**: trademark the stylized "aloud." mark (`lkh`), for takedowns
later, not for approval.

## Each store update (one pass)

- [ ] Builds: `scripts/release.sh` asks which stores at the end (an iOS-only
      fix is `scripts/release.sh ios`), or run
      `scripts/android-aab.sh` (bumps `versionCode`, syncs `versionName`) and
      `scripts/ios-archive.sh` (refuses an archive without the Apple sign-in
      entitlement).
- [ ] Uploads: the `.aab` to the Play track by hand; TestFlight gets the
      archive from `release.sh` (or `scripts/ios-archive.sh --upload`), then
      add the build to the external group once it's processed.
- [ ] Release notes ("What's new"), and What to Test per TestFlight build.
- [ ] Store copy changed? `store-descriptions.md` is the source; paste into
      both consoles.
- [ ] Data handling changed? Data Safety + App Privacy change with the privacy
      policy, same pass.
- [ ] Setup or session screen changed? `node scripts/store-screenshots.mjs`.
- [ ] Promo video rebuilt? A new YouTube id. Play takes the full `watch?v=`
      URL (no `youtu.be`, playlist or timestamp params, age restriction or
      ads). The site carries the same id (`#film` in `docs/index.html`).

## Reference

### TestFlight and iOS facts

- Sign-in is **Apple or email**; Google shows only once an iOS client id is
  built in (`isNativeGoogleConfigured`). Free ☁ come with Apple, not email
  (`decideConnectGrant`), and nothing is sold, so Apple is how a tester reaches
  Exploration or Felt Sense. `APPLE_CLIENT_IDS` on Fly takes the bundle id;
  `PrivacyInfo.xcprivacy` and the export-compliance flag are in.
- 2.15.0 lacked `com.apple.developer.applesignin` (error 1000 on every
  device); `scripts/ios-archive.sh` now runs the fixed recipe
  ([mobile-signing.md](mobile-signing.md) → "CLI path").
- On a Mac the build is good for sign-in, credits and layout only: no
  `getUserMedia`, so setup reads "aloud can't reach a microphone on this
  device". It shares the bundle id `app.aloud.meditation` with the desktop
  app, so TestFlight won't install until `/Applications/aloud.app` is gone
  (desktop history stays in `~/Library/Application Support/app.aloud.meditation/sessions`).
- External builds last 90 days, install through the TestFlight app, and can't
  be rated or reviewed. Closed-test Play testers can't leave public reviews
  either; their feedback arrives privately.

### Privacy answers on file

Nothing here is live until entered in a console: Play → App content → **Data
safety**; App Store Connect → **App Privacy**.

**Play Data safety.** Every row: collected, optional (no account, no rows),
not shared (LLM / STT / TTS / classifier vendors are service providers).

| Row | Ephemeral | Purposes | Notes |
|---|---|---|---|
| Messages → other in-app messages | **No** | App functionality | Includes voice commands: `routes/judge.ts` relays the utterance to TypeSafe and keeps a classifier id, latency and token counts; failures cut to a status code (`failureLabel`). |
| Audio → voice recordings | **No** | App functionality | Three paths, as `docs/privacy/index.html` → "Where your data goes": on-device Whisper (desktop), the platform recognizer mobile offers (Android's may route to Google: disclosed in the policy, never claimed as on-device), aloud cloud (relayed, not retained). Nothing may imply mobile speech never leaves the device. |
| Email address | No | Account management, **Developer communications** (update emails, `Account.emailUpdates`); "Advertising or marketing" unticked (Play means ads) | Deletable. |
| Purchase history | No | App functionality | Deletable. |
| Personal info → User IDs | No | App functionality, account management, fraud prevention (one free grant per identity) | Account id + Google/Apple `sub` (`Identity`, `credits/store.ts`). Removed on deletion. |
| App activity → App interactions | No | App functionality (billing), analytics, fraud prevention | Usage rows (`UsageEvent`, `credits/usage.ts`): session id, provider, model/voice, token and byte counts, never content. Anonymized on deletion. |
| App info and performance → Diagnostics | No | App functionality, analytics | Error records (`Incident`, `credits/incidents.ts`, some from `POST /cloud/v1/incidents`): kind, provider, model, counts, an error's first line. Anonymized on deletion. |

Why not ephemeral: Play's test is "only stored in memory ... no longer than
necessary to service the specific request in real-time". Our server passes,
but vendors' retention isn't ours to vouch for (Inworld keeps text until
zero-retention is on, `2igi`), and an ephemeral row disappears from the
listing, hiding that speech goes to cloud vendors. "No" stays true and matches
Apple's test.

Left out on purpose: the signup IP (abuse check only, never a location; the
policy discloses it), names (only `sub` and email are read), passwords (a
hash; not a Data Safety type). No analytics or ads SDK, no device or install
id.

**Apple App Privacy.** Apple counts what we *or a partner* can reach past the
request, so relayed content is on the label. Tracking: none.

| Type | Purposes | Linked |
|---|---|---|
| Contact Info → Email Address | App Functionality, Developer's Advertising or Marketing (the update emails) | Yes |
| User Content → Audio Data, Other User Content | App Functionality | **No** (server stores none; nothing in `ts/server/src/providers/` sends an account id) |
| Identifiers → User ID | App Functionality | Yes |
| Purchases → Purchase History | App Functionality | Yes |
| Usage Data → Other Usage Data | App Functionality, Analytics | Yes |
| Diagnostics → Other Diagnostic Data | App Functionality, Analytics | Yes |

Account deletion URL: `https://aloud.rest/delete-account/`. GenAI reporting:
in-session ⓘ → "Report AI content", on both session views.

### Buying ☁ in the store builds

Nothing is sold in the mobile app: `purchaseChannel()` (`purchase-channel.ts`)
is `'none'` there, and every buy entry point asks it. Web-bought ☁ land in the
same account. The out-of-credits line (`outOfCreditsNotice`, the server's
`OUT_OF_CREDITS_PLAIN_MESSAGE`) and the cloud error (`describeCloudError`) say
no "add more" or "purchase". Rules as read 2026-10-10 (they move, reread):

- **Play**: Payments policy section 4 bars in-app calls to action toward
  another payment method in every country; each exception is a paid program
  (US external links, EEA external offers, UK billing choice). `zp47` called
  the Stripe link-out sanctioned; it is not. Plain text with no link is
  allowed for a consumption-only app, which is `topUpHint` on Android; naming
  the domain is within that (Google's example: "rent through our website.com").
  If a reviewer objects, fall back to "on our website".
- **App Store**: 3.1.1 requires in-app purchase for credits; 3.1.3(b) allows
  spending web-bought credits only if they're also sold in-app; 3.1.3(f)
  allows no outside-purchase call to action, so iOS says nothing. The US
  storefront permits links, commission in litigation.
- **Store-billed packs** (the third `purchaseChannel()` value): same modal, a
  native billing plugin, a server check that credits the ledger like the
  Stripe webhook, priced to cover the store's cut. In-app credits may not
  expire (3.1.1). On Play a link-out saves only the 5% billing fee, so not
  worth a program.
