/**
 * Ensure the OS microphone (Android RECORD_AUDIO) is granted before a WebView
 * getUserMedia on Android (meditation-pal cloud-STT bug).
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
 * plugin (mirrors android-back.ts / wakelock.ts). No-op off Android and
 * best-effort: getUserMedia surfaces the real error if this couldn't help.
 * Returns whether the grant is held, or null when there was nothing to ask.
 *
 * Never on iOS: there the plugin's permission is Apple's Speech Recognition
 * prompt, which a cloud-STT user doesn't need (a tester took it to mean they
 * were on the built-in recognizer), and WKWebView asks for the mic itself.
 */

import { capacitorPlatform } from './is-desktop.js';

export async function ensureMicPermission(): Promise<boolean | null> {
    if (capacitorPlatform() !== 'android') return null;
    try {
        const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');
        const perm = await SpeechRecognition.checkPermissions();
        if (perm.speechRecognition === 'granted') return true;
        const asked = await SpeechRecognition.requestPermissions();
        return asked.speechRecognition === 'granted';
    } catch {
        /* best-effort; the getUserMedia caller reports the real failure */
        return null;
    }
}
