# Mobile on-device STT/TTS — manual validation matrix

A checklist for deciding, per device category, whether the **free on-device**
option is good enough to be the default, or whether to default to the **paid
cloud** option. The app already picks STT/TTS by platform; this validation feeds
a per-category allowlist so the default is chosen by **category + cost**.

## First: STT and TTS vary very differently across same-OS devices

You asked how much things vary between devices on the same OS. They differ by
kind, and that changes how much manual testing you actually need:

| | What can differ on the SAME OS version | Same-OS variance | Testing strategy |
|---|---|---|---|
| **STT (speech in)** — SFSpeechRecognizer (iOS) / SpeechRecognizer (Android) | iOS: whether the chip supports **on-device** recognition. Android: which recognition **service** the manufacturer ships (Google vs Samsung vs other) | **iOS: low** (consistent per chip+OS). **Android: high** (manufacturer-dependent) | iOS: one device per chip/OS bucket is representative. Android: test per **manufacturer**, not per model. |
| **TTS (voice out)** — AVSpeechSynthesizer / Android system TTS, reached via the WebView's `speechSynthesis` | Which **voices are installed**. iOS enhanced/premium voices are per-device downloads; Android voice set depends on the TTS **engine** (Google/Samsung/manufacturer) | **iOS: low for default voices, high for premium.** **Android: high** | Validate only the **guaranteed/default** voices. Never depend on a premium voice being present. Detect at runtime + fall back to cloud. |

**Bottom line:** on iOS you can pick a default per OS version with confidence.
On Android you should **detect the engine/voice at runtime and fall back to
cloud** when the device's native option is weak or absent — you can't assume a
specific manufacturer's stack.

## What the app offers on mobile (the options under test)

- **STT**
  - `capacitor` — native on-device (SFSpeechRecognizer / Android SpeechRecognizer). **Free.** Current mobile default.
  - `aloud` — cloud Whisper (OpenAI `gpt-4o-transcribe`, or Groq). **Costs credits.** The fallback.
  - (browser web-speech is *not* offered on native — the native plugin is better.)
- **TTS**
  - `browser` — the WebView's `speechSynthesis`, i.e. the **native system voices**. **Free.** Current mobile default.
  - cloud voices — OpenAI / Google TTS / ElevenLabs via `/cloud/v1`. **Costs credits** (TTS is the dominant cost line — bead `b7i`).

## STT validation — device buckets

Test **one representative device per bucket**. Buckets are drawn on the axis
that actually changes the engine.

### iOS (axis: chip generation → on-device support, + iOS version)

| Bucket | Representative devices | Why | Priority |
|---|---|---|---|
| **i1 — modern flagship** | iPhone 15 / 16 (A16–A18), iOS 17–18 | Best case; confirms the ceiling | Med |
| **i2 — mainstream / floor** | iPhone SE 2/3, iPhone 11, iPhone 13, iOS 16–18 | The honesty floor (bead `7ej`: iPhone 13 / 4 GB). Most important. | **High** |
| **i3 — older supported (optional)** | iPhone XR / XS (A12), iOS 16 | Only if you support iOS 16 | Low |

### Android (axis: manufacturer recognition service, + version, + RAM)

| Bucket | Representative devices | Why | Priority |
|---|---|---|---|
| **a1 — Pixel (clean Google)** | Pixel 6–8, Android 13–14 | On-device recognition works well here; the good case | Med |
| **a2 — Samsung** | Galaxy S/A series, Android 13–14 | Largest real-world share; own software layer | **High** |
| **a3 — budget / other OEM** | Motorola / Xiaomi / OnePlus, Android 12–13, ~4 GB | Worst-case variance + weak hardware | **High** |

### STT test cases (run every bucket)

These are the meditation-specific ways native recognizers (tuned for Siri-style
queries) tend to fail — from bead `0ao`:

1. **Long pause mid-utterance** (3–5 s of silence, then continue) — does it cut off / give up?
2. **Soft / near-whispered speech** — recognized, or dropped?
3. **Brief 1–2 word noting**: "warmth", "tightness", "sound", "heat" — short utterances misfire often.
4. **Trailing half-sentence** into silence.
5. **Silence-cutoff timing** — how many seconds before it auto-stops? Acceptable for meditation pacing?
6. **Offline** — works with the network off (true on-device), or requires connectivity? (This decides whether the "private, stays on your phone" claim is honest for that device.)
7. **Latency** of the final transcript for a ~15-word utterance.

**Record per bucket:** pass/fail on 1–5, offline yes/no (6), latency (7), + a
one-line subjective quality note. **Decision:** native is the default for that
category if it passes 1–5 **and** is offline; otherwise cloud Whisper is the
default there.

## TTS validation — device buckets

Same buckets (i1/i2, a1/a2/a3). The question is narrower: **is there a usable
default voice**, and does it sound acceptable for slow, warm meditation delivery?

### Checks (per bucket)

1. **Enumerate** `speechSynthesis.getVoices()` in the WebView. iOS often does
   **not** expose Siri voices to web APIs — confirm what's actually reachable
   (this alone may decide iOS: default AVSpeech voices vs cloud).
2. **Default en-US voice quality** at a slow rate: naturalness, warmth, does it
   sound robotic or rushed?
3. **Rate / pitch controls** actually take effect (some engines ignore them).
4. **Android only:** which TTS **engine** is present (Google / Samsung / other)?
   Is any full engine installed at all (rare budget devices ship without one)?
5. **Latency** to first audio.

**Record per bucket:** the reachable default voice name, a quality rating, and
whether it's good enough to ship as the free default. **Decision (expected
shape):** iOS default AVSpeech voices are usually decent → native default;
Android voice quality/availability is inconsistent → likely **detect a known-good
voice at runtime, fall back to cloud** when absent or poor. Cloud TTS is the
consistent-but-paid path, so this is where the category → cost trade-off bites
hardest.

## Turning results into the default-selection logic

**Agreed model (2026-07-05):** on **weaker devices, default to aloud cloud**;
on capable devices, default to the **free native** option. Either way, **all
options always appear in the Settings selector** so any user can switch. The
default is a small function of (platform bucket detected at launch) →
(native | cloud):

- **STT:** default `capacitor` (free) for buckets that passed validation;
  default `aloud` (cloud) for buckets that failed. Detection: platform +
  `isCapacitor()` + (Android) a `navigator.deviceMemory` / manufacturer read;
  iOS by device model (`@capacitor/device`) since WKWebView doesn't expose RAM.
- **TTS:** default `browser` (native) where a known-good voice is present;
  else a cloud voice. Detection: enumerate voices at launch, match a
  per-platform known-good allowlist built from this validation.

### The one catch to weigh: cloud-default means an immediate paywall

Native STT/TTS is free, offline, and needs no sign-in. aloud cloud needs
**sign-in + credits**. So "default weak devices to cloud" means a **new user on
a cheaper device hits sign-in and credit spend from their first session**, while
someone on a flagship gets it free — slightly backwards on accessibility. Weigh
this per bucket during validation; it may be better to keep native default even
on some weak buckets if it's merely mediocre (not broken), since the user can
switch.

### Beta interim (before validation data exists)

Ship **native default everywhere + all options in the selector** (the current
state). It's free, has no surprise paywall, and meets the "mediocre-for-a-bit,
user can switch" bar. The selector already lists `capacitor` (default) and
`aloud` on mobile today, so nobody is stuck. After the buckets above are scored,
flip the **validated-weak** buckets to cloud-default — a change in one place
(`defaultSttChoice` / the TTS default), no new architecture.

Tracked by: `0ao` (native STT) + `g0ox` (native TTS) for the data; the
capability-tier default-selection bead consumes their results. Parent `zp47`.
