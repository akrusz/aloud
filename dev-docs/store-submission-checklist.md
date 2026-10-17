# App store submission checklist

What is left between aloud and testers, then live listings, on Google Play and
the App Store. The how-to lives in [mobile.md](mobile.md) (native projects),
[mobile-signing.md](mobile-signing.md) (sign + upload) and
[mobile-signin-setup.md](mobile-signin-setup.md) (OAuth consoles). Bead
`meditation-pal-7rh`. Finished steps are deleted, not ticked.

## Where we are (2026-10-14)

- **Android**: closed testing release 2.17.0 (versionCode 46) approved
  2026-10-14; testers join through the Google Group (posting locked to
  managers). Signing, the app-signing OAuth client, demo account +
  App access text, content rating, Data Safety, descriptions and promo video
  are all in.
- **Beta bonus is on** (`ALOUD_BETA_BONUS_CLIENT_IDS` set on Fly, `bb4k`), seen landing on both the Play and the TestFlight build.
- **Play production is gated**: a closed test with 12+ testers opted in for 14
  days running, then an application. Open testing stays locked until then,
  internal testers don't count. So the public beta is a closed test, recruited
  on Twitter.
- **iOS**: TestFlight 2.17.0, testers added, Sign in with Apple works (tried on
  the dev's Mac). Never run on an iPhone. No Google sign-in (skipped for
  testing builds). The App Store listing is filled in but not submitted
  (section 3 holds what blocks it).
- **Both**: the model is aloud cloud (sign-in + ☁). Noting defaults to a circle
  of one sound participant: no model, no account.
- **Known and accepted**: no barge-in on native STT (`x4h4`), no anonymous
  first session on iPhone web (`2dy1`, native apps unaffected).

## 1. Necessary for the next build to testers

Only what blocks a build reaching testers: console steps, required forms, and
one Exploration session that runs without a major issue. All other testing is
in section 2.

**Android**

- [X] **Smoke the Play-installed build**: uninstall the dev build (same
      `applicationId`, different key), install 2.17.0 from Play, sign in with
      Google (the beta bonus should land; if not, the server logs `beta bonus
      check`, and `eligible: false` means the listed client id isn't the one
      the build presents), run one Exploration session end to end.
- [X] **Tester list**: add `aloud-testers@googlegroups.com`
      (https://groups.google.com/g/aloud-testers, made 2026-10-14) under Closed
      testing → Testers, with the feedback email. Group settings: anyone can
      join without approval, and only managers see the member list (testers'
      emails stay private from each other).
- [X] **Closed testing release**: Create new release → Add from library → the
      tested bundle. Pick countries, send for review (the first one is
      reviewed).
- [ ] **Recruit, well past 12** (people drop out, and the 12 must hold for the
      whole 14 days). Order: join the group
      (https://groups.google.com/g/aloud-testers) → opt in at
      `https://play.google.com/apps/testing/app.aloud.meditation` → install
      from Play with the same Google account. Group membership alone doesn't
      count: Google counts testers opted in for 14 days running (one who opts
      out and back in starts over). The production application then asks how
      testers used the app and what feedback came in, so ask them to run
      sessions, and keep the feedback.

**iOS**

- [X] **TestFlight Test Information** from `store-descriptions.md` →
      "TestFlight": beta description, feedback email, What to Test, Beta App
      Review notes + demo account (those two go to Apple only).
- [ ] **External group**: by email or a public link with a cap. Testers need
      only an Apple ID and the TestFlight app, no paid membership (internal
      testers are App Store Connect users on the team, free but with console
      access). The first build of a version
      goes through Beta App Review, about a day. No iPhone smoke is possible
      here (the Mac can't run a session), so the first testers are it.

## 2. Nice to have this round

- [ ] [Android] **Bluetooth (`4xkx`)**, on a build with the fix (2.16.0+):
      headphones on, aloud cloud speech recognition, lock ~30s, unlock: the
      reply is still in the headphones. Then headphones off and on
      mid-session: the voice moves to the speaker and back.
- [ ] [Android] **Review-facing checks**: signed-out noting on the default
      circle runs with no sign-in modal (the App access text claims it); no buy
      button anywhere (Account shows "at aloud.rest/account" as plain text,
      "What are ☁?" offers only "Got it" once signed in).
- [ ] [Android] **Device checks**: a lock/unlock mid-session picks up again at
      full loudness (`wxj5`); 30 minutes; unplugged, three minutes untouched →
      screen goes black with "Screen dimmed, tap to brighten" still faintly
      readable, a tap brings it back (`screen-dim.ts`); speak a few
      seconds after the facilitator stops → the transcript starts where the
      sentence does (`0l0w`, `wlp9`); one Inworld reply with its first phoneme
      intact (`2igi`); one spoken command; the opening and closing sounds play
      whole and the opening isn't taken as a turn (`signature-sound.ts`).
- [ ] [Android] **Check-ins after quiet (`v85a`)**: with Settings → Developer
      → "Check-in debug HUD", go quiet at Balanced and read what each ask
      decided (new waits 12m / 5m / 3m, truthful second ask).
- [ ] [iOS] **A real iPhone run** (section 3 of
      [manual-smoke.md](manual-smoke.md)). The dev has no iPhone, so until
      someone lends one the first external testers are the first hardware.
- [ ] [iOS] **An iPad or two among the testers.** The build declares iPad
      (`TARGETED_DEVICE_FAMILY = "1,2"`); the simulator showed the desktop
      layout fine at rest. Landscape, resizing and audio are unchecked.
- [ ] [Both] **Listing refresh**: the captioned screenshots from
      `node scripts/store-screenshots.mjs` (`<device>/cap-*.png`); feature
      graphic and 512 icon in `assets/store/`. The captions (`SHOTS` there)
      want a copy pass, not before launch.
- [ ] [Android] **Keep notes as it runs**: how testers were recruited, what
      they said, what changed. The production application asks exactly that
      (Production page → "Preview questions").
- [ ] [Android] **Site platform line** (`docs/index.html`, "iOS and Android are
      in closed beta") can link `aloud.rest/mobile-beta/` (made 2026-10-14, unlinked
      so far), which has the group, opt-in and TestFlight links.

## 3. Do later (production and App Store launch)

**Android**

- [ ] Apply for production on the Dashboard once 12+ testers have been opted
      in for the last 14 days without a gap.
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

- [ ] **Store-billed packs** (StoreKit; Play Billing too, but Android's beta
      doesn't need it). **Required before iOS review**, see "Buying ☁".
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
| Audio → voice recordings | **No** | App functionality | Three paths, as `docs/privacy/index.html` → "Your voice": on-device Whisper (desktop), the platform recognizer mobile offers (Android's may route to Google: disclosed in the policy, never claimed as on-device), aloud cloud (relayed, not retained). Nothing may imply mobile speech never leaves the device. |
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
