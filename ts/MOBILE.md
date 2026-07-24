# Mobile build (Capacitor)

**The mobile guide moved: [`dev-docs/mobile.md`](../dev-docs/mobile.md).**

That's the current one - prerequisites and JDK version, the daily
`cap:android:run` loop, the committed native config, native sign-in, icons, the
patched speech plugin, and what's still device-dependent. Signing and store work
live next to it in [`mobile-signing.md`](../dev-docs/mobile-signing.md) and
[`store-submission-checklist.md`](../dev-docs/store-submission-checklist.md).

This file used to walk through `npx cap add ios/android` and deciding a bundle
id before committing the generated projects. That's all done: `ts/ios/` and
`ts/android/` are committed (`ts/.gitignore` says so), the bundle id is
`app.aloud.meditation`, and Android is headed for Play internal testing.

Kept here only because the path is linked from elsewhere.
