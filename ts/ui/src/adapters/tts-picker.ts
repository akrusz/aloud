/**
 * Pick a TTS engine based on the user's selected voice.
 *
 * The voice id is prefixed: `server:<name>` for voices that play
 * through the app backend's /app/v1/voices/preview endpoint, `browser:<name>`
 * for voices that come from window.speechSynthesis. The name is the
 * voice's display name (matches voice-picker.ts's ScoredVoice.name).
 *
 * For browser voices, we hand the voice name through to BrowserTtsEngine
 * so each speak() actually applies it — without this every "browser"
 * voice silently fell back to the OS default.
 */

import type { TtsEngine } from '../../../src/platform/tts.js';
import { allVoices, findVoice, type VoiceEntry } from '../voices.js';

import { BrowserTtsEngine } from './browser-tts.js';
import { CloudTtsEngine } from './cloud-tts.js';
import { cloudUrl } from '../cloud-base.js';
import { ensureCloudToken, clearCloudToken } from '../cloud-auth.js';

export interface CreateTtsResult {
    engine: TtsEngine;
    /** Voice we settled on (null when using browser default). */
    voice: VoiceEntry | null;
}

/**
 * Construct a TtsEngine for a voice id stored in SessionSetup /
 * AppSettings. Handles a few id shapes:
 *
 *   - `server:<name>`  — server-side TTS (macOS / Piper / ElevenLabs)
 *   - `browser:<name>` — browser speechSynthesis with that voice name
 *   - `browser:` + an empty suffix or no prefix at all — browser default
 *
 * For server voices we also try the catalog so we get the right engine
 * suffix (`engine_for_voice`). For browser voices we hand the name to
 * BrowserTtsEngine directly — the catalog id scheme is voiceURI-based,
 * the picker is name-based, and reconciling those two is more brittle
 * than just trusting the name.
 */
export interface CreateTtsOptions {
    /**
     * Forwarded to CloudTtsEngine — reports characters synthesized
     * server-side for session usage tracking. Browser TTS ignores it (no
     * server compute, not counted).
     */
    onServerSynthesize?: (chars: number) => void;
}

/**
 * Hosted TTS via the server's authed /v1/tts (Google Cloud TTS). Used when a
 * session is on the hosted ('aloud') provider so the whole pipeline runs
 * server-side. `voice` is a Google Cloud voice name; empty → the server's
 * default Chirp3-HD voice. (A hosted voice picker is a follow-up; for now the
 * default carries the experience.)
 */
export function createCloudAloudTts(voice = '', options: CreateTtsOptions = {}): TtsEngine {
    const opts: ConstructorParameters<typeof CloudTtsEngine>[0] = {
        voice,
        endpointUrl: cloudUrl('/tts'),
        usePost: true,
        authProvider: ensureCloudToken,
        // Drop a rejected token and re-sign-in once (mirrors the LLM proxy), so
        // a stale session doesn't break hosted TTS for the whole page lifetime.
        onAuthError: clearCloudToken,
    };
    if (options.onServerSynthesize) opts.onSynthesize = options.onServerSynthesize;
    return new CloudTtsEngine(opts);
}

/**
 * Hosted-voice preview via the server's PUBLIC `/cloud/v1/tts/preview` — no auth,
 * no credits. The server speaks its own fixed phrase for a curated voice and
 * caches the clip, so signed-out visitors can audition the aloud cloud voices.
 * Distinct from createCloudAloudTts (the authed, metered session path): preview
 * is free, real synthesis is paid. `voice` is a curated short name ("Leda").
 */
export function createCloudAloudPreviewTts(voice: string): TtsEngine {
    return new CloudTtsEngine({
        voice,
        endpointUrl: cloudUrl('/tts/preview'),
        // GET, no bearer — the endpoint is public and ignores any sent text in
        // favor of its server-owned phrase, so nothing here needs auth.
        usePost: false,
    });
}

export async function createTtsForVoice(
    voiceId: string | null,
    options: CreateTtsOptions = {}
): Promise<CreateTtsResult> {
    if (!voiceId) {
        return { engine: new BrowserTtsEngine(), voice: null };
    }

    if (voiceId.startsWith('aloud:')) {
        // Hosted Google voice — synthesize through the server's /v1/tts.
        const name = voiceId.slice('aloud:'.length);
        return { engine: createCloudAloudTts(name, options), voice: null };
    }

    if (voiceId.startsWith('browser:')) {
        const name = voiceId.slice('browser:'.length);
        const engine = name
            ? new BrowserTtsEngine({ defaultVoice: name })
            : new BrowserTtsEngine();
        return { engine, voice: null };
    }

    if (voiceId.startsWith('server:')) {
        const name = voiceId.slice('server:'.length);
        // Try the catalog so we can pass the right engine (piper/macos/
        // elevenlabs) to CloudTtsEngine. If the catalog can't find it,
        // fall back to a bare CloudTtsEngine with just the name — the app
        // backend will route it correctly via engine_for_voice on its side.
        const voices = await allVoices();
        const voice =
            voices.find((v) => v.id === voiceId) ??
            voices.find((v) => v.name === name && v.source === 'server') ??
            null;
        const sttOptions: ConstructorParameters<typeof CloudTtsEngine>[0] = { voice: name };
        if (voice?.engine) sttOptions.engine = voice.engine;
        if (options.onServerSynthesize) sttOptions.onSynthesize = options.onServerSynthesize;
        return { engine: new CloudTtsEngine(sttOptions), voice };
    }

    // Legacy / unprefixed id — try the catalog one more time.
    const voices = await allVoices();
    const voice = findVoice(voices, voiceId);
    if (voice && voice.source === 'server') {
        const sttOptions: ConstructorParameters<typeof CloudTtsEngine>[0] = { voice: voice.name };
        if (voice.engine) sttOptions.engine = voice.engine;
        if (options.onServerSynthesize) sttOptions.onSynthesize = options.onServerSynthesize;
        return { engine: new CloudTtsEngine(sttOptions), voice };
    }
    return {
        engine: voice ? new BrowserTtsEngine({ defaultVoice: voice.name }) : new BrowserTtsEngine(),
        voice,
    };
}
