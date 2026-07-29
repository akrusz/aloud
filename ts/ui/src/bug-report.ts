/**
 * "Report a bug" and "Report AI content": open the mail composer prefilled
 * with a diagnostics block (version, platform, mode, speech/mic health, user
 * agent) so a reply doesn't start by asking "which version? what device?".
 *
 * Reached from the in-session ⓘ info panel (desktop) and the mobile More
 * sheet. The AI-content report also satisfies Google Play's AI-Generated
 * Content policy (apps whose core feature is generative AI must offer in-app
 * reporting of offensive AI output), so it must stay reachable from a session
 * regardless of which LLM source is active.
 */

import { isTauri, isCapacitor, capacitorPlatform } from './is-desktop.js';
import { appMode, isWebMode } from './app-mode.js';
import { openExternal } from './external-links.js';
import { appUrl } from './app-base.js';
import { loadAppSettings } from './app-settings.js';
import { resolveSttChoice } from './adapters/stt-picker.js';
import { withTimeout } from './net-timeout.js';

/** Same inbox as the About "kind words" / privacy contact. */
const SUPPORT_EMAIL = 'lexkrusz@gmail.com';

function platformLabel(): string {
    if (isTauri()) return 'Desktop';
    if (isCapacitor()) return `Mobile (${capacitorPlatform()})`;
    return 'Web';
}

/**
 * Speech/mic health, one line per probe, each independently best-effort so a
 * hung backend or a missing API never blocks the composer. This is the block
 * that answers "why can't it hear me" without a debugging round-trip: STT
 * source + device pick, local Whisper state, mic permission, input devices.
 */
async function sttDiagnostics(): Promise<string[]> {
    const lines: string[] = [];
    let micDeviceId: string | null = null;
    try {
        const s = await loadAppSettings();
        micDeviceId = s.micDeviceId;
        lines.push(`STT: ${resolveSttChoice(s.sttEngine, isWebMode())}`);
        lines.push(`TTS: ${s.ttsEngine}`);
    } catch {
        // settings unreadable - skip
    }
    if (isTauri()) {
        try {
            const res = await withTimeout(
                fetch(appUrl('/system-info')),
                2000,
                'system-info timed out'
            );
            const info = (await res.json()) as {
                whisper?: { ready?: boolean; error?: string | null };
            };
            const w = info.whisper;
            if (w) {
                lines.push(
                    `Whisper backend: ${w.ready ? 'ready' : w.error ? `failed (${w.error})` : 'loading'}`
                );
            }
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            lines.push(`Whisper backend: unreachable (${detail})`);
        }
    }
    try {
        // Not in every engine (WebKit lacks the 'microphone' permission name).
        const p = await navigator.permissions.query({
            name: 'microphone' as PermissionName,
        });
        lines.push(`Mic permission: ${p.state}`);
    } catch {
        // Permissions API absent - the device list below still tells a lot
    }
    try {
        // Actively load the VAD (app-lifetime singleton, so usually already
        // warm): it IS the speech signal for the PCM engines, and a machine
        // where its ONNX session can't be created is simply deaf - this line
        // is the difference between one email round-trip and three.
        await withTimeout(
            (await import('./adapters/silero-vad.js')).loadSileroVad(),
            5000,
            'load timed out'
        );
        lines.push('VAD: ok');
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        lines.push(`VAD: failed (${detail})`);
    }
    try {
        const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
            (d) => d.kind === 'audioinput'
        );
        // Labels are blank without a mic-permission grant; names beat counts
        // when we have them ("AirPods" as the default explains a deaf desktop).
        const labels = inputs.map((d) => d.label).filter(Boolean).slice(0, 4);
        const picked = micDeviceId
            ? (inputs.find((d) => d.deviceId === micDeviceId)?.label ?? 'saved device not present')
            : 'system default';
        lines.push(
            `Mic inputs: ${inputs.length}${labels.length ? ` (${labels.join('; ')})` : ''}, using: ${picked}`
        );
    } catch {
        lines.push('Mic inputs: enumeration unavailable');
    }
    return lines;
}

async function diagnostics(extra: string[] = []): Promise<string> {
    return [
        `Version: ${__APP_VERSION__}`,
        `Platform: ${platformLabel()}`,
        `Mode: ${appMode()}`,
        ...extra,
        ...(await sttDiagnostics()),
        `Browser: ${navigator.userAgent}`,
    ].join('\n');
}

function mailtoHref(subject: string, body: string): string {
    return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** A `mailto:` link prefilled with the report template + diagnostics. */
export async function bugReportMailtoHref(): Promise<string> {
    const body =
        'What happened?\n\n\n' +
        'What did you expect instead?\n\n\n' +
        `. . .\n${await diagnostics()}`;
    return mailtoHref(`aloud bug report (v${__APP_VERSION__})`, body);
}

export interface AiReportContext {
    /** Human label for the active LLM source ("aloud cloud", "OpenAI (API Key)"). */
    sourceLabel: string;
    /** True when responses came from the user's own account or hardware (BYOK
     *  key, local Ollama, Claude subscription) rather than aloud cloud. */
    ownProvider: boolean;
}

/** A `mailto:` link for flagging an inappropriate facilitator response. */
export async function aiContentReportMailtoHref(ctx: AiReportContext): Promise<string> {
    const ownNote = ctx.ownProvider
        ? `Note: this session's responses came from your own AI source (${ctx.sourceLabel}), not aloud cloud. We can still review how aloud instructs the model.\n\n`
        : '';
    const body =
        'What did the facilitator say? (paste or describe the response)\n\n\n' +
        'Why was it inappropriate or concerning?\n\n\n' +
        ownNote +
        `. . .\n${await diagnostics([`AI source: ${ctx.sourceLabel}`])}`;
    return mailtoHref(`aloud AI content report (v${__APP_VERSION__})`, body);
}

/**
 * Desktop hands the `mailto:` to the opener plugin; web and native mobile let
 * the webview pass it to the OS composer, since `@capacitor/browser` can't open
 * `mailto:`.
 */
async function openMailto(href: string): Promise<void> {
    if (isTauri()) {
        await openExternal(href);
        return;
    }
    window.location.href = href;
}

export async function openBugReport(): Promise<void> {
    await openMailto(await bugReportMailtoHref());
}

export async function openAiContentReport(ctx: AiReportContext): Promise<void> {
    await openMailto(await aiContentReportMailtoHref(ctx));
}
