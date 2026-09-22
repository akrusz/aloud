/**
 * Hidden developer mode.
 *
 * Toggled by tapping the About-box version line 7 times; persisted in
 * localStorage. Gates the Settings Developer section and the check-in debug
 * HUD. No ordinary settings checkbox, so a fresh install never sees it.
 *
 * SECURITY: dev mode only gates debug conveniences harmless anywhere (a pacing
 * HUD, a fake update banner). The dev-BUILD-only overrides (?mode=, ?dev cloud
 * bypass) keep their compile-time import.meta.env.DEV gate in app-mode.ts, so
 * enabling dev mode in a release build cannot reach them.
 */

const DEV_MODE_KEY = 'aloud:devMode';
const DEBUG_CHECKIN_KEY = 'aloud:debugCheckin';
const DEBUG_AEC_OFF_KEY = 'aloud:debugAecOff';
const JEV_CLASSIFIERS_KEY = 'aloud:jevClassifiers';

/** A '1'-valued localStorage flag. Storage unavailable reads as off, and a
 *  write just doesn't persist. */
function readFlag(key: string): boolean {
    try {
        return localStorage.getItem(key) === '1';
    } catch {
        return false;
    }
}

function writeFlag(key: string, on: boolean): void {
    try {
        if (on) localStorage.setItem(key, '1');
        else localStorage.removeItem(key);
    } catch {
        /* ignore */
    }
}

/** Taps on the About-box version line needed to toggle dev mode. */
export const DEV_MODE_TAPS = 7;

export function isDevMode(): boolean {
    return readFlag(DEV_MODE_KEY);
}

export function setDevMode(on: boolean): void {
    writeFlag(DEV_MODE_KEY, on);
}

/** Mount the check-in/[WAIT] HUD: persisted toggle, or a `?debug=checkin`
 *  (also `1`, `true`, `pacing`) URL param for browser sessions. */
export function isCheckinDebugOn(): boolean {
    try {
        const q = new URLSearchParams(location.search).get('debug') ?? '';
        if (/^(1|true|checkin|pacing)$/i.test(q)) return true;
        return localStorage.getItem(DEBUG_CHECKIN_KEY) === '1';
    } catch {
        return false;
    }
}

/** The persisted toggle alone: what the Developer checkbox renders, since a
 *  URL param shouldn't show as a checked setting. */
export function getCheckinDebugSetting(): boolean {
    return readFlag(DEBUG_CHECKIN_KEY);
}

export function setCheckinDebug(on: boolean): void {
    writeFlag(DEBUG_CHECKIN_KEY, on);
}

/** Developer switch: open the cloud-STT capture stream with
 *  echoCancellation:false. On Android, EC puts the WebView in
 *  MODE_IN_COMMUNICATION, so TTS during a cloud sit plays on the call stream
 *  (meditation-pal-0ecr); this is the experiment that measures what the
 *  platform AEC was buying us (judge by the "[vad] tts window" lines). Applies
 *  at the next capture, i.e. the next session. */
export function isAecOffDebug(): boolean {
    return readFlag(DEBUG_AEC_OFF_KEY);
}

export function setAecOffDebug(on: boolean): void {
    writeFlag(DEBUG_AEC_OFF_KEY, on);
}

/**
 * Jev on the silence classifiers, hosted sessions only (v36y). `on` is the
 * default: Jev decides, the LLM classifier is the fallback. `shadow` runs both
 * and acts on the LLM, for measuring a question change; `off` is the LLM alone.
 * Read at session start.
 */
export type JevClassifierMode = 'off' | 'shadow' | 'on';

export function getJevClassifierMode(): JevClassifierMode {
    try {
        const v = localStorage.getItem(JEV_CLASSIFIERS_KEY);
        return v === 'shadow' || v === 'off' ? v : 'on';
    } catch {
        return 'on';
    }
}

export function setJevClassifierMode(mode: JevClassifierMode): void {
    try {
        if (mode === 'on') localStorage.removeItem(JEV_CLASSIFIERS_KEY);
        else localStorage.setItem(JEV_CLASSIFIERS_KEY, mode);
    } catch {
        /* ignore */
    }
}
