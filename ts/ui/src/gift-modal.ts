/**
 * Gift-accept modal (meditation-pal-bd5). On sign-in, prompt to accept or
 * decline each cloud gifted to this account's email. Decline bounces them back
 * to the buyer, who can re-gift or claim from their Account page; no refund is
 * involved, the payment already cleared. Reuses the `.voice-modal-*` chrome.
 */

import { fetchGifts, acceptGift, declineGift, type GiftView } from './cloud-billing.js';
import { fetchMe } from './cloud-auth.js';
import { creditAmount, withCloudOutline } from './credit-rate.js';
import { manageModalFocus } from './modal-focus.js';
import { showSuccessToast, showErrorToast } from './toast.js';
import { t } from './i18n.js';

const OVERLAY_ID = 'gift-modal-overlay';

/** Safe to call when signed out or offline; it no-ops. */
export async function checkAndShowGifts(): Promise<void> {
    const gifts = await fetchGifts();
    if (gifts.length > 0) showGiftModal(gifts);
}

function showGiftModal(gifts: GiftView[]): void {
    if (document.getElementById(OVERLAY_ID)) return;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'voice-modal-overlay';
    overlay.innerHTML = `
        <div class="voice-modal gift-modal" role="dialog" aria-modal="true" aria-label="${t('Gifted clouds')}">
            <div class="voice-modal-header">
                <span class="voice-modal-title">${withCloudOutline(t("You've been gifted clouds ☁️!"))}</span>
                <button type="button" class="voice-modal-close" id="gift-modal-close" aria-label="${t('Close')}">&times;</button>
            </div>
            <p class="provider-hint gift-modal-subtitle">${t('Accept to add them to your balance, or decline to send them back to the sender.')}</p>
            <div class="gift-list" id="gift-list"></div>
        </div>`;
    document.body.appendChild(overlay);
    // Assigned once the rows exist (below), so initial focus lands on the first
    // Accept button rather than the close button.
    let releaseFocus: (() => void) | null = null;

    const close = (): void => {
        document.removeEventListener('keydown', onKey);
        releaseFocus?.();
        overlay.remove();
    };
    const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') close();
    };
    overlay.querySelector('#gift-modal-close')?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onKey);

    const list = overlay.querySelector<HTMLElement>('#gift-list')!;
    let remaining = gifts.length;

    for (const gift of gifts) {
        const row = document.createElement('div');
        row.className = 'gift-row';
        const from = gift.fromEmail ? ` ${t('from {email}', { email: escapeHtml(gift.fromEmail) })}` : '';
        row.innerHTML = `
            <div class="gift-row-info">
                <span class="gift-row-amount">${withCloudOutline(creditAmount(gift.credits, 0))}</span>
                <span class="provider-hint gift-row-from">${from}</span>
            </div>
            <div class="gift-row-actions">
                <button type="button" class="btn btn-primary gift-accept">${t('Accept')}</button>
                <button type="button" class="btn btn-secondary gift-decline">${t('Decline')}</button>
            </div>`;

        const resolve = (action: (id: string) => Promise<void>, onDone: () => void): void => {
            row.querySelectorAll('button').forEach((b) => (b.disabled = true));
            action(gift.id)
                .then(() => {
                    onDone();
                    row.remove();
                    if (--remaining === 0) close();
                })
                .catch((err: unknown) => {
                    row.querySelectorAll('button').forEach((b) => (b.disabled = false));
                    showErrorToast(err instanceof Error ? err.message : String(err));
                });
        };

        row.querySelector('.gift-accept')?.addEventListener('click', () =>
            resolve(acceptGift, () => {
                showSuccessToast(t('{amount} added to your balance.', { amount: creditAmount(gift.credits, 0) }));
                // The accept endpoint returns no balance, so refresh from /me to
                // get the gift into live readouts.
                void fetchMe().catch(() => null);
            })
        );
        row.querySelector('.gift-decline')?.addEventListener('click', () =>
            resolve(declineGift, () => {
                /* sent back to the sender; no toast needed */
            })
        );
        list.appendChild(row);
    }

    releaseFocus = manageModalFocus(overlay);
}

function escapeHtml(s: string): string {
    return s.replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
    );
}
