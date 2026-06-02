/**
 * Gift-accept modal (meditation-pal-bd5). On sign-in we check for clouds gifted
 * to this account's email and, if any, prompt to accept or decline each. Accept
 * adds the clouds here; decline bounces them back to the buyer (who can re-gift
 * or claim them from their Account page — no refund, no risk, the payment already
 * cleared). Reuses the `.voice-modal-*` chrome.
 */

import { fetchGifts, acceptGift, declineGift, type GiftView } from './cloud-billing.js';
import { creditAmount } from './credit-rate.js';
import { showSuccessToast, showErrorToast } from './toast.js';

const OVERLAY_ID = 'gift-modal-overlay';

/** Fetch pending gifts for the signed-in account and, if any, show the prompt.
 *  Safe to call when signed out / offline — it just no-ops. */
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
        <div class="voice-modal gift-modal" role="dialog" aria-modal="true" aria-label="Gifted clouds">
            <div class="voice-modal-header">
                <span class="voice-modal-title">You've been gifted clouds ☁️</span>
                <button type="button" class="voice-modal-close" id="gift-modal-close" aria-label="Close">&times;</button>
            </div>
            <p class="provider-hint gift-modal-subtitle">Accept to add them to your balance, or decline to send them back to the sender.</p>
            <div class="gift-list" id="gift-list"></div>
        </div>`;
    document.body.appendChild(overlay);

    const close = (): void => {
        document.removeEventListener('keydown', onKey);
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
        const from = gift.fromEmail ? ` from ${escapeHtml(gift.fromEmail)}` : '';
        row.innerHTML = `
            <div class="gift-row-info">
                <span class="gift-row-amount">${creditAmount(gift.credits, 0)}</span>
                <span class="provider-hint gift-row-from">${from}</span>
            </div>
            <div class="gift-row-actions">
                <button type="button" class="btn btn-primary gift-accept">Accept</button>
                <button type="button" class="btn btn-secondary gift-decline">Decline</button>
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
            resolve(acceptGift, () => showSuccessToast(`${creditAmount(gift.credits, 0)} added to your balance.`))
        );
        row.querySelector('.gift-decline')?.addEventListener('click', () =>
            resolve(declineGift, () => {
                /* sent back to the sender — no toast needed */
            })
        );
        list.appendChild(row);
    }
}

function escapeHtml(s: string): string {
    return s.replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
    );
}
