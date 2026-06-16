/**
 * About modal wiring.
 *
 * Brand link toggles open/close, × closes, click outside closes. The
 * krusz.eth span reveals a small crypto panel (QR + copyable address +
 * accepted chains); the address button copies the full 0x address. We copy
 * the raw address rather than the ENS name on purpose — krusz.eth only
 * resolves on Ethereum mainnet, so the name would fail in a Base wallet,
 * whereas the bare address works on any chain the sender picks.
 *
 * The version line and (desktop only) the one-click "Update" button live here,
 * mirroring the old app's About box: on first open in the Tauri shell we
 * check for a newer release and, if there is one, reveal an Update button that
 * downloads + installs it and relaunches (see desktop-updater.ts). In a browser
 * there's nothing to install, so the button never appears.
 *
 * Update checks also run a background nudge (runUpdateNudge) on boot and on each
 * in-app nav, throttled to at most once an hour, that flags the brand when a
 * release is waiting. Set `?previewUpdate` (or localStorage aloud:previewUpdate)
 * to force the whole "update available" flow without a real release — see
 * previewUpdateVersion.
 */

import { isTauri } from './is-desktop.js';
import { isWebMode } from './app-mode.js';
import { checkDesktopUpdate, type DesktopUpdate } from './desktop-updater.js';
import { checkForUpdate, RELEASES_PAGE } from './update-check.js';

// krusz.eth, resolved. The QR (ts/ui/public/krusz-eth-qr.svg) encodes this
// same bare address, so a scan and a copy land in the same place.
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
    if (versionEl) versionEl.textContent = `Version ${__APP_VERSION__}`;
    const updateEl = document.getElementById('aboutUpdate');

    // The nav "Update" pill and its mobile More-sheet twin are revealed by CSS
    // when the brand carries has-update (see runUpdateNudge); clicking either
    // just opens the About box, where the install button lives.
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
// timestamp is persisted so reloads and SPA navigation share one budget — the
// old app checked once per page load; an SPA never reloads, so we throttle by
// wall-clock instead. The brand's has-update class is the other guard: once a
// release is flagged we stop checking entirely (nothing left to discover).
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
 * Background update nudge — mirrors the old app's page-load check, run on
 * boot and on each in-app nav (setActiveNav), throttled to once an hour.
 *
 * On a desktop/local build (web auto-updates on reload), quietly look for a
 * newer release. If one's waiting, flag the brand with `has-update`, which
 * reveals the nav "Update" pill and the mobile More-sheet entry via CSS
 * (:has(.nav-brand.has-update) .update-btn). It pulses for 10s, then settles to
 * the steady `has-update-static` state — same timing as the old app. Clicking
 * either opens the About box, where the actual download/install button lives.
 *
 * The check is read-only and silent on failure, so a flaky network just means no
 * nudge. The About box re-checks on open to render the details, so this only
 * needs the yes/no. `?previewUpdate` forces the flagged state regardless of
 * platform or throttle so the flow can be eyeballed without a real release.
 */
export function runUpdateNudge(): void {
    const brand = document.getElementById('aboutLink');
    if (!brand) return;
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
    const available = isTauri()
        ? checkDesktopUpdate().then(Boolean)
        : checkForUpdate().then((res) => res.state === 'available');
    void available.then((isAvailable) => {
        if (isAvailable) markUpdateAvailable(brand);
    });
}

// Flag the brand: pulse for 10s, then settle to the steady state. Idempotent —
// an hourly re-check won't re-pulse — so it's safe to call from the nudge and
// from the preview path alike.
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

/** Open the About modal and refresh its update status. Exported so the Settings
 *  "Check for updates" button routes here — the About box is the single place
 *  that reports version + whether an update is waiting. */
export function openAbout(): void {
    const modal = document.getElementById('aboutModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    runUpdateCheck(document.getElementById('aboutUpdate'));
}

// Refresh the update line every time the box opens. Web mode auto-updates on
// reload (and the section is hidden there), so we only check in local/desktop
// builds: the Tauri shell drives the real self-updater; a local dev browser
// falls back to an informational GitHub-releases check.
let checking = false;
// Floor between About-box network checks: reopening within 2 min just keeps the
// result already rendered into #aboutUpdate (it survives the modal hide/show).
// In-memory on purpose — a reload clears the rendered result, so re-checking
// then is correct. Distinct from the nudge's hourly, cross-reload budget.
const ABOUT_CHECK_INTERVAL_MS = 2 * 60 * 1000;
let lastAboutCheck = 0;
function runUpdateCheck(updateEl: HTMLElement | null): void {
    const preview = previewUpdateVersion();
    // Web mode hides the section (auto-updates on reload) — unless previewing,
    // where the point is to see the flow regardless of platform.
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
        // Render the "available" branch for the current platform without a real
        // release: a fake desktop update (simulated download, no relaunch) in the
        // Tauri shell, the informational link otherwise.
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

// Local dev browser: there's no installer to run, so link to the release. (The
// real desktop shell shows an install button instead — renderUpdateAvailable.)
function renderWebUpdate(el: HTMLElement, latest: string): void {
    el.textContent = `Update available: ${latest}`;
    const link = document.createElement('a');
    link.href = RELEASES_PAGE;
    link.target = '_blank';
    link.rel = 'noopener';
    // Block-level so it sits on its own line under the version.
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
 * Dev preview switch for the "update available" flow.
 *
 * Returns the version to pretend is available, or null when off. Enabled by
 * `?previewUpdate` in the URL or an `aloud:previewUpdate` localStorage key
 * (handy inside the Tauri webview, where editing the URL is awkward):
 *   - bare flag ("1" / "true" / empty) → one patch above the running build
 *   - any other value → used verbatim as the version, e.g. ?previewUpdate=2.0.0
 * When set, the brand flags itself on boot/nav and the About box renders the
 * available UI (a simulated, non-installing download on desktop) — no real
 * release required. To clear: drop the query param, or
 * `localStorage.removeItem('aloud:previewUpdate')`.
 */
function previewUpdateVersion(): string | null {
    let raw: string | null = null;
    try {
        const fromUrl = new URLSearchParams(location.search).get('previewUpdate');
        if (fromUrl !== null) {
            // Persist so preview survives the router normalizing the query
            // string away (same reason ?mode= is stored) — the nudge fires on
            // boot but the About box opens later, after the param is gone.
            localStorage.setItem('aloud:previewUpdate', fromUrl);
            raw = fromUrl;
        } else {
            raw = localStorage.getItem('aloud:previewUpdate');
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

/** Stand-in for a real Tauri update in preview: animates a ~2s download to 100%,
 *  then resolves without relaunching, so the desktop button + progress UI can be
 *  seen end-to-end. */
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
