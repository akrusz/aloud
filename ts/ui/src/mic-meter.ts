/**
 * Mic input-level meter — pulses the mic button with live input volume.
 *
 * The CSS reacts to a `--mic-level` (0..1) custom property on the
 * `.btn-voice.active` element (box-shadow ring scales with it). The Web Speech
 * path hides its audio, so we open a small dedicated AnalyserNode stream just
 * for the meter.
 *
 * One stream for the whole session; start() opens it, stop() tears it fully
 * down (track + context). Safe to call stop() more than once.
 */

export interface MicMeter {
    stop(): void;
}

const SMOOTHING = 0.8; // exponential smoothing on the level (0..1)
const GAIN = 4; // maps typical speech RMS (~0.05–0.25) onto a visible 0..1

/**
 * Start metering mic input onto `target`'s `--mic-level`. Resolves once the
 * mic stream is live; rejects if permission is denied or audio is unavailable
 * (callers can ignore the rejection — the meter is purely cosmetic).
 */
export async function startMicMeter(target: HTMLElement): Promise<MicMeter> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const AC =
        (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
        (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) {
        for (const t of stream.getTracks()) t.stop();
        throw new Error('AudioContext unavailable');
    }

    const ctx = new AC();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const buf = new Uint8Array(analyser.frequencyBinCount);
    let smoothed = 0;
    let raf = 0;
    let stopped = false;

    const tick = (): void => {
        if (stopped) return;
        analyser.getByteTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) {
            const v = (buf[i]! - 128) / 128; // center at 0
            sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / buf.length);
        const level = Math.min(1, rms * GAIN);
        smoothed = smoothed * SMOOTHING + level * (1 - SMOOTHING);
        target.style.setProperty('--mic-level', smoothed.toFixed(3));
        raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return {
        stop(): void {
            if (stopped) return;
            stopped = true;
            cancelAnimationFrame(raf);
            target.style.removeProperty('--mic-level');
            try {
                source.disconnect();
            } catch {
                /* ignore */
            }
            if (ctx.state !== 'closed') ctx.close().catch(() => {});
            for (const t of stream.getTracks()) t.stop();
        },
    };
}
