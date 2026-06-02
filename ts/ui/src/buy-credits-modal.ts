/**
 * Buy-credits modal (meditation-pal-8sj / 44o) — lists the packs and either
 * starts a Stripe Checkout (card) or pays in USDC on Base via x402 (du9 Phase 2)
 * when one is picked. Reuses the `.voice-modal-*` classes for visual consistency
 * with the sign-in / voice modals, and floats above whatever view is mounted so
 * it can fire mid-session (out-of-credits) or from Settings.
 *
 * Card: picking a pack redirects the tab to Stripe (startCheckout), so the
 * success path doesn't resolve here — it's read from `?purchase=` on return
 * (cloud-billing.consumePurchaseReturn).
 *
 * USDC: the wallet signs and the server settles in-place (no redirect), so the
 * modal shows a success line, updates the live balance, and closes itself.
 */

import { fetchPacks, startCheckout, type CreditPack, type X402Capability } from './cloud-billing.js';
import { payWithUsdc, WalletError } from './x402-pay.js';
import { setKnownBalance } from './cloud-balance.js';
import { creditAmount } from './credit-rate.js';

const OVERLAY_ID = 'buy-credits-modal-overlay';

export interface BuyCreditsModalOptions {
    /** Headline. Defaults to a neutral buy prompt. */
    title?: string;
    /** Sub-line under the headline (e.g. an out-of-credits explanation). */
    subtitle?: string;
}

const DEFAULT_TITLE = 'Buy credits';
const DEFAULT_SUBTITLE = 'Credits pay for the aloud cloud: speech, the facilitator, and voice.';

function dollars(cents: number): string {
    return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

/**
 * Show the buy-credits modal. Resolves false when dismissed (close, overlay
 * click, Escape); a card pack navigates away to Stripe so the modal never
 * "succeeds" in place, while a USDC pack resolves true after settling.
 * A second call while one is open is a no-op (resolves false).
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
                <div class="buy-credits-target buy-credits-method hidden" id="buy-credits-method" role="tablist">
                    <button type="button" class="buy-credits-target-btn active" data-method="card" role="tab">Card</button>
                    <button type="button" class="buy-credits-target-btn" data-method="usdc" role="tab">USDC ⟠</button>
                </div>
                <div class="buy-credits-target" id="buy-credits-audience" role="tablist">
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
                <div class="provider-hint buy-credits-usdc-note hidden" id="buy-credits-usdc-note">
                    Pay in USDC on Base from a connected wallet. Credited to your account on settlement.
                </div>
                <div class="provider-hint buy-credits-success hidden" id="buy-credits-success"></div>
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
            el.classList.toggle('hidden', msg === '');
        };
        const showSuccess = (msg: string): void => {
            const el = overlay.querySelector<HTMLElement>('#buy-credits-success');
            if (!el) return;
            el.textContent = msg;
            el.classList.remove('hidden');
        };

        overlay.querySelector('#buy-credits-close')?.addEventListener('click', () => close(false));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close(false);
        });
        document.addEventListener('keydown', onKey);

        const methodRow = overlay.querySelector<HTMLElement>('#buy-credits-method')!;
        const audienceRow = overlay.querySelector<HTMLElement>('#buy-credits-audience')!;
        const usdcNote = overlay.querySelector<HTMLElement>('#buy-credits-usdc-note')!;
        const emailEl = overlay.querySelector<HTMLInputElement>('#buy-credits-gift-email')!;
        const noteEl = overlay.querySelector<HTMLElement>('#buy-credits-gift-note')!;

        let method: 'card' | 'usdc' = 'card';
        let gifting = false;

        // Card | USDC. USDC is self-only for now (the x402 route credits the
        // payer's account; no gift flow yet), so picking it hides the
        // audience tabs and forces "for myself".
        methodRow.querySelectorAll<HTMLButtonElement>('.buy-credits-target-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                method = btn.dataset['method'] === 'usdc' ? 'usdc' : 'card';
                methodRow
                    .querySelectorAll('.buy-credits-target-btn')
                    .forEach((b) => b.classList.toggle('active', b === btn));
                const usdc = method === 'usdc';
                if (usdc) {
                    gifting = false;
                    emailEl.classList.add('hidden');
                    noteEl.classList.add('hidden');
                    audienceRow.querySelectorAll('.buy-credits-target-btn').forEach((b, i) =>
                        b.classList.toggle('active', i === 0)
                    );
                }
                audienceRow.classList.toggle('hidden', usdc);
                usdcNote.classList.toggle('hidden', !usdc);
                showError('');
            });
        });

        // "For myself" vs "Gift to someone" — toggles the recipient email field.
        audienceRow.querySelectorAll<HTMLButtonElement>('.buy-credits-target-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                gifting = btn.dataset['target'] === 'gift';
                audienceRow
                    .querySelectorAll('.buy-credits-target-btn')
                    .forEach((b) => b.classList.toggle('active', b === btn));
                emailEl.classList.toggle('hidden', !gifting);
                noteEl.classList.toggle('hidden', !gifting);
                showError('');
            });
        });

        // Resolve the gift recipient at pack-click time (card only).
        const recipient = (): { email?: string; error?: string } => {
            if (!gifting) return {};
            const email = emailEl.value.trim();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return { error: "Enter the recipient's email to send a gift." };
            }
            return { email };
        };

        const setPacksDisabled = (disabled: boolean): void => {
            overlay.querySelectorAll<HTMLButtonElement>('.buy-credits-pack').forEach((b) => (b.disabled = disabled));
        };

        // What happens when a pack is picked, branching on the payment method.
        const buy = async (pack: CreditPack): Promise<void> => {
            showError('');
            if (method === 'usdc') {
                setPacksDisabled(true);
                try {
                    const { credits, creditsRemaining } = await payWithUsdc(pack.id);
                    setKnownBalance(creditsRemaining);
                    showSuccess(
                        `Added ${creditAmount(credits, 0)}, balance ${creditAmount(creditsRemaining, 0)}.`
                    );
                    setTimeout(() => close(true), 1600);
                } catch (err) {
                    setPacksDisabled(false);
                    showError(
                        err instanceof WalletError || err instanceof Error ? err.message : String(err)
                    );
                }
                return;
            }
            // Card → Stripe. Resolve the recipient, then redirect.
            const to = recipient();
            if (to.error) {
                showError(to.error);
                return;
            }
            setPacksDisabled(true);
            startCheckout(pack.id, to.email)
                .then((url) => window.location.assign(url))
                .catch((err: unknown) => {
                    setPacksDisabled(false);
                    showError(err instanceof Error ? err.message : String(err));
                });
        };

        const packsHost = overlay.querySelector<HTMLElement>('#buy-credits-packs')!;
        void fetchPacks()
            .then(({ packs, x402 }) => {
                applyChannels(methodRow, x402);
                renderPacks(packsHost, packs, buy);
            })
            .catch((err: unknown) => {
                packsHost.innerHTML = '';
                showError(err instanceof Error ? err.message : String(err));
            });
    });
}

/** Reveal the Card/USDC toggle only when the x402 channel is live. */
function applyChannels(methodRow: HTMLElement, x402: X402Capability): void {
    methodRow.classList.toggle('hidden', !x402.enabled);
}

function renderPacks(host: HTMLElement, packs: CreditPack[], onPick: (pack: CreditPack) => void): void {
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
        btn.addEventListener('click', () => onPick(pack));
        host.appendChild(btn);
    }
}

function escapeHtml(s: string): string {
    return s.replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
    );
}
