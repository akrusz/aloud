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

/** Taps on the About-box version line needed to toggle dev mode. */
export const DEV_MODE_TAPS = 7;

export function isDevMode(): boolean {
    try {
        return localStorage.getItem(DEV_MODE_KEY) === '1';
    } catch {
        return false;
    }
}

export function setDevMode(on: boolean): void {
    try {
        if (on) localStorage.setItem(DEV_MODE_KEY, '1');
        else localStorage.removeItem(DEV_MODE_KEY);
    } catch {
        /* storage unavailable: dev mode just won't persist */
    }
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
    try {
        return localStorage.getItem(DEBUG_CHECKIN_KEY) === '1';
    } catch {
        return false;
    }
}

export function setCheckinDebug(on: boolean): void {
    try {
        if (on) localStorage.setItem(DEBUG_CHECKIN_KEY, '1');
        else localStorage.removeItem(DEBUG_CHECKIN_KEY);
    } catch {
        /* ignore */
    }
}

/** Developer switch: open the cloud-STT capture stream with
 *  echoCancellation:false. On Android, EC puts the WebView in
 *  MODE_IN_COMMUNICATION, so TTS during a cloud sit plays on the call stream
 *  (meditation-pal-0ecr); this is the experiment that measures what the
 *  platform AEC was buying us (judge by the "[vad] tts window" lines). Applies
 *  at the next capture, i.e. the next session. */
export function isAecOffDebug(): boolean {
    try {
        return localStorage.getItem(DEBUG_AEC_OFF_KEY) === '1';
    } catch {
        return false;
    }
}

export function setAecOffDebug(on: boolean): void {
    try {
        if (on) localStorage.setItem(DEBUG_AEC_OFF_KEY, '1');
        else localStorage.removeItem(DEBUG_AEC_OFF_KEY);
    } catch {
        /* ignore */
    }
}
