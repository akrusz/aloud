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
| [mobile.md](mobile.md) | Capacitor build guide (iOS + Android). Start here for anything mobile. |
| [mobile-signing.md](mobile-signing.md) | Signing + shipping to TestFlight / Play internal testing. Needs your accounts and certs. |
| [mobile-signin-setup.md](mobile-signin-setup.md) | Console + config checklist for native Google/Apple sign-in. Code is done; this is the account-side setup. |
| [mobile-device-validation.md](mobile-device-validation.md) | Per-device-category matrix for deciding whether free on-device STT/TTS is good enough to default to. |
| [store-submission-checklist.md](store-submission-checklist.md) | The map from here to live on both stores. How-to lives in the two docs above. |
| [store-descriptions.md](store-descriptions.md) | Store listing copy. |

## Server & billing

| Doc | |
|---|---|
| [ts-server.md](ts-server.md) | Running aloud cloud (`@aloud/server`) - the operational quick-reference. Design rationale is in `ts/server/README.md`. |
| [x402.md](x402.md) | USDC-on-Base credit purchases. **Built, flag-gated OFF** - what remains is a live testnet round-trip plus mainnet ops. |

## Reference

| Doc | |
|---|---|
| [style.md](style.md) | Brand and color system. Prefer this over what's "natural" to grep - old warm/amber values still lurk. |
| [voice-barge-in.md](voice-barge-in.md) | How interrupting the facilitator mid-sentence works. Entirely client-side; two pathways by STT backend. |

## Working notes

| Doc | |
|---|---|
| [friction.md](friction.md) | Inbox for repo/tooling friction. Append when something slows you down; promote real items to beads and delete them here. |

Issue tracking is Beads (`bd list`, `bd show <id>`). For a readable backlog:
`python3 scripts/bd-board.py`.
