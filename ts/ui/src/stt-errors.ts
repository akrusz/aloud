/**
 * Map raw STT / hosted-service errors to clear, actionable user-facing lines.
 * Standalone (no DOM/view imports) so node-env tests can cover the matching
 * order - which is load-bearing: a mis-ordered match here once hid the "model
 * still loading" 503 behind a misleading "check your connection".
 */

import { t } from './i18n.js';

/**
 * Map a hosted-server error to a clear, actionable message. The server returns
 * structured errors ({error:{code}}, ts/server/src/contract.ts), but by the time
 * they reach the client they're flattened to a status + message string, so match
 * on both the code names and the embedded HTTP status. Returns null for
 * unrecognized errors so callers keep their own phrasing.
 */
export function describeCloudError(msg: string): string | null {
    if (/insufficient_credits|out of credits|endpoint 402/i.test(msg)) {
        return t(
            'aloud cloud requires credits. Purchase more, or choose a different provider in Settings.'
        );
    }
    if (/unauthenticated|endpoint 401/i.test(msg)) {
        return t('aloud cloud needs you to sign in again. Check Settings.');
    }
    if (/email_unverified|endpoint 403/i.test(msg)) {
        return t('Verify your email to use aloud cloud, then try again.');
    }
    if (/quota_exceeded|endpoint 429/i.test(msg)) {
        return t("You've hit aloud's rate limit. Wait a moment and try again.");
    }
    return null;
}

export function describeSttError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    // Hosted credits/auth conditions get a clear line instead of a raw
    // "Whisper endpoint 402: {json}".
    const hosted = describeCloudError(msg);
    if (hosted) return hosted;
    // 503 = the Whisper backend answered but isn't ready (model downloading,
    // or a failed download being retried). The body says which - surface it.
    // Must precede the generic 5xx match or it never fires.
    const notReady = /Whisper endpoint 503: (.*)$/.exec(msg);
    if (notReady) {
        try {
            const detail = (JSON.parse(notReady[1]!) as { error?: string }).error;
            if (detail) return detail;
        } catch {
            // unstructured body - fall through to the generic line
        }
        return t('Whisper model still loading. Try again in a moment.');
    }
    if (/Whisper endpoint 5\d\d/.test(msg) || /failed to fetch/i.test(msg)) {
        return t('Speech-recognition backend unreachable. Check your connection.');
    }
    // `service-not-allowed` is a blocked *service*, not a denied mic. On
    // Windows/Edge it's usually the OS "online speech recognition" privacy
    // toggle or an enterprise policy; on Apple platforms it's Dictation being
    // off. Either way the recognizer can't work until that changes, so name
    // both and point at the in-session switch to aloud cloud.
    if (msg === 'service-not-allowed') {
        return t(
            "This browser is blocking its speech recognition (Windows: Settings → Privacy → Speech; Mac: turn on Dictation). Or switch to aloud cloud speech - it doesn't need it."
        );
    }
    // Web Speech's own denied-permission code is the hyphenated `not-allowed`
    // (distinct from getUserMedia's `NotAllowedError`, matched below).
    if (msg === 'not-allowed') {
        return t(
            'Microphone access is blocked. Allow the mic for this site (the padlock in the address bar), or switch to aloud cloud speech.'
        );
    }
    if (/permission/i.test(msg) || /denied/i.test(msg) || /NotAllowed/.test(msg)) {
        return t('Mic permission denied. Allow microphone access and try again.');
    }
    // `network` means Web Speech's cloud recognizer was unreachable. Usually a
    // Chromium build (Brave, others) where Google blocks the speech endpoint, so
    // it can never succeed - point at the paths that work.
    if (msg === 'network') {
        return t(
            'Browser speech recognition is blocked in this browser. Switch to aloud cloud speech, or use Chrome/Edge.'
        );
    }
    return t('Mic error: {message}', { message: msg });
}
