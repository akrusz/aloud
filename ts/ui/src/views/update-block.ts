/**
 * The whole page when this build is older than aloud cloud serves
 * (update-gate.ts): no nav, no views, no mic, and one button. On desktop it
 * installs the update the updater found and relaunches; on a phone it opens
 * the store listing. Laid out like the store-age screen (age-block.ts).
 */

import type { UpdateBlock } from '../client-version.js';
import { isCapacitor } from '../is-desktop.js';
import { openExternal } from '../external-links.js';
import { RELEASES_PAGE } from '../update-check.js';
import { t } from '../i18n.js';

/**
 * Where the button sends each phone. iOS is still TestFlight's public link:
 * once the App Store listing is live, this becomes its apps.apple.com URL
 * (TestFlight's page means nothing to someone who installed from the store).
 */
export const STORE_LISTING = {
    android: 'https://play.google.com/store/apps/details?id=app.aloud.meditation',
    ios: 'https://testflight.apple.com/join/qYwFhwt8',
} as const;

async function openStoreListing(url: string): Promise<void> {
    if (isCapacitor()) {
        // A top-level navigation off the app's origin is handed to the OS
        // (Capacitor's navigation handlers), which opens the Play Store or
        // TestFlight app. openExternal would show the page in an in-app
        // browser tab instead.
        window.location.href = url;
        return;
    }
    // A dev simulation, in a browser or the desktop app.
    if (!(await openExternal(url))) window.open(url, '_blank', 'noopener');
}

export function mountUpdateBlockView(root: HTMLElement, block: UpdateBlock): void {
    document.body.dataset['updateBlock'] = '';
    const section = document.createElement('section');
    section.className = 'update-block';
    const h1 = document.createElement('h1');
    h1.textContent = t('Time to update');
    const p = document.createElement('p');
    p.textContent = t("This version of aloud is old and needs an update - it'll just take a moment.");
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-primary';
    const status = document.createElement('p');
    status.className = 'update-block-status';
    status.setAttribute('aria-live', 'polite');

    if (block.platform === 'desktop') {
        const { update } = block;
        button.textContent = t('Update to {version}', { version: update.version });
        button.addEventListener('click', () => {
            button.disabled = true;
            status.textContent = t('Downloading…');
            void update
                .installAndRelaunch((fraction) => {
                    status.textContent =
                        fraction === null
                            ? t('Downloading…')
                            : t('Downloading… {percent}%', { percent: Math.round(fraction * 100) });
                })
                // On success the app relaunches, so this only runs on failure.
                // A .deb or .msi install can't update itself (desktop.md), so
                // the download page is the way out of this screen for it.
                .catch(() => {
                    button.disabled = false;
                    status.textContent = `${t('Update failed - try again')} `;
                    const link = document.createElement('a');
                    link.href = RELEASES_PAGE;
                    link.target = '_blank';
                    link.rel = 'noopener';
                    link.textContent = t('Get the latest release →');
                    status.append(link);
                });
        });
    } else {
        const url = STORE_LISTING[block.platform];
        button.textContent = t('Update');
        button.addEventListener('click', () => void openStoreListing(url));
    }

    section.append(h1, p, button, status);
    root.replaceChildren(section);
}
