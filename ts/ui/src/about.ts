/**
 * About modal wiring — lifted from src/web/static/js/chrome.js.
 *
 * Brand link toggles open/close, × closes, click outside closes. The
 * krusz.eth span reveals a small crypto panel (QR + copyable address +
 * accepted chains); the address button copies the full 0x address. We copy
 * the raw address rather than the ENS name on purpose — krusz.eth only
 * resolves on Ethereum mainnet, so the name would fail in a Base wallet,
 * whereas the bare address works on any chain the sender picks.
 *
 * The version line and (desktop only) the one-click "Update" button live here,
 * mirroring the old Python app's About box: on first open in the Tauri shell we
 * check for a newer release and, if there is one, reveal an Update button that
 * downloads + installs it and relaunches (see desktop-updater.ts). In a browser
 * there's nothing to install, so the button never appears.
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
function runUpdateCheck(updateEl: HTMLElement | null): void {
    if (!updateEl || checking || isWebMode()) return;
    checking = true;
    updateEl.classList.remove('hidden');
    updateEl.textContent = 'Checking for updates…';
    const settle = (render: (el: HTMLElement) => void) => {
        updateEl.textContent = '';
        render(updateEl);
        checking = false;
    };
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

// Local dev browser: there's no installer to run, so link to the release.
function renderWebUpdate(el: HTMLElement, latest: string): void {
    el.textContent = `Update available: ${latest} `;
    const link = document.createElement('a');
    link.href = RELEASES_PAGE;
    link.target = '_blank';
    link.rel = 'noopener';
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
