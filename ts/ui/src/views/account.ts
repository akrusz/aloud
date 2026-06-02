/**
 * Account page (meditation-pal-bd5 / -8jc) — the signed-in user's identity +
 * money home, split out from Settings (which is now app-behavior only). Shows:
 *   - email + connected sign-ins (+ a "connect for free credits" nudge),
 *   - balance + Buy,
 *   - a "show live balance during sessions" toggle,
 *   - Giftable clouds: gifts that bounced back, to re-gift or claim, and
 *   - a Danger zone (collapsed) with account deletion.
 * Only reachable when aloud cloud is up; the nav entry is hidden otherwise.
 */

import { detectCapabilities } from '../capabilities.js';
import { fetchMe, clearCloudToken, deleteAccount } from '../cloud-auth.js';
import { clearKnownBalance } from '../cloud-balance.js';
import {
    fetchReturnedGifts,
    regiftReturned,
    claimReturnedGift,
    type ReturnedGiftView,
} from '../cloud-billing.js';
import { creditAmount, RATE_EMOJI } from '../credit-rate.js';
import { showBuyCreditsModal } from '../buy-credits-modal.js';
import { showSignInModal } from '../sign-in-modal.js';
import { confirmTypedDialog, alertDialog } from '../dialog.js';
import { showSuccessToast, showErrorToast } from '../toast.js';
import { loadAppSettings, saveAppSettings } from '../app-settings.js';

export async function mountAccountView(root: HTMLElement): Promise<void> {
    root.innerHTML = `
    <div class="setup-container">
        <h1 class="settings-title">Account</h1>
        <div id="account-page-body"><p class="provider-hint">Loading…</p></div>
    </div>`;
    await render(root);
}

async function render(root: HTMLElement): Promise<void> {
    const body = root.querySelector<HTMLElement>('#account-page-body');
    if (!body) return;

    const caps = await detectCapabilities();
    if (!caps.cloud) {
        body.innerHTML = `<section class="settings-section"><h2>Account</h2>
            <p class="provider-hint">aloud cloud is unreachable right now — you can still use your own API keys or a local model. Sign-in and credits return when it's back.</p>
            </section>`;
        return;
    }

    const account = await fetchMe();
    if (!account) {
        body.innerHTML = `<section class="settings-section"><h2>Account</h2>
            <p class="provider-hint">Sign in to use aloud cloud — hosted speech-to-text, text-to-speech, and LLMs with no setup. Connect Google or Apple for free credits.</p>
            <button type="button" class="btn btn-primary" id="acct-signin">Sign in or create account</button>
            </section>`;
        body.querySelector('#acct-signin')?.addEventListener('click', () => {
            void showSignInModal().then(() => render(root));
        });
        return;
    }

    const settings = await loadAppSettings();
    const returned = await fetchReturnedGifts();

    const providers = account.providers ?? [];
    const needsConnect =
        providers.length > 0 && !providers.some((p) => p === 'google' || p === 'apple');
    const connectPrompt = needsConnect
        ? `<button type="button" class="account-connect-prompt provider-hint" id="acct-connect">
               Connect Google or Apple to claim your free credits →
           </button>`
        : '';

    body.innerHTML = `
        <section class="settings-section">
            <h2>Account</h2>
            <div class="account-row">
                <div class="account-info">
                    <div class="account-email">${escape(account.email)}</div>
                    <div class="account-credits provider-hint">${creditAmount(account.creditsRemaining)} remaining</div>
                </div>
                <div class="account-actions">
                    <label class="checkbox-label account-balance-toggle">
                        <input type="checkbox" id="acct-show-session-balance"${settings.showSessionBalance ? ' checked' : ''}>
                        <span>Show live credit balance during sessions</span>
                    </label>
                    <button type="button" class="btn btn-primary" id="acct-buy">Buy ${RATE_EMOJI}</button>
                    <button type="button" class="btn btn-secondary" id="acct-signout">Sign out</button>
                </div>
            </div>
            ${connectPrompt}
        </section>
        ${
            returned.length
                ? `<section class="settings-section" id="giftable-section">
                    <h2>Giftable clouds</h2>
                    <p class="provider-hint">Gifts that came back to you — re-gift them to someone else, or claim them to your balance.</p>
                    <div class="gift-list" id="giftable-list"></div>
                </section>`
                : ''
        }
        <section class="settings-section settings-danger" id="danger-zone">
            <div class="settings-danger-head">
                <h2>Danger zone</h2>
                <button type="button" class="btn btn-small btn-secondary" id="danger-zone-toggle"
                    aria-expanded="false" aria-controls="danger-zone-body">Show</button>
            </div>
            <div class="settings-danger-body hidden" id="danger-zone-body">
                <div class="form-group">
                    <div class="settings-danger-row">
                        <div>
                            <div class="settings-danger-label">Delete account</div>
                            <span class="form-hint">Permanently deletes your account and frees your sign-in to start over. Any remaining credits are forfeited and can't be refunded. This can't be undone.</span>
                        </div>
                        <button type="button" class="btn btn-danger" id="acct-delete">Delete account</button>
                    </div>
                </div>
            </div>
        </section>`;

    wireAccountSection(root, account.email, settings.showSessionBalance);
    if (returned.length) wireGiftableList(root, returned);
    wireDangerZone(root, account.email);
}

function wireAccountSection(root: HTMLElement, _email: string, showBalance: boolean): void {
    root.querySelector('#acct-buy')?.addEventListener('click', () => {
        void showBuyCreditsModal().then(() => render(root));
    });
    root.querySelector('#acct-signout')?.addEventListener('click', () => {
        clearKnownBalance();
        void clearCloudToken().then(() => render(root));
    });
    root.querySelector('#acct-connect')?.addEventListener('click', () => {
        void showSignInModal({
            title: 'Claim your free credits',
            subtitle: 'Connect Google or Apple to unlock free credits on this account.',
        }).then(() => render(root));
    });
    const toggle = root.querySelector<HTMLInputElement>('#acct-show-session-balance');
    if (toggle) {
        toggle.checked = showBalance;
        toggle.addEventListener('change', () => {
            void (async () => {
                const s = await loadAppSettings();
                s.showSessionBalance = toggle.checked;
                await saveAppSettings(s);
            })();
        });
    }
}

function wireGiftableList(root: HTMLElement, gifts: ReturnedGiftView[]): void {
    const list = root.querySelector<HTMLElement>('#giftable-list');
    if (!list) return;
    for (const gift of gifts) {
        const row = document.createElement('div');
        row.className = 'gift-row gift-row-returned';
        row.innerHTML = `
            <div class="gift-row-info">
                <span class="gift-row-amount">${creditAmount(gift.credits, 0)}</span>
                <span class="provider-hint gift-row-from"> · was for ${escape(gift.toEmail)}</span>
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
        const run = (action: () => Promise<void>, done: () => void): void => {
            setBusy(true);
            action()
                .then(() => {
                    done();
                    void render(root); // refresh balance + giftable list
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
        list.appendChild(row);
    }
}

function wireDangerZone(root: HTMLElement, email: string): void {
    const toggle = root.querySelector<HTMLButtonElement>('#danger-zone-toggle');
    const dzBody = root.querySelector<HTMLElement>('#danger-zone-body');
    toggle?.addEventListener('click', () => {
        const shown = dzBody?.classList.toggle('hidden') === false;
        toggle.textContent = shown ? 'Hide' : 'Show';
        toggle.setAttribute('aria-expanded', String(shown));
    });

    const del = root.querySelector<HTMLButtonElement>('#acct-delete');
    del?.addEventListener('click', () => {
        void (async () => {
            const ok = await confirmTypedDialog(
                `This permanently deletes your account (${email}). Any remaining credits are forfeited and it can't be undone — you can sign up again later, but won't get the free credits a second time.\n\nType "delete" to confirm.`,
                { requiredText: 'delete', okLabel: 'Delete account', danger: true }
            );
            if (!ok) return;
            del.disabled = true;
            try {
                await deleteAccount();
            } catch (err) {
                del.disabled = false;
                await alertDialog(err instanceof Error ? err.message : 'Could not delete the account.');
                return;
            }
            await alertDialog('Your account has been deleted.');
            await render(root); // back to the signed-out state
        })();
    });
}

function escape(s: string): string {
    return s.replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
    );
}
