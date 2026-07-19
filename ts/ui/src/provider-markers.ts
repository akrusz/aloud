/**
 * Provider availability markers shared by the setup picker (`views/setup.ts`)
 * and the settings default-provider picker (`views/settings.ts`).
 *
 * Data comes from `GET /app/v1/providers` (Rust on desktop, Hono on web), a
 * `{ <provider>: { available, installed?, hint? } }` map, plus the local BYOK
 * key store. Options are annotated:
 *   - `✱` installed but not running (e.g. Ollama stopped), still selectable;
 *   - `✘` not configured (API provider with no key, or not installed).
 * Unknown status (the probe failed) reads as available, so missing information
 * never blocks the UI.
 */
import { capabilitiesSync } from './capabilities.js';
import { providerNeedsKey, type Provider } from './settings.js';

export interface ProviderInfo {
    available: boolean;
    installed?: boolean;
    hint?: string;
}

export type ProviderStatusMap = Record<string, ProviderInfo>;

export interface ProviderMarker {
    /** Text appended to the option label: '', ' ✘', or ' ✱'. */
    suffix: '' | ' ✘' | ' ✱';
    /** The provider can't run as configured (key missing / not installed). */
    unavailable: boolean;
}

/** Strip a trailing ✘/✱ marker so labels can be re-annotated idempotently. */
export function stripMarker(label: string): string {
    return label.replace(/ [✘✱]$/, '');
}

export function computeProviderMarker(
    provider: string,
    status: ProviderStatusMap | null,
    keyPresent: Record<string, boolean>
): ProviderMarker {
    let info = status?.[provider];
    // Trust the direct /ollama probe over the app backend: browser dev previews
    // talk to Hono, which hardcodes ollama-unavailable, but a daemon reached via
    // the /ollama proxy is genuinely usable.
    if (provider === 'ollama' && capabilitiesSync().ollama) info = { available: true };

    const needsKeyMissing =
        providerNeedsKey(provider as Provider) && keyPresent[provider] === false;
    if (needsKeyMissing) return { suffix: ' ✘', unavailable: true };
    if (info && !info.available) {
        return info.installed
            ? { suffix: ' ✱', unavailable: false }
            : { suffix: ' ✘', unavailable: true };
    }
    return { suffix: '', unavailable: false };
}
