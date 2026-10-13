# License Exception — App Store Distribution

This software is licensed under the GNU Affero General Public License,
version 3 (AGPL-3.0). The full text of the AGPL is in the [LICENSE](LICENSE)
file at the root of this repository.

The following additional permission is granted by the copyright holder
under section 7 of the AGPL-3.0, and applies in addition to the terms of
the AGPL.

## Apple App Store distribution exception

As the copyright holder, Alex Krusz grants Apple Inc., its subsidiaries,
and parties acting under its terms (including individual end users
receiving the software through Apple's distribution channels) a
non-exclusive, irrevocable permission to:

1. Distribute, store, copy, and transmit verbatim or modified copies of
   this software through the Apple App Store and any related Apple
   distribution channels (TestFlight, Enterprise Distribution, etc.), and
2. Combine and link this software with proprietary Apple frameworks,
   libraries, and toolchains as required to build, sign, notarize, and
   ship an iOS, iPadOS, macOS, watchOS, tvOS, or visionOS application,

notwithstanding the device-count limits, FairPlay digital rights
management, anti-redistribution, and other terms in the Apple Media
Services Terms and Conditions (the "App Store Usage Rules") that would
otherwise impose "further restrictions" prohibited by AGPL §6.

This exception only covers the additional terms imposed by Apple's
distribution channel. It is **not** a relicense:

- The source code remains licensed under the AGPL-3.0 to everyone,
  including Apple-channel recipients.
- AGPL §13's network-use source-availability requirement continues to
  apply: any user interacting with this software over a network must
  still be able to obtain the corresponding source.
- This exception does **not** grant Apple or anyone else permission to
  relicense the software, sublicense it under proprietary terms, or
  distribute it under non-AGPL terms outside of the Apple distribution
  channels covered above.

## Why this exception exists

Apple's App Store Usage Rules impose conditions (device limits, FairPlay
DRM, no further redistribution) that the AGPL §6 phrase "no further
restrictions" forbids. Without an explicit exception from the copyright
holder, AGPL-licensed software cannot legally be distributed through the
App Store — VLC was famously pulled from iOS in 2011 over exactly this
conflict.

This exception preserves the spirit of the AGPL (source remains free)
while making it legally possible to ship the app to iOS users.

## Google Play Store

Google Play does not impose AGPL-incompatible restrictions equivalent to
Apple's, so no comparable exception is needed for Android distribution.

## Contributors

By submitting a contribution to this repository (via pull request, patch,
or other means), contributors agree that their contribution may be
distributed under the AGPL-3.0 together with the Apple App Store
exception described above. This ensures the exception remains effective
as the project accepts external contributions.

If you do not wish to grant this additional permission for your
contribution, please indicate so clearly in your submission, and the
maintainer will decide whether to accept the contribution under those
terms.

## Trademarks

The AGPL-3.0 licenses the software. It does not license aloud's identity.
As section 7(e) of the AGPL-3.0 allows, the copyright holder declines to
grant any rights under trademark law: the name "aloud", its wordmark, the
orb, the app icons and aloud's signature sounds may not be used to name,
brand or promote a modified version or another product. The files
themselves stay under the AGPL like everything else in this repository;
what is withheld is their use as a brand.

You are free to say, truthfully, that your work is based on aloud.

---

Copyright © Alex Krusz. All rights reserved under the AGPL-3.0 with the
exception above.
