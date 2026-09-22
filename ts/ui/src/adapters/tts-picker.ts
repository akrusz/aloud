/**
 * Pick a TTS engine from the user's selected voice id, which is prefixed:
 * `server:<name>` plays through the app backend's /app/v1/voices/preview,
 * `browser:<name>` through window.speechSynthesis, `aloud:<name>` through the
 * hosted /v1/tts. The name is the display name (voice-picker.ts's
 * ScoredVoice.name), handed to BrowserTtsEngine so each speak() actually applies
 * it - without that, every browser voice falls back to the OS default.
 */

import type { TtsEngine } from '../../../src/platform/tts.js';
import { allVoices, findVoice, type VoiceEntry } from '../voices.js';

import { BrowserTtsEngine } from './browser-tts.js';
import { CloudTtsEngine, type CloudTtsEngineOptions } from './cloud-tts.js';
import { cloudUrl } from '../cloud-base.js';
import { simulateTtsFault } from '../dev-sim.js';
import { ensureCloudToken, clearCloudToken } from '../cloud-auth.js';

export interface CreateTtsResult {
    engine: TtsEngine;
    /** Voice we settled on (null when using browser default). */
    voice: VoiceEntry | null;
}

export interface CreateTtsOptions {
    /** Forwarded to CloudTtsEngine - characters synthesized server-side, for
     *  session usage tracking. Browser TTS ignores it (no server compute). */
    onServerSynthesize?: (chars: number) => void;
}

/**
 * Hosted TTS via the server's authed /v1/tts (Google Cloud TTS), used when a
 * session runs on the hosted ('aloud') provider. `voice` is a Google Cloud voice
 * name; empty → the server's default Chirp3-HD voice.
 */
export function createCloudAloudTts(voice = '', options: CreateTtsOptions = {}): TtsEngine {
    const opts: CloudTtsEngineOptions = {
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
 * Hosted-voice preview via the PUBLIC `/cloud/v1/tts/preview` - no auth, no
 * credits. The server speaks its own fixed phrase for a curated voice and caches
 * the clip, so signed-out visitors can audition. Distinct from
 * createCloudAloudTts (the authed, metered session path). `voice` is a curated
 * short name ("Leda").
 */
export function createCloudAloudPreviewTts(voice: string): TtsEngine {
    return new CloudTtsEngine({
        voice,
        endpointUrl: cloudUrl('/tts/preview'),
        // GET, no bearer: the endpoint is public and ignores sent text in favor
        // of its server-owned phrase.
        usePost: false,
    });
}

/** A voice on the app backend's /app/v1/voices/preview (Piper, `say`, ...). */
function serverVoiceTts(
    name: string,
    engine: string | undefined,
    options: CreateTtsOptions
): TtsEngine {
    const opts: CloudTtsEngineOptions = { voice: name };
    if (engine) opts.engine = engine;
    if (options.onServerSynthesize) opts.onSynthesize = options.onServerSynthesize;
    return new CloudTtsEngine(opts);
}

/**
 * Construct a TtsEngine for a voice id stored in SessionSetup / AppSettings.
 * An empty suffix, or no prefix at all, means the browser default.
 */
export async function createTtsForVoice(
    voiceId: string | null,
    options: CreateTtsOptions = {}
): Promise<CreateTtsResult> {
    const result = await buildTtsForVoice(voiceId, options);
    // Dev-build simulation hook (no-op everywhere else): hosted TTS billing and
    // auth failures are handled separately from the LLM leg (handleTtsError),
    // so they need their own way in.
    return { ...result, engine: simulateTtsFault(result.engine) };
}

async function buildTtsForVoice(
    voiceId: string | null,
    options: CreateTtsOptions = {}
): Promise<CreateTtsResult> {
    if (!voiceId) {
        return { engine: new BrowserTtsEngine(), voice: null };
    }

    if (voiceId.startsWith('aloud:')) {
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
        // Try the catalog for the right engine (piper/macos/elevenlabs). If it
        // can't be found, the name alone is enough - the app backend routes it
        // via engine_for_voice.
        const voices = await allVoices();
        const voice =
            voices.find((v) => v.id === voiceId) ??
            voices.find((v) => v.name === name && v.source === 'server') ??
            null;
        return { engine: serverVoiceTts(name, voice?.engine, options), voice };
    }

    // Legacy / unprefixed id - try the catalog one more time.
    const voices = await allVoices();
    const voice = findVoice(voices, voiceId);
    if (voice && voice.source === 'server') {
        return { engine: serverVoiceTts(voice.name, voice.engine, options), voice };
    }
    return {
        engine: voice ? new BrowserTtsEngine({ defaultVoice: voice.name }) : new BrowserTtsEngine(),
        voice,
    };
}
