/**
 * About modal wiring: version line, crypto donation panel, and the desktop
 * update flow.
 *
 * The address button copies the raw 0x address, not the ENS name: krusz.eth
 * only resolves on Ethereum mainnet, so the name would fail in a Base wallet
 * while the bare address works on any chain the sender picks.
 *
 * In the Tauri shell, opening the box checks for a newer release and reveals an
 * Update button that installs and relaunches (desktop-updater.ts); a browser
 * has nothing to install, so it never appears. A background nudge
 * (runUpdateNudge) also flags the brand on boot and each nav, at most hourly.
 * `?previewUpdate` (or localStorage aloud:previewUpdate) forces the whole
 * "update available" flow without a real release - see previewUpdateVersion.
 */

import { isTauri, isCapacitor } from './is-desktop.js';
import { isWebMode } from './app-mode.js';
import { isDevMode, setDevMode, DEV_MODE_TAPS } from './dev-mode.js';
import { checkDesktopUpdate, type DesktopUpdate } from './desktop-updater.js';
import { checkForUpdate, RELEASES_PAGE } from './update-check.js';

// krusz.eth, resolved. The QR (ts/ui/public/krusz-eth-qr.svg) encodes this same
// bare address, so a scan and a copy land in the same place.
const DONATE_ADDRESS = '0x7895267268918407d14a7F37f2C4035BA985E2Ca';

export function initAbout(): void {
    const brand = document.getElementById('aboutLink');
    const modal = document.getElementById('aboutModal');
    const close = document.getElementById('aboutClose');
    const ethEl = document.querySelector<HTMLElement>('.about-eth');
    const crypto = document.getElementById('aboutCrypto');
    const addrBtn = document.getElementById('aboutCryptoAddr');
    if (!brand || !modal || !close) return;

    const versionEl = document.getElementById('aboutVersion');
    const syncVersionLine = (): void => {
        if (versionEl) {
            versionEl.textContent = `Version ${__APP_VERSION__}${isDevMode() ? ' · dev' : ''}`;
        }
    };
    syncVersionLine();
    // Hidden developer-mode toggle: tap the version line DEV_MODE_TAPS times.
    // Gates the Developer section in Settings (dev-mode.ts); undiscoverable for
    // someone who just installed the app.
    let devTaps = 0;
    versionEl?.addEventListener('click', () => {
        if (++devTaps < DEV_MODE_TAPS) return;
        devTaps = 0;
        setDevMode(!isDevMode());
        syncVersionLine();
    });
    const updateEl = document.getElementById('aboutUpdate');

    // CSS reveals the nav "Update" pill (and its More-sheet twin) when the brand
    // carries has-update; clicking opens the About box, where installing lives.
    const updateBtn = document.getElementById('updateBtn');
    updateBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openAbout();
    });

    // Hiding the modal also collapses the crypto panel, so it re-opens clean.
    const hide = () => {
        modal.classList.add('hidden');
        crypto?.classList.add('hidden');
    };

    brand.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const opened = modal.classList.toggle('hidden') === false;
        if (opened) runUpdateCheck(updateEl);
    });
    close.addEventListener('click', hide);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) hide();
    });

    if (ethEl && crypto) {
        ethEl.addEventListener('click', () => crypto.classList.toggle('hidden'));
    }

    if (addrBtn) {
        const label = addrBtn.textContent;
        addrBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(DONATE_ADDRESS).then(() => {
                addrBtn.textContent = 'copied!';
                setTimeout(() => {
                    addrBtn.textContent = label;
                }, 1500);
            });
        });
    }

    runUpdateNudge();
}

// At most one background update check per hour, across boot + every nav. The
// timestamp is persisted so reloads and SPA navigation share one budget (an SPA
// never reloads, so per-page-load throttling wouldn't fire). The brand's
// has-update class is the other guard: once flagged, stop checking.
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const LAST_CHECK_KEY = 'aloud:lastUpdateCheck';

function dueForCheck(): boolean {
    try {
        const last = Number(localStorage.getItem(LAST_CHECK_KEY));
        return !(last > 0) || Date.now() - last >= UPDATE_CHECK_INTERVAL_MS;
    } catch {
        return true;
    }
}

/**
 * Background update nudge, run on boot and each in-app nav (setActiveNav),
 * throttled to once an hour.
 *
 * On a desktop/local build (web auto-updates on reload), quietly look for a
 * newer release and flag the brand with `has-update`, which reveals the nav
 * "Update" pill and More-sheet entry via CSS. It pulses for 10s then settles to
 * `has-update-static`.
 *
 * Read-only and silent on failure, so a flaky network just means no nudge. The
 * About box re-checks on open for the details, so this only needs the yes/no.
 * `?previewUpdate` forces the flagged state regardless of platform or throttle.
 */
export function runUpdateNudge(): void {
    const brand = document.getElementById('aboutLink');
    if (!brand) return;
    // Native mobile (Capacitor) updates through the App Store / Play Store, so
    // it must NEVER flag an update, preview path included. Gated explicitly
    // rather than via isWebMode(): mobile is web mode only incidentally.
    if (isCapacitor()) return;
    // Already flagged, or forced via preview — nothing more to check.
    if (brand.classList.contains('has-update') || brand.classList.contains('has-update-static')) {
        return;
    }
    if (previewUpdateVersion()) {
        markUpdateAvailable(brand);
        return;
    }
    if (isWebMode() || !dueForCheck()) return;
    try {
        localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
    } catch {
        // Private mode / disabled storage: proceed unthrottled rather than skip.
    }
    // Both paths answer the same "is there a newer version?" question so a local
    // browser build and the desktop shell agree: Tauri's updater is
    // authoritative on desktop, GitHub releases otherwise. (Hosted web mode
    // already returned above; it auto-updates on reload.)
    const available = isTauri()
        ? checkDesktopUpdate().then(Boolean)
        : checkForUpdate().then((res) => res.state === 'available');
    void available.then((isAvailable) => {
        if (isAvailable) markUpdateAvailable(brand);
    });
}

// Flag the brand: pulse for 10s, then settle to the steady state. Idempotent,
// so an hourly re-check won't re-pulse.
function markUpdateAvailable(brand: HTMLElement): void {
    if (brand.classList.contains('has-update') || brand.classList.contains('has-update-static')) {
        return;
    }
    brand.classList.add('has-update');
    setTimeout(() => {
        brand.classList.remove('has-update');
        brand.classList.add('has-update-static');
    }, 10000);
}

/** Open the About modal and refresh its update status. Exported so Settings'
 *  "Check for updates" routes here: the About box is the one place that reports
 *  version + whether an update is waiting. */
export function openAbout(): void {
    const modal = document.getElementById('aboutModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    runUpdateCheck(document.getElementById('aboutUpdate'));
}

// Refresh the update line every time the box opens. Web mode auto-updates on
// reload (and hides the section), so only local/desktop builds check: Tauri
// drives the real self-updater, a local dev browser falls back to an
// informational GitHub-releases check.
let checking = false;
// Floor between About-box network checks: reopening within 2 min keeps the
// result already rendered into #aboutUpdate (it survives modal hide/show).
// In-memory on purpose - a reload clears that result, so re-checking is then
// correct. Distinct from the nudge's hourly, cross-reload budget.
const ABOUT_CHECK_INTERVAL_MS = 2 * 60 * 1000;
let lastAboutCheck = 0;
function runUpdateCheck(updateEl: HTMLElement | null): void {
    const preview = previewUpdateVersion();
    // Native mobile never shows the update line (store-updated), preview
    // included. Web mode hides it too, unless previewing.
    if (isCapacitor()) return;
    if (!updateEl || checking || (isWebMode() && !preview)) return;
    // Preview always re-renders; a real check is throttled to once / 2 min.
    if (!preview && lastAboutCheck && Date.now() - lastAboutCheck < ABOUT_CHECK_INTERVAL_MS) return;
    if (!preview) lastAboutCheck = Date.now();
    checking = true;
    updateEl.classList.remove('hidden');
    updateEl.textContent = 'Checking for updates…';
    const settle = (render: (el: HTMLElement) => void) => {
        updateEl.textContent = '';
        render(updateEl);
        checking = false;
    };
    if (preview) {
        // The "available" branch without a real release: a fake desktop update
        // (simulated download, no relaunch) in Tauri, the link otherwise.
        settle((el) =>
            isTauri() ? renderUpdateAvailable(el, fakeDesktopUpdate(preview)) : renderWebUpdate(el, preview)
        );
        return;
    }
    if (isTauri()) {
        void checkDesktopUpdate().then((update) =>
            settle((el) =>
                update
                    ? renderUpdateAvailable(el, update)
                    : (el.textContent = `You're on the latest version (${__APP_VERSION__}).`)
            )
        );
    } else {
        void checkForUpdate().then((res) =>
            settle((el) => {
                if (res.state === 'available' && res.latest) renderWebUpdate(el, res.latest);
                else if (res.state === 'current')
                    el.textContent = `You're on the latest version (${res.current}).`;
                else el.textContent = "Couldn't check for updates.";
            })
        );
    }
}

// Local dev browser: no installer to run, so link to the release. (The desktop
// shell shows an install button instead - renderUpdateAvailable.)
function renderWebUpdate(el: HTMLElement, latest: string): void {
    el.textContent = `Update available: ${latest}`;
    const link = document.createElement('a');
    link.href = RELEASES_PAGE;
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'about-update-link';
    link.textContent = 'Get the latest release →';
    el.appendChild(link);
}

function renderUpdateAvailable(el: HTMLElement, update: DesktopUpdate): void {
    el.textContent = '';
    el.classList.remove('hidden');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'about-update-btn';
    btn.textContent = `Update to ${update.version}`;

    const status = document.createElement('span');
    status.className = 'about-update-status';

    btn.addEventListener('click', () => {
        btn.disabled = true;
        status.textContent = ' Downloading…';
        void update
            .installAndRelaunch((fraction) => {
                status.textContent =
                    fraction === null
                        ? ' Downloading…'
                        : ` Downloading… ${Math.round(fraction * 100)}%`;
            })
            // On success the app relaunches, so this only runs on failure.
            .catch(() => {
                btn.disabled = false;
                status.textContent = ' Update failed - try again';
            });
    });

    el.append(btn, status);
}

/**
 * Dev preview switch for the "update available" flow. Returns the version to
 * pretend is available, or null when off. Set via `?previewUpdate` or the
 * `aloud:previewUpdate` localStorage key (handy inside the Tauri webview, where
 * editing the URL is awkward):
 *   - bare flag ("1" / "true" / empty) -> one patch above the running build
 *   - any other value -> used verbatim, e.g. ?previewUpdate=2.0.0
 * Clear by dropping the param or removing the localStorage key.
 */
export const PREVIEW_UPDATE_KEY = 'aloud:previewUpdate';

function previewUpdateVersion(): string | null {
    let raw: string | null = null;
    try {
        const fromUrl = new URLSearchParams(location.search).get('previewUpdate');
        if (fromUrl !== null) {
            // Persist so preview survives the router normalizing the query
            // string away: the nudge fires on boot, but the About box opens
            // later, after the param is gone.
            localStorage.setItem(PREVIEW_UPDATE_KEY, fromUrl);
            raw = fromUrl;
        } else {
            raw = localStorage.getItem(PREVIEW_UPDATE_KEY);
        }
    } catch {
        return null;
    }
    if (raw === null) return null;
    return raw && raw !== '1' && raw !== 'true' ? raw : bumpPatch(__APP_VERSION__);
}

/** "1.0.8" → "1.0.9". Falls back to a clearly-fake version if unparseable. */
function bumpPatch(version: string): string {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!m) return '9.9.9';
    return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** Stand-in for a real Tauri update in preview: animates a ~2s download, then
 *  resolves without relaunching, so the button + progress UI can be seen. */
function fakeDesktopUpdate(version: string): DesktopUpdate {
    return {
        version,
        notes: 'Preview - no real update will be installed.',
        installAndRelaunch: async (onProgress) => {
            for (let i = 0; i <= 10; i++) {
                onProgress?.(i / 10);
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
        },
    };
}
