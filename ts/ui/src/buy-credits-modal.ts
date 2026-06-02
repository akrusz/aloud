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
import { getKnownBalance, setKnownBalance, subscribeBalance } from './cloud-balance.js';
import { fetchMe } from './cloud-auth.js';
import { creditAmount } from './credit-rate.js';

const OVERLAY_ID = 'buy-credits-modal-overlay';

export interface BuyCreditsModalOptions {
    /** Headline. Defaults to a neutral buy prompt. */
    title?: string;
    /** Sub-line under the headline (e.g. an out-of-credits explanation). */
    subtitle?: string;
}

const DEFAULT_TITLE = 'Buy ☁️';
const DEFAULT_SUBTITLE = 'aloud cloud uses ☁️ to power high-quality speech, voice recognition, and facilitation AI.';

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
                <p class="buy-credits-balance hidden" id="buy-credits-balance"></p>
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
                <div class="buy-credits-custom hidden" id="buy-credits-custom"></div>
                <div class="provider-hint buy-credits-usdc-note hidden" id="buy-credits-usdc-note">
                    Pay in USDC on Base from a connected wallet. Credited to your account on settlement.
                </div>
                <div class="provider-hint buy-credits-success hidden" id="buy-credits-success"></div>
                <div class="provider-hint buy-credits-error hidden" id="buy-credits-error"></div>
            </div>`;
        document.body.appendChild(overlay);

        let settled = false;
        let unsubscribeBalance: (() => void) | null = null;
        const close = (result: boolean): void => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey);
            unsubscribeBalance?.();
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

        // Live balance readout under the subtitle. Show the last-known value
        // instantly, then reconcile with /me. Subscribing keeps it current when
        // a USDC top-up settles in-place (buy() calls setKnownBalance), and
        // fetchMe also feeds the shared balance, so the subscription handles the
        // reconcile too. A null (signed out / unknown) balance leaves it hidden.
        const balanceEl = overlay.querySelector<HTMLElement>('#buy-credits-balance')!;
        const renderBalance = (bal: number | null): void => {
            if (bal == null) {
                balanceEl.classList.add('hidden');
                return;
            }
            balanceEl.textContent = `Balance: ${creditAmount(bal)}`;
            balanceEl.classList.remove('hidden');
        };
        renderBalance(getKnownBalance());
        unsubscribeBalance = subscribeBalance(renderBalance);
        void fetchMe().catch(() => null);

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
            startCheckout({ packId: pack.id }, to.email)
                .then((url) => window.location.assign(url))
                .catch((err: unknown) => {
                    setPacksDisabled(false);
                    showError(err instanceof Error ? err.message : String(err));
                });
        };

        // Custom amount → Stripe (card only; USDC stays pack-based). Mirrors the
        // card branch of buy(): resolve the gift recipient, then redirect.
        const buyCustom = (credits: number): void => {
            showError('');
            const to = recipient();
            if (to.error) {
                showError(to.error);
                return;
            }
            const customBtn = overlay.querySelector<HTMLButtonElement>('#buy-credits-custom-btn');
            setPacksDisabled(true);
            if (customBtn) customBtn.disabled = true;
            startCheckout({ credits }, to.email)
                .then((url) => window.location.assign(url))
                .catch((err: unknown) => {
                    setPacksDisabled(false);
                    if (customBtn) customBtn.disabled = false;
                    showError(err instanceof Error ? err.message : String(err));
                });
        };

        const packsHost = overlay.querySelector<HTMLElement>('#buy-credits-packs')!;
        const customHost = overlay.querySelector<HTMLElement>('#buy-credits-custom')!;
        void fetchPacks()
            .then(({ packs, x402, custom }) => {
                applyChannels(methodRow, x402);
                renderPacks(packsHost, packs, buy);
                if (custom) {
                    renderCustom(customHost, custom, buyCustom);
                    // Custom is card-only; hide it whenever USDC is the method.
                    const syncCustom = (): void => {
                        customHost.classList.toggle('hidden', method === 'usdc');
                    };
                    syncCustom();
                    methodRow
                        .querySelectorAll('.buy-credits-target-btn')
                        .forEach((b) => b.addEventListener('click', syncCustom));
                }
            })
            .catch((err: unknown) => {
                packsHost.innerHTML = '';
                showError(err instanceof Error ? err.message : String(err));
            });
    });
}

/** A "type your own amount" row: a credits input that previews the price and
 *  only enables Buy at or above the floor. Server re-prices authoritatively. */
function renderCustom(
    host: HTMLElement,
    custom: { centsPerCredit: number; minCredits: number; maxCredits: number },
    onBuy: (credits: number) => void
): void {
    host.classList.remove('hidden');
    host.innerHTML = `
        <p class="provider-hint buy-credits-custom-label">Or choose your own amount</p>
        <div class="buy-credits-custom-row">
            <input type="number" class="signin-input buy-credits-custom-amount" id="buy-credits-custom-amount"
                min="${custom.minCredits}" step="1" inputmode="numeric"
                placeholder="Credits (min ${custom.minCredits})" autocomplete="off" />
            <button type="button" class="btn btn-secondary buy-credits-custom-btn" id="buy-credits-custom-btn" disabled>Buy</button>
        </div>
        <p class="provider-hint buy-credits-custom-hint" id="buy-credits-custom-hint"></p>`;
    const input = host.querySelector<HTMLInputElement>('#buy-credits-custom-amount')!;
    const btn = host.querySelector<HTMLButtonElement>('#buy-credits-custom-btn')!;
    const hint = host.querySelector<HTMLElement>('#buy-credits-custom-hint')!;

    const parsed = (): number => Math.floor(Number(input.value));
    const update = (): void => {
        const n = parsed();
        const empty = input.value.trim() === '';
        const valid = Number.isInteger(n) && n >= custom.minCredits && n <= custom.maxCredits;
        btn.disabled = !valid;
        btn.textContent = valid ? `Buy ${n} ☁️ — ${dollars(Math.round(n * custom.centsPerCredit))}` : 'Buy';
        if (empty) hint.textContent = '';
        else if (n < custom.minCredits) hint.textContent = `Minimum ${custom.minCredits} ☁️.`;
        else if (n > custom.maxCredits) hint.textContent = `Maximum ${custom.maxCredits.toLocaleString()} ☁️.`;
        else hint.textContent = '';
    };
    input.addEventListener('input', update);
    btn.addEventListener('click', () => {
        const n = parsed();
        if (Number.isInteger(n) && n >= custom.minCredits && n <= custom.maxCredits) onBuy(n);
    });
    update();
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
