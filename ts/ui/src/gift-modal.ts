/**
 * Gift-clouds modal (meditation-pal-bd5). On sign-in we surface two things:
 *  - clouds gifted TO this account's email — accept (add here) or decline (send
 *    back to the buyer); and
 *  - clouds the buyer sent that BOUNCED back (declined or 30-day unclaimed) — now
 *    held as "returned" for them to re-gift to someone else, or claim to their
 *    own balance. No refunds — value always stays in credits. Reuses the
 *    `.voice-modal-*` chrome.
 */

import {
    fetchGifts,
    acceptGift,
    declineGift,
    fetchReturnedGifts,
    regiftReturned,
    claimReturnedGift,
    type GiftView,
    type ReturnedGiftView,
} from './cloud-billing.js';
import { creditAmount } from './credit-rate.js';
import { showSuccessToast, showErrorToast } from './toast.js';

const OVERLAY_ID = 'gift-modal-overlay';

/** Fetch the signed-in account's incoming gifts AND its bounced-back gifts and,
 *  if any, show the prompt. Safe to call when signed out / offline — it no-ops. */
export async function checkAndShowGifts(): Promise<void> {
    const [incoming, returned] = await Promise.all([fetchGifts(), fetchReturnedGifts()]);
    if (incoming.length > 0 || returned.length > 0) showGiftModal(incoming, returned);
}

function showGiftModal(incoming: GiftView[], returned: ReturnedGiftView[]): void {
    if (document.getElementById(OVERLAY_ID)) return;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'voice-modal-overlay';
    overlay.innerHTML = `
        <div class="voice-modal gift-modal" role="dialog" aria-modal="true" aria-label="Gifted clouds">
            <div class="voice-modal-header">
                <span class="voice-modal-title">Gifted clouds ☁️</span>
                <button type="button" class="voice-modal-close" id="gift-modal-close" aria-label="Close">&times;</button>
            </div>
            ${
                incoming.length
                    ? `<p class="provider-hint gift-modal-subtitle">Gifts for you — accept to add them to your balance, or decline to send them back.</p>
                       <div class="gift-list" id="gift-list-incoming"></div>`
                    : ''
            }
            ${
                returned.length
                    ? `<p class="provider-hint gift-modal-subtitle">${
                          incoming.length ? 'Also, a gift you sent came back' : 'A gift you sent came back'
                      } — re-gift it to someone else, or claim it to your own balance.</p>
                       <div class="gift-list" id="gift-list-returned"></div>`
                    : ''
            }
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

    let remaining = incoming.length + returned.length;
    const resolved = (row: HTMLElement): void => {
        row.remove();
        if (--remaining <= 0) close();
    };

    // ---- Incoming gifts (accept / decline) -------------------------------
    const incomingList = overlay.querySelector<HTMLElement>('#gift-list-incoming');
    for (const gift of incoming) {
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

        const run = (action: (id: string) => Promise<void>, onDone: () => void): void => {
            row.querySelectorAll('button').forEach((b) => (b.disabled = true));
            action(gift.id)
                .then(() => {
                    onDone();
                    resolved(row);
                })
                .catch((err: unknown) => {
                    row.querySelectorAll('button').forEach((b) => (b.disabled = false));
                    showErrorToast(err instanceof Error ? err.message : String(err));
                });
        };

        row.querySelector('.gift-accept')?.addEventListener('click', () =>
            run(acceptGift, () => showSuccessToast(`${creditAmount(gift.credits, 0)} added to your balance.`))
        );
        row.querySelector('.gift-decline')?.addEventListener('click', () =>
            run(declineGift, () => {
                /* sent back to the buyer — no toast needed */
            })
        );
        incomingList?.appendChild(row);
    }

    // ---- Returned gifts (re-gift / claim) --------------------------------
    const returnedList = overlay.querySelector<HTMLElement>('#gift-list-returned');
    for (const gift of returned) {
        const row = document.createElement('div');
        row.className = 'gift-row gift-row-returned';
        row.innerHTML = `
            <div class="gift-row-info">
                <span class="gift-row-amount">${creditAmount(gift.credits, 0)}</span>
                <span class="provider-hint gift-row-from"> · was for ${escapeHtml(gift.toEmail)}</span>
            </div>
            <div class="gift-row-actions">
                <input type="email" class="gift-regift-email" placeholder="re-gift to email…"
                    aria-label="Re-gift to email" autocomplete="off" autocapitalize="off" spellcheck="false">
                <button type="button" class="btn btn-primary gift-regift">Re-gift</button>
                <button type="button" class="btn btn-secondary gift-claim">Claim</button>
            </div>`;

        const emailInput = row.querySelector<HTMLInputElement>('.gift-regift-email')!;
        const setBusy = (busy: boolean): void => {
            row.querySelectorAll('button').forEach((b) => (b.disabled = busy));
            emailInput.disabled = busy;
        };
        const run = (action: () => Promise<void>, onDone: () => void): void => {
            setBusy(true);
            action()
                .then(() => {
                    onDone();
                    resolved(row);
                })
                .catch((err: unknown) => {
                    setBusy(false);
                    showErrorToast(err instanceof Error ? err.message : String(err));
                });
        };

        row.querySelector('.gift-regift')?.addEventListener('click', () => {
            const email = emailInput.value.trim();
            if (!email) {
                showErrorToast('Enter an email to re-gift to.');
                emailInput.focus();
                return;
            }
            run(
                () => regiftReturned(gift.id, email),
                () => showSuccessToast(`Re-gifted ${creditAmount(gift.credits, 0)} to ${email}.`)
            );
        });
        row.querySelector('.gift-claim')?.addEventListener('click', () =>
            run(
                () => claimReturnedGift(gift.id),
                () => showSuccessToast(`${creditAmount(gift.credits, 0)} added to your balance.`)
            )
        );
        returnedList?.appendChild(row);
    }
}

function escapeHtml(s: string): string {
    return s.replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
    );
}
