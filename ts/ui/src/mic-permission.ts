/**
 * Ensure the OS microphone (Android RECORD_AUDIO) is granted before a WebView
 * getUserMedia on native mobile (meditation-pal cloud-STT bug).
 *
 * Capacitor's WebChromeClient only grants the WebView's RESOURCE_AUDIO_CAPTURE
 * when the app already holds the runtime mic permission. The native STT plugin
 * requests it via its own permission flow, but the cloud/Whisper PCM path calls
 * getUserMedia directly and never does - so on Android the WebView denies mic
 * capture and the user sees a vague permission error. Pre-request it here.
 *
 * Reuses the speech-recognition plugin's permission (the only mic-capable plugin
 * installed): on Android its `speechRecognition` alias IS RECORD_AUDIO, the same
 * grant getUserMedia needs. Dynamic import so web/desktop bundles don't pull the
 * plugin (mirrors android-back.ts / wakelock.ts). No-op off Capacitor and
 * best-effort: getUserMedia surfaces the real error if this couldn't help.
 */

import { isCapacitor } from './is-desktop.js';

export async function ensureMicPermission(): Promise<void> {
    if (!isCapacitor()) return;
    try {
        const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');
        const perm = await SpeechRecognition.checkPermissions();
        if (perm.speechRecognition !== 'granted') {
            await SpeechRecognition.requestPermissions();
        }
    } catch {
        /* best-effort; the getUserMedia caller reports the real failure */
    }
}
