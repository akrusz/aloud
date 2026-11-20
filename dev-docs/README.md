# dev-docs

Working docs for aloud. Architecture and the rules that override defaults live in
[CLAUDE.md](../CLAUDE.md); everything here is detail.

**Start with [dev-cheatsheet.md](dev-cheatsheet.md)** - commands, ports, dev URL
params, gotchas. It's the one to keep open.

## Testing & release

| Doc | |
|---|---|
| [soak-harness.md](soak-harness.md) | Automated whole sessions: an LLM plays the meditator. Tier 1 text-level on a fake clock, tier 2 real UI over a virtual mic. The pre-release check. |
| [manual-smoke.md](manual-smoke.md) | The 5-10 minutes of by-hand checks the soak tiers structurally can't reach - the Tauri shell, permission refusals, real speakers, phones. |
| [pre-release-checklist.md](pre-release-checklist.md) | Doc/copy drift audit against the current diff. Ask Claude to "run the pre-release check". |
| [deploy.md](deploy.md) | The live deploy runbook: Fly-hosted server + static UI, and how one tag ships both. |

## Platforms

| Doc | |
|---|---|
| [desktop.md](desktop.md) | The Tauri 2 shell - embedded axum backend, build, signing, notarization. |
| [audio-output.md](audio-output.md) | Why every sound plays through an `<audio>` element, never Web Audio (WebKit's shared output pipe): which element plays what, level in the files, fades, phones, the media-keys guard. |
| [mobile.md](mobile.md) | Capacitor build guide (iOS + Android). Start here for anything mobile. |
| [mobile-signing.md](mobile-signing.md) | Signing + shipping to TestFlight / Play internal testing. Needs your accounts and certs. |
| [mobile-signin-setup.md](mobile-signin-setup.md) | Console + config checklist for native Google/Apple sign-in. Code is done; this is the account-side setup. |
| [mobile-device-validation.md](mobile-device-validation.md) | Per-device-category matrix for deciding whether free on-device STT/TTS is good enough to default to. |
| [store-submission-checklist.md](store-submission-checklist.md) | The map from here to live on both stores. How-to lives in the two docs above. |
| [age-tier.md](age-tier.md) | The app store's age signal (Play Age Signals, Apple's Declared Age Range) as a tier, and the screen that blocks the app under 13. |
| [store-descriptions.md](store-descriptions.md) | Store listing copy. |

## Server & billing

| Doc | |
|---|---|
| [ts-server.md](ts-server.md) | Running aloud cloud (`@aloud/server`) - the operational quick-reference. Design rationale is in `ts/server/README.md`. |
| [x402.md](x402.md) | USDC-on-Base credit purchases. **Built, flag-gated OFF** - what remains is a live testnet round-trip plus mainnet ops. |

## Engine behavior

| Doc | |
|---|---|
| [stepping-out.md](stepping-out.md) | A meditator who is frightened, ungrounded or in danger: the prompt section, the per-utterance trouble check behind it, and what each was measured to do. |
| [silence-mode.md](silence-mode.md) | `[HOLD]` as a bid, the three silence classifiers, and the Jev judge in front of them. |
| [pacing.md](pacing.md) | Check-ins (canned vs smart content, fixed vs `[WAIT]` timing), the spoken session timer, what a first sit ("Try right now") overrides, and a noting circle's pace. |
| [voice-commands.md](voice-commands.md) | Mic pre-flight, the commands that need no judge ("mute", "end the session"), voice on the setup screen (its requests, judge tier, house-voice clips, the spoken tour), and the judge-backed spoken commands. |
| [voice-barge-in.md](voice-barge-in.md) | How interrupting the facilitator mid-sentence works. Entirely client-side; the pathway depends on the STT backend and, on iPhone, headphones. |
| [language.md](language.md) | English / 中文: the prompt fragment, zh pools, STT locale, and the `t()` catalog. |

## Reference

| Doc | |
|---|---|
| [style.md](style.md) | Brand and color system. Prefer this over what's "natural" to grep - old warm/amber values still lurk. |

## Working notes

| Doc | |
|---|---|
| [friction.md](friction.md) | Inbox for repo/tooling friction. Append when something slows you down; promote real items to beads and delete them here. |
| [design-push.md](design-push.md) | A one-day design push planned with Claude before the Android production release: three open ideas, small fixes, and where the design system artifact lives. |

Issue tracking is Beads (`bd list`, `bd show <id>`). For a readable backlog:
`python3 scripts/bd-board.py`.
