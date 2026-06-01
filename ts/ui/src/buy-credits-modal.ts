/**
 * Buy-credits modal (meditation-pal-8sj / 44o) — lists the packs and starts a
 * Stripe Checkout when one is picked. Reuses the `.voice-modal-*` classes for
 * visual consistency with the sign-in / voice modals, and floats above whatever
 * view is mounted so it can fire mid-session (out-of-credits) or from Settings.
 *
 * Picking a pack redirects the tab to Stripe (startCheckout), so the success
 * path doesn't resolve here — the promise resolves false on dismiss, and the
 * outcome is read from `?purchase=` on return (cloud-billing.consumePurchaseReturn).
 */

import { fetchPacks, startCheckout, type CreditPack } from './cloud-billing.js';
import { creditAmount } from './credit-rate.js';

const OVERLAY_ID = 'buy-credits-modal-overlay';

export interface BuyCreditsModalOptions {
    /** Headline. Defaults to a neutral buy prompt. */
    title?: string;
    /** Sub-line under the headline (e.g. an out-of-credits explanation). */
    subtitle?: string;
}

const DEFAULT_TITLE = 'Buy credits';
const DEFAULT_SUBTITLE = 'Credits pay for the aloud cloud — speech, the facilitator, and voice.';

function dollars(cents: number): string {
    return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

/**
 * Show the buy-credits modal. Resolves false when dismissed (close, overlay
 * click, Escape); picking a pack navigates away to Stripe so the modal never
 * "succeeds" in place. A second call while one is open is a no-op (resolves false).
 */
export function showBuyCreditsModal(options: BuyCreditsModalOptions = {}): Promise<boolean> {
    if (document.getElementById(OVERLAY_ID)) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.className = 'voice-modal-overlay';
        overlay.innerHTML = `
            <div class="voice-modal buy-credits-modal" role="dialog" aria-modal="true" aria-label="Buy credits">
                <div class="voice-modal-header">
                    <span class="voice-modal-title">${escapeHtml(options.title ?? DEFAULT_TITLE)}</span>
                    <button type="button" class="voice-modal-close" id="buy-credits-close" aria-label="Close">&times;</button>
                </div>
                <p class="provider-hint buy-credits-subtitle">${escapeHtml(options.subtitle ?? DEFAULT_SUBTITLE)}</p>
                <div class="buy-credits-target" role="tablist">
                    <button type="button" class="buy-credits-target-btn active" data-target="self" role="tab">For myself</button>
                    <button type="button" class="buy-credits-target-btn" data-target="gift" role="tab">Gift to someone</button>
                </div>
                <input type="email" id="buy-credits-gift-email" class="signin-input buy-credits-gift-email hidden"
                    placeholder="Recipient's email" autocomplete="off" />
                <p class="provider-hint buy-credits-gift-note hidden" id="buy-credits-gift-note">
                    They'll be asked to accept the gift next time they sign in. If they decline or don't within 60 days, the clouds return to you.
                </p>
                <div class="buy-credits-packs" id="buy-credits-packs">
                    <p class="provider-hint">Loading…</p>
                </div>
                <div class="provider-hint buy-credits-error hidden" id="buy-credits-error"></div>
            </div>`;
        document.body.appendChild(overlay);

        let settled = false;
        const close = (result: boolean): void => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            resolve(result);
        };
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') close(false);
        };
        const showError = (msg: string): void => {
            const el = overlay.querySelector<HTMLElement>('#buy-credits-error');
            if (!el) return;
            el.textContent = msg;
            el.classList.toggle('hidden', msg === ''); // empty → clear/hide
        };

        overlay.querySelector('#buy-credits-close')?.addEventListener('click', () => close(false));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close(false);
        });
        document.addEventListener('keydown', onKey);

        // "For myself" vs "Gift to someone" — toggles the recipient email field.
        const emailEl = overlay.querySelector<HTMLInputElement>('#buy-credits-gift-email')!;
        const noteEl = overlay.querySelector<HTMLElement>('#buy-credits-gift-note')!;
        let gifting = false;
        overlay.querySelectorAll<HTMLButtonElement>('.buy-credits-target-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                gifting = btn.dataset['target'] === 'gift';
                overlay
                    .querySelectorAll('.buy-credits-target-btn')
                    .forEach((b) => b.classList.toggle('active', b === btn));
                emailEl.classList.toggle('hidden', !gifting);
                noteEl.classList.toggle('hidden', !gifting);
                showError('');
            });
        });

        // Resolve the recipient at pack-click time: undefined for self, the typed
        // email for a gift, or an error string if a gift email is missing/invalid.
        const recipient = (): { email?: string; error?: string } => {
            if (!gifting) return {};
            const email = emailEl.value.trim();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return { error: "Enter the recipient's email to send a gift." };
            }
            return { email };
        };

        const packsHost = overlay.querySelector<HTMLElement>('#buy-credits-packs')!;
        void fetchPacks()
            .then((packs) => renderPacks(packsHost, packs, showError, recipient))
            .catch((err: unknown) => {
                packsHost.innerHTML = '';
                showError(err instanceof Error ? err.message : String(err));
            });
    });
}

function renderPacks(
    host: HTMLElement,
    packs: CreditPack[],
    showError: (msg: string) => void,
    recipient: () => { email?: string; error?: string }
): void {
    if (packs.length === 0) {
        host.innerHTML = '<p class="provider-hint">No credit packs are available right now.</p>';
        return;
    }
    host.innerHTML = '';
    for (const pack of packs) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-secondary buy-credits-pack';
        btn.innerHTML = `<span class="buy-credits-pack-credits">${creditAmount(pack.credits, 0)}</span>
            <span class="buy-credits-pack-price">${dollars(pack.priceUsdCents)}</span>`;
        btn.addEventListener('click', () => {
            const to = recipient();
            if (to.error) {
                showError(to.error);
                return;
            }
            // Disable the whole list while we redirect, so a double-click can't
            // open two checkout sessions.
            host.querySelectorAll('button').forEach((b) => (b.disabled = true));
            startCheckout(pack.id, to.email)
                .then((url) => window.location.assign(url))
                .catch((err: unknown) => {
                    host.querySelectorAll('button').forEach((b) => (b.disabled = false));
                    showError(err instanceof Error ? err.message : String(err));
                });
        });
        host.appendChild(btn);
    }
}

function escapeHtml(s: string): string {
    return s.replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
    );
}
