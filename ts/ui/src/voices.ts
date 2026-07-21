/**
 * Voice catalog - one list unifying browser speechSynthesis voices and
 * server-side ones (Piper / macOS / ElevenLabs). Each entry carries a `source`
 * so the picker knows which adapter to spin up.
 */

import { appUrl } from './app-base.js';

export type VoiceSource = 'browser' | 'server';

export interface VoiceEntry {
    /** Stable id we round-trip in settings. */
    id: string;
    /** Display name. */
    name: string;
    /** Where to play this voice from. */
    source: VoiceSource;
    /** speechSynthesis engine name (browser) or backend engine (piper, macos, elevenlabs). */
    engine: string | undefined;
    /** BCP-47 language tag. */
    language: string;
}

const SERVER_VOICES_URL = '/voices';
const ID_PREFIX = { browser: 'browser:', server: 'server:' } as const;

let cachedServerVoices: VoiceEntry[] | null = null;

export function browserVoices(): VoiceEntry[] {
    if (typeof speechSynthesis === 'undefined') return [];
    return speechSynthesis.getVoices().map((v) => ({
        id: `${ID_PREFIX.browser}${v.voiceURI}`,
        name: v.name,
        source: 'browser',
        engine: 'browser',
        language: v.lang || 'en-US',
    }));
}

/** {@link browserVoices} after giving Chrome's async `voiceschanged` a chance
 *  to fire (mirrors BrowserTtsEngine.listVoices). Resolves after ~1s at worst;
 *  an empty result then is a real "no voices" (e.g. the Android WebView). */
export async function browserVoicesSettled(): Promise<VoiceEntry[]> {
    if (typeof speechSynthesis === 'undefined') return [];
    if (speechSynthesis.getVoices().length === 0) {
        await new Promise<void>((resolve) => {
            let done = false;
            const finish = (): void => {
                if (done) return;
                done = true;
                speechSynthesis.removeEventListener('voiceschanged', finish);
                resolve();
            };
            speechSynthesis.addEventListener('voiceschanged', finish);
            setTimeout(finish, 1000);
        });
    }
    return browserVoices();
}

/**
 * Fetch the server-side voice list. Caches [] when the app backend isn't
 * reachable, so later calls don't hammer a down server; invalidateServerVoices()
 * retries once it's up.
 */
export async function serverVoices(): Promise<VoiceEntry[]> {
    if (cachedServerVoices !== null) return cachedServerVoices;
    try {
        const response = await fetch(appUrl(SERVER_VOICES_URL));
        if (!response.ok) {
            cachedServerVoices = [];
            return cachedServerVoices;
        }
        const data = (await response.json()) as Array<{
            name?: string;
            engine?: string;
            lang?: string;
        }>;
        cachedServerVoices = data
            .filter((v): v is { name: string; engine?: string; lang?: string } => !!v.name)
            .map((v) => ({
                id: `${ID_PREFIX.server}${v.name}`,
                name: v.name,
                source: 'server',
                engine: v.engine,
                language: (v.lang ?? 'en_US').replace('_', '-'),
            }));
        return cachedServerVoices;
    } catch {
        cachedServerVoices = [];
        return cachedServerVoices;
    }
}

export function invalidateServerVoices(): void {
    cachedServerVoices = null;
}

/** Combined catalog - browser voices first (always present), then server. */
export async function allVoices(): Promise<VoiceEntry[]> {
    const [server] = await Promise.all([serverVoices()]);
    return [...browserVoices(), ...server];
}

export function findVoice(voices: readonly VoiceEntry[], id: string | null): VoiceEntry | null {
    if (!id) return null;
    return voices.find((v) => v.id === id) ?? null;
}

/**
 * Group voices for a <select>: browser voices under 'Browser', server voices
 * under their engine name (or 'Server'). Insertion order preserved.
 */
export function groupVoices(voices: readonly VoiceEntry[]): Map<string, VoiceEntry[]> {
    const out = new Map<string, VoiceEntry[]>();
    for (const v of voices) {
        const key =
            v.source === 'browser'
                ? 'Browser'
                : v.engine
                  ? capitalize(v.engine)
                  : 'Server';
        const list = out.get(key);
        if (list) list.push(v);
        else out.set(key, [v]);
    }
    return out;
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
