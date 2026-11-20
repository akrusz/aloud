# Age tier (the app store's age signal)

From 2027-01-01 California's AB 1043, and laws like it elsewhere, have app
stores hand apps an age range, and apps must ask for it. aloud asks the store
only, in the phone apps only, and keeps one tier. It never asks anyone's age
itself.

## Policy

| Store says | Tier | App does |
|---|---|---|
| 18+ | `adult` | full app |
| nothing: not shared, declined, not required, an error, a timeout, a missing API, an old OS, Play wants verification | unknown: the stored tier, else `adult` | as that tier |
| 13 to 17 | `teen` | full app; nothing reads `teen` yet |
| a minor whose parent's approval of a "significant change" is pending / declined | `pendingConsent` / `deniedConsent` | blocking screen |
| under 13 | `child` | blocking screen: no session, no mic |

Bounds are inclusive and either may be missing (`tierFromReading`). `child`
is an upper bound of 12 or less; `adult` is a lower bound of 18 or more.
Anything else with a bound, a range straddling 13 included, is `teen`. Only a
teen's consent is read: `child` stays `child`, `adult` ignores it.

Only a shared range moves the tier. A decline is unknown, not `adult`:
otherwise a child allowed to choose could tap "Don't share" and lift the block
a shared range put there. So a block lasts until the store shares a range that
says otherwise.

## Where it lives

- `ts/ui/src/age-tier.ts`: `tierFromReading` (a reading to a tier, or null
  for unknown), `readAgeSignals` (the plugin call), `createAgeGate` (the boot
  decision, its dependencies passed in so `tests/age-tier.test.ts` can drive
  it), `bootAgeTier` (boot's one call), `getAgeTier` (sync, the tier on
  screen), `adoptAgeParam` (the dev param), `ASK_WHERE_OPTIONAL`,
  `FIRST_CHECK_WAIT_MS`.
- `ts/ui/src/app.ts` `bootApp`: calls `bootAgeTier` once the language is set,
  before anything else. A blocking tier mounts `mountAgeBlockView`
  (`ts/ui/src/views/age-block.ts`, styled by `.age-block` in `style.css`)
  instead of the router, retires the boot orb (`retireBootOrb`) and returns:
  no nav, no routes, no resume offer (`seedInterruptedResume`), no mic code.
- Android: `AgeSignalsPlugin.java`, registered in `MainActivity.onCreate`, on
  `com.google.android.play:age-signals:0.0.6` (`ts/android/app/build.gradle`).
- iOS: `AgeSignalsPlugin.swift`, registered in
  `MainViewController.capacitorDidLoad`.

## Boot

- Web and desktop never call anything and are `adult`. Only a
  `capacitorPlatform()` of `ios` or `android` checks.
- A stored tier is used at once, with the check running behind it. With none
  (first launch), boot waits for the check up to `FIRST_CHECK_WAIT_MS` (2500
  ms), then goes on with what is known.
- Every shared range is stored. When the store says nothing and nothing is
  stored yet, `adult` is stored, so the many accounts that never share
  anything wait on the store once and not on every launch. A stored `adult`
  therefore means "nothing says otherwise", not a verified age.
- An answer that flips blocked to not blocked, or back,
  against what is on screen reloads the page, and the reloaded boot starts
  from the stored tier, which is what keeps it from looping. A failed store
  write means no reload. A flip to blocked mid-session cuts the session short;
  accepted.
- Between two blocking tiers the screen is swapped in place.
- While blocked, each return to the foreground (`visibilitychange`) checks
  again, one check at a time: on iOS a check can hold a system sheet open.
- `verificationRequired` (Android) is unknown, plus one toast per install
  (KV flag `storeVerifyNoticeShown`, holding `1`).

## What is kept, and where it never goes

- Only the tier is stored: KV key `ageTier` (Capacitor Preferences on the
  phones). Never the range or its bounds.
- Nothing age-related is logged, sent or put in diagnostics. "Report a bug"
  reads `diag` and the error log, so the only line is
  `[age-check] unavailable <error>` (a dev-mode `diag`, not kept for the
  report). The toast is the calm one, `showSuccessToast`, because an error
  toast's text goes to the error log. aloud cloud never hears any of it.
- Fail open: nothing shared, an error, a timeout, a missing API or an old OS
  is unknown, which is the stored tier, else `adult`. So a known under-13
  account stays blocked offline.

## Native contract

Plugin `AgeSignals`, one method, `check({ askWhereOptional })`, which always
resolves, never rejects:

```ts
{ status: 'shared' | 'notShared' | 'verificationRequired' | 'notRequired' | 'unavailable',
  ageLower?: number | null, ageUpper?: number | null,
  consent?: 'approved' | 'pending' | 'declined' | null, detail?: string }
```

`detail` is a short error description, on `unavailable` only. Neither side
reads Play's `installId` or range source.

- **Android**: `getApplicableAgeFeatures`; with `MANDATORY_SHARING` (or
  `askWhereOptional`), `requestAgeSignalsAccess`: `SHARED` then
  `checkAgeSignals` gives `shared` with the bounds and consent, `NOT_SHARED`
  gives `notShared`, `VERIFICATION_REQUIRED` gives `verificationRequired`.
  Otherwise `checkAgeSignals` alone, which never prompts: a bound gives
  `shared`, none gives `notRequired`. A failure is `unavailable` with the code,
  e.g. `APP_NOT_OWNED (-9)`.
- **iOS**: below 26.2, `unavailable`. `isEligibleForAgeFeatures` false and not
  asking gives `notRequired`. Else `requestAgeRange(ageGates: 13, 16, 18, in:)`
  on the main actor: `.declinedSharing` gives `notShared`, `.sharing` gives
  `shared` with the bounds. iOS reports no consent. A thrown error is
  `unavailable` with its case name.

## `ASK_WHERE_OPTIONAL`

One constant in `age-tier.ts`, passed to the native check, and off. Off, where
no law makes the store share, the check takes only paths that never prompt
(Android reads `checkAgeSignals` alone, iOS stops at
`isEligibleForAgeFeatures`), so nobody is asked for something no law requires.
On, Android asks Play for access everywhere (Play's in-app prompt where
sharing is optional) and iOS shows Apple's sheet everywhere.

## Store APIs (as of 2026-11-20)

Google's library changed shape three times in a year (0.0.4 dropped
`userStatus`, for one), so recheck these against the version in
`build.gradle` before trusting them.

**Android**, `com.google.android.play:age-signals:0.0.6`, package
`com.google.android.play.agesignals` (read off the jar with `javap`):

- `AgeSignalsManagerFactory.create(context)` gives an `AgeSignalsManager`
  with three methods, each a Play `Task`: `getApplicableAgeFeatures`,
  `requestAgeSignalsAccess` (needs an Activity; the library's own transparent
  `AgeSharingConsentWrapperActivity` shows the prompt) and `checkAgeSignals`.
- The constants are in the `model` subpackage: `ApplicableAgeFeature`
  (`MANDATORY_SHARING` 1), `AgeSignalsStatus` (`UNSPECIFIED` 0, `SHARED` 1,
  `NOT_SHARED` 2, `VERIFICATION_REQUIRED` 3), `SignificantChangeStatus`
  (`UNSPECIFIED` 0, `APPROVED` 1, `PENDING` 2, `DECLINED` 3), `AgeRangeSource`
  (`TIER_A` to `TIER_D`) and `AgeSignalsErrorCode`: `API_NOT_AVAILABLE` -1,
  `PLAY_STORE_NOT_FOUND` -2, `NETWORK_ERROR` -3, `PLAY_SERVICES_NOT_FOUND` -4,
  `CANNOT_BIND_TO_SERVICE` -5, `PLAY_STORE_VERSION_OUTDATED` -6,
  `PLAY_SERVICES_VERSION_OUTDATED` -7, `CLIENT_TRANSIENT_ERROR` -8,
  `APP_NOT_OWNED` -9, `SDK_VERSION_OUTDATED` -10, `DEVICE_NOT_SUPPORTED` -11,
  `INTERNAL_ERROR` -100. `AgeSignalsVerificationStatus`, the old `userStatus`
  values, is still in the jar and unused.
- `AgeSignalsResult` getters, all nullable and all null for someone who has
  not shared: `ageLower()`, `ageUpper()` (inclusive; Play's ranges are 0-12,
  13-15, 16-17, 18+), `ageRangeSource()`, `significantChangeStatus()`,
  `significantChangeApprovalDate()`, `installId()`.
- Failures are `AgeSignalsException` (an `ApiException`), `getErrorCode()`.
  minSdk 24, the app's own.

**iOS**, framework `DeclaredAgeRange` (read off the Xcode 27.2 SDK's
`.swiftinterface`):

- `AgeRangeService.shared.requestAgeRange(ageGates:_:_:in:)`, iOS 26.0+: up
  to three gates, each range at least two years wide, may present a system
  sheet. Answers `.declinedSharing` or `.sharing(range:)`; `AgeRange` has
  `lowerBound` (nil below the lowest gate), `upperBound` (nil at or above the
  highest), `ageRangeDeclaration`, `activeParentalControls`.
- `isEligibleForAgeFeatures` (`get async throws`), iOS 26.2+: whether the
  person is somewhere that requires age assurance.
- iOS 26.4+: `requiredRegulatoryFeatures` (`.declaredAgeRangeRequired`,
  `.significantAppChangeRequiresParentalConsent`,
  `.significantAppChangeRequiresAdultNotification`) and
  `showSignificantUpdateAcknowledgment(in:updateDescription:)`;
  `ParentalControls.significantAppChangeApprovalRequired` is deprecated in
  their favour.
- `AgeRangeService.Error`: `notAvailable`, `invalidRequest`, and from iOS 27.0
  only `invalidAccount`, `declinedOnboarding`, `network`.
- Needs the entitlement `com.apple.developer.declared-age-range`, which is not
  in `App.entitlements` yet: the App ID lacks the capability. Until then every
  call throws and the plugin answers `unavailable`, the intended dormant state.
- The framework is weak-linked on its own (deployment target iOS 15): a
  simulator build's binary loads it with `LC_LOAD_WEAK_DYLIB`
  (`otool -l`).

## Not built

- Anything `teen` changes.
- Significant-change flows on either store: declaring a change to Play or
  Apple, Apple's `showSignificantUpdateAcknowledgment` and
  `requiredRegulatoryFeatures`.
- Play's notices of a revoked approval (keyed on `installId`) and Apple's
  `RESCIND_CONSENT` App Store Server Notification.
- Anything server-side.

## Testing

- `tests/age-tier.test.ts`: the mapping, the stored-tier and fail-open
  fallback, the boot decision (blocked or not, the first-launch wait, a flip
  reloading, the foreground re-check).
- The screens: a dev build with `?age=child` (or `pendingConsent`,
  `deniedConsent`, `teen`), also linked from Settings → Developer. This load
  only: it never writes the stored tier and comes off the URL, so a reload is
  the real app.
- Android: Play answers only an install Play made or updated, so a sideloaded
  debug build gets `APP_NOT_OWNED`. Test on a Play-installed build, or as a
  license tester on a build whose package matches. `FakeAgeSignalsManager`
  (`com.google.android.play.agesignals.testing`) is there for JVM unit tests.
- iOS: a sandbox for age scenarios from 26.2, but nothing answers until the
  Declared Age Range capability is on the App ID and the entitlement is in the
  build.
- Never run on a phone yet.
