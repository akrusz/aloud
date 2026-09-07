/**
 * The one <audio> element every hosted-TTS utterance plays through, plus the
 * user-gesture priming that lets it make sound at all.
 *
 * Safari (macOS and iOS) grants playback permission PER ELEMENT, and only to an
 * element whose play() was called inside a user gesture. A session's first
 * sentence arrives several awaits after the Begin click - LLM, then synthesis -
 * so a freshly constructed `new Audio(blobUrl)` is unprivileged by then and
 * play() rejects with NotAllowedError: the sit runs mute (macOS Safari's
 * default per-site "Stop Media with Sound" auto-play setting does the same).
 * Chrome doesn't gate this way, which is why it went unnoticed until a Safari
 * session reported no voice at all.
 *
 * So: prime this element with a silent clip inside the Begin handler, then
 * reuse it for every utterance. The permission rides on the element. The shared
 * AudioContext (the noting chime) is primed on the same click, for the same
 * reason - it is born suspended and only a gesture may resume it.
 */

/** 8ms of 8-bit mono silence - the shortest thing that is a valid WAV. */
const SILENT_WAV =
    'data:audio/wav;base64,UklGRmQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YUAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

import { capacitorPlatform, isTauri } from './is-desktop.js';

let element: HTMLAudioElement | null = null;
let context: AudioContext | null = null;
let keepAlive: AudioBufferSourceNode | null = null;

/** The shared playback element, created on first use. */
export function playbackAudio(): HTMLAudioElement {
    if (!element) {
        element = new Audio();
        // Buffer before play(), trimming the lead-in gap (Firefox most of all).
        element.preload = 'auto';
    }
    return element;
}

/**
 * The shared AudioContext for synthesized sound (the noting chime). Created on
 * first use; born suspended unless primed from a gesture, and a suspended
 * context makes no sound. Null where Web Audio is unavailable.
 */
export function playbackAudioContext(): AudioContext | null {
    if (!context) {
        const Ctor =
            (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
            (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return null;
        context = new Ctor();
    }
    if (context.state === 'suspended') void context.resume().catch(() => {});
    return context;
}

/**
 * Keep the output path awake for the whole session, on the platforms where
 * cloud TTS plays through this context (Android, desktop - cloud-tts.ts).
 * Two things eat the first phoneme of a reply after a quiet stretch
 * (meditation-pal-tur5, "right" -> "ight"): Chromium stops the context's
 * output track once it has rendered silence for a while and restarts it on
 * the next sound, and the phone fades every freshly started track in - fixed
 * by any non-silent signal; and the output hardware itself (a phone's speaker
 * DSP, a laptop's amp, a Bluetooth link) gates or sleeps on near-silence,
 * which a -80 dBFS noise floor did not prevent (the reply after the sit's
 * longest silence still clipped, on both devices). So the keep-alive is a
 * 25 Hz tone at -40 dBFS: well below what a speaker or earphone reproduces,
 * far above what a gate treats as silence. Stopped by the session's teardown.
 */
export function startPlaybackKeepAlive(): void {
    const ctx = playbackAudioContext();
    if (!ctx || keepAlive) return;
    try {
        const seconds = 1; // 25 whole cycles: loops seamlessly
        const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = 0.01 * Math.sin((2 * Math.PI * 25 * i) / ctx.sampleRate);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.connect(ctx.destination);
        source.start();
        keepAlive = source;
    } catch {
        // A context without buffer support (test doubles): nothing to keep.
    }
}

export function stopPlaybackKeepAlive(): void {
    if (!keepAlive) return;
    try {
        keepAlive.stop();
        keepAlive.disconnect();
    } catch {
        // already stopped
    }
    keepAlive = null;
}

/**
 * Grant the shared element playback permission. MUST be called synchronously
 * from a user gesture (the Begin click) - before any await, exactly like
 * acquireMicOnce - or the gesture is spent and this no-ops silently.
 */
export function primeAudioPlayback(): void {
    // Same gate, other half of the audio stack: a context first resumed outside
    // a gesture stays suspended on Safari, and the chime never sounds.
    playbackAudioContext();
    if (capacitorPlatform() === 'android' || isTauri()) startPlaybackKeepAlive();
    const audio = playbackAudio();
    console.info(`[audio] prime: element ${audio.paused ? 'paused' : 'playing'}`);
    // A prime mid-session would cut off the sentence being spoken.
    if (!audio.paused) return;
    try {
        audio.src = SILENT_WAV;
        // Rejects when the browser blocks it anyway; nothing to do but continue -
        // the real playback attempt reports its own failure.
        void audio.play().catch(() => {});
    } catch {
        // ignore
    }
}
