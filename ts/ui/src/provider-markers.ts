/**
 * Provider availability markers shared by the setup picker (`views/setup.ts`)
 * and the settings default-provider picker (`views/settings.ts`).
 *
 * The data comes from `GET /app/v1/providers` (Rust on desktop, Hono on web) —
 * a `{ <provider>: { available, installed?, hint? } }` map — plus the local
 * BYOK key store. A provider option is annotated with:
 *   - `✱` installed but not running (e.g. Ollama stopped) — still selectable;
 *   - `✘` not configured at all (an API provider with no key, or not installed).
 * An unknown status (the /providers probe failed) is treated as available so we
 * never block the UI on missing information. Mirrors the old Python
 * `settings.js`/`setup.js` `applyProviderAvailability`.
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
    /** True when the provider can't run as configured (key missing / not installed). */
    unavailable: boolean;
}

/** Strip a trailing ✘/✱ marker so labels can be re-annotated idempotently. */
export function stripMarker(label: string): string {
    return label.replace(/ [✘✱]$/, '');
}

/**
 * Compute the availability marker for one provider option from the /providers
 * status map and the BYOK key-presence map.
 */
export function computeProviderMarker(
    provider: string,
    status: ProviderStatusMap | null,
    keyPresent: Record<string, boolean>
): ProviderMarker {
    let info = status?.[provider];
    // Ollama: trust the direct /ollama probe (capabilities) over the app
    // backend's report. A browser dev preview talks to Hono, which hardcodes
    // ollama-unavailable; a local daemon reached via the /ollama proxy is
    // genuinely usable, so don't ✘ a running Ollama.
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
