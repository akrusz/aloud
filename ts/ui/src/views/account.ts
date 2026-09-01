/**
 * Account page (meditation-pal-bd5 / -8jc) - the signed-in user's identity +
 * money home, split out from Settings (app-behavior only). Email + connected
 * sign-ins, balance + Buy, returned gifts to re-gift or claim, and a collapsed
 * Danger zone with account deletion.
 */

import { detectCapabilities, watchCloudReachable } from '../capabilities.js';
import {
    fetchMe,
    clearCloudToken,
    deleteAccount,
    setCloudPassword,
    setEmailUpdates,
} from '../cloud-auth.js';
import { clearKnownBalance } from '../cloud-balance.js';
import { clearRetreatCovered } from '../cloud-coverage.js';
import {
    fetchReturnedGifts,
    regiftReturned,
    claimReturnedGift,
    type ReturnedGiftView,
} from '../cloud-billing.js';
import { creditAmount, RATE_EMOJI, withCloudOutline } from '../credit-rate.js';
import { showBuyCreditsModal } from '../buy-credits-modal.js';
import { wireCloudsExplainer } from '../clouds-explainer.js';
import { showSignInModal } from '../sign-in-modal.js';
import { confirmTypedDialog, alertDialog } from '../dialog.js';
import { showSuccessToast, showErrorToast } from '../toast.js';
import { t } from '../i18n.js';

export async function mountAccountView(root: HTMLElement): Promise<void> {
    root.innerHTML = `
    <div class="setup-container account-container">
        <h1 class="settings-title">${t('Account')}</h1>
        <div id="account-page-body"><p class="provider-hint">${t('Loading…')}</p></div>
    </div>`;
    await render(root);
}

async function render(root: HTMLElement): Promise<void> {
    const body = root.querySelector<HTMLElement>('#account-page-body');
    if (!body) return;

    const caps = await detectCapabilities();
    if (!caps.cloud) {
        // Usually a transient network miss, so watch for reachability and
        // re-render in place. BYOK keys stay a Settings concern
        // (device-scoped); this page is cloud-account only.
        body.innerHTML = `<section class="settings-section"><h2>${t('Account')}</h2>
            <p class="provider-hint">${t("Can't reach aloud cloud. Your account, balance, and gifts will appear once it's reachable.")}</p>
            </section>`;
        watchCloudReachable(() => void render(root));
        return;
    }

    const account = await fetchMe();
    if (!account) {
        body.innerHTML = `<section class="settings-section"><h2>${t('Account')}</h2>
            <p class="provider-hint">${t('Sign in to use aloud cloud for hosted speech-to-text, text-to-speech, and LLMs with no setup. Connect Google or Apple for free credits.')}</p>
            <button type="button" class="btn btn-primary account-signin-cta" id="acct-signin">${t('Sign in or create account')}</button>
            </section>`;
        body.querySelector('#acct-signin')?.addEventListener('click', () => {
            void showSignInModal().then(() => render(root));
        });
        return;
    }

    const returned = await fetchReturnedGifts();

    const providers = account.providers ?? [];
    const hasPassword = providers.includes('email');
    // Names the federated method in the "add a password" copy; only rendered
    // when hasPassword is false.
    const federated = providers.includes('google')
        ? 'Google'
        : providers.includes('apple')
          ? 'Apple'
          : t('your current sign-in');
    const needsConnect =
        providers.length > 0 && !providers.some((p) => p === 'google' || p === 'apple');
    const connectPrompt = needsConnect
        ? `<button type="button" class="account-connect-prompt provider-hint" id="acct-connect">
               ${t('Connect Google or Apple to claim your free credits →')}
           </button>`
        : '';

    body.innerHTML = `
        <section class="settings-section">
            <h2>${t('Account Name')}</h2>
            <hr class="account-rule">
            <div class="account-row">
                <span class="account-email">${escape(account.email)}</span>
                <button type="button" class="btn btn-secondary" id="acct-signout">${t('Sign out')}</button>
            </div>
            <h2 class="account-subhead">${t('Cloud Balance')}</h2>
            <div class="account-row">
                <span class="account-credits">${
                    account.retreatCovered
                        ? t('Retreat access - usage is on your retreat for now')
                        : withCloudOutline(t('{amount} remaining', { amount: creditAmount(account.creditsRemaining) }))
                }</span>
                ${account.retreatCovered ? '' : `<button type="button" class="btn btn-primary" id="acct-buy">${t('Buy {clouds}', { clouds: withCloudOutline(RATE_EMOJI) })}</button>`}
            </div>
            <p class="form-hint clouds-hint-row">
                <span>${withCloudOutline(t('☁️ are used by aloud cloud to power facilitator intelligence, high-quality voices, and speech recognition.'))}</span>
                <button type="button" class="btn btn-secondary" id="acct-clouds-what">${t('What are {clouds}?', { clouds: withCloudOutline(RATE_EMOJI) })}</button>
            </p>
            ${connectPrompt}
        </section>
        <section class="settings-section" id="password-section">
            <h2>${t('Password')}</h2>
            <p class="form-hint">${
                hasPassword
                    ? t('Change the password used to sign in with your email.')
                    : t('Add a password to enable signing in with email, in addition to your {provider} account.', { provider: escape(federated) })
            }</p>
            <div class="account-password-row">
                <input type="password" id="acct-password" class="signin-input"
                    placeholder="${hasPassword ? t('New password (8+ characters)') : t('Password (8+ characters)')}"
                    autocomplete="new-password" minlength="8"
                    aria-label="${hasPassword ? t('New password') : t('Password')}">
                <button type="button" class="btn btn-primary" id="acct-set-password">${
                    hasPassword ? t('Change password') : t('Set password')
                }</button>
            </div>
        </section>
        <section class="settings-section" id="email-updates-section">
            <h2>${t('Email updates')}</h2>
            <div class="form-group">
                <label class="checkbox-label">
                    <input type="checkbox" id="acct-email-updates"${account.emailUpdates ? ' checked' : ''}>
                    <span>${t('Email me occasional updates about aloud')}</span>
                </label>
                <span class="form-hint">${t("We'll never share or sell your address.")}</span>
            </div>
        </section>
        ${
            returned.length
                ? `<section class="settings-section" id="giftable-section">
                    <h2>${t('Giftable clouds')}</h2>
                    <p class="provider-hint">${t('Gifts that came back to you. Re-gift them to someone else, or claim them to your balance.')}</p>
                    <div class="gift-list" id="giftable-list"></div>
                </section>`
                : ''
        }
        <section class="settings-section settings-danger" id="danger-zone">
            <div class="settings-danger-head">
                <h2>${t('Danger zone')}</h2>
                <button type="button" class="btn btn-small btn-secondary" id="danger-zone-toggle"
                    aria-expanded="false" aria-controls="danger-zone-body">${t('Show')}</button>
            </div>
            <div class="settings-danger-body hidden" id="danger-zone-body">
                <div class="form-group">
                    <div class="settings-danger-row">
                        <div>
                            <div class="settings-danger-label">${t('Delete account')}</div>
                            <span class="form-hint">${t("Permanently deletes your account. Any remaining credits are forfeited and can't be refunded. This can't be undone. You can make a fresh account with the same address later.")}</span>
                        </div>
                        <button type="button" class="btn btn-danger" id="acct-delete">${t('Delete account')}</button>
                    </div>
                </div>
            </div>
        </section>`;

    wireAccountSection(root);
    wirePasswordSection(root, hasPassword);
    wireEmailUpdates(root);
    if (returned.length) wireGiftableList(root, returned);
    wireDangerZone(root, account.email);
}

function wirePasswordSection(root: HTMLElement, hasPassword: boolean): void {
    const input = root.querySelector<HTMLInputElement>('#acct-password');
    const btn = root.querySelector<HTMLButtonElement>('#acct-set-password');
    if (!input || !btn) return;
    const submit = (): void => {
        const password = input.value;
        if (password.length < 8) {
            showErrorToast(t('Password must be at least 8 characters.'));
            input.focus();
            return;
        }
        btn.disabled = true;
        input.disabled = true;
        setCloudPassword(password)
            .then(() => {
                showSuccessToast(
                    hasPassword
                        ? t('Password changed.')
                        : t('Password set - you can now sign in with your email and password.')
                );
                void render(root);
            })
            .catch((err: unknown) => {
                btn.disabled = false;
                input.disabled = false;
                showErrorToast(err instanceof Error ? err.message : String(err));
            });
    };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
    });
}

function wireEmailUpdates(root: HTMLElement): void {
    const box = root.querySelector<HTMLInputElement>('#acct-email-updates');
    box?.addEventListener('change', () => {
        const optIn = box.checked;
        box.disabled = true;
        setEmailUpdates(optIn)
            .then(() => {
                showSuccessToast(optIn ? t("You're on the list.") : t("You won't get update emails."));
            })
            .catch((err: unknown) => {
                box.checked = !optIn; // save failed; show the stored choice
                showErrorToast(err instanceof Error ? err.message : String(err));
            })
            .finally(() => {
                box.disabled = false;
            });
    });
}

function wireAccountSection(root: HTMLElement): void {
    root.querySelector('#acct-buy')?.addEventListener('click', () => {
        void showBuyCreditsModal().then(() => render(root));
    });
    root.querySelector('#acct-signout')?.addEventListener('click', () => {
        clearKnownBalance();
        clearRetreatCovered();
        void clearCloudToken().then(() => render(root));
    });
    wireCloudsExplainer(root, 'acct-clouds-what');
    root.querySelector('#acct-connect')?.addEventListener('click', () => {
        void showSignInModal({
            title: t('Claim your free credits'),
            subtitle: t('Connect Google or Apple to unlock free credits on this account.'),
        }).then(() => render(root));
    });
}

function wireGiftableList(root: HTMLElement, gifts: ReturnedGiftView[]): void {
    const list = root.querySelector<HTMLElement>('#giftable-list');
    if (!list) return;
    for (const gift of gifts) {
        const row = document.createElement('div');
        row.className = 'gift-row gift-row-returned';
        row.innerHTML = `
            <div class="gift-row-info">
                <span class="gift-row-amount">${withCloudOutline(creditAmount(gift.credits, 0))}</span>
                <span class="provider-hint gift-row-from"> ${t('· was for {email}', { email: escape(gift.toEmail) })}</span>
            </div>
            <div class="gift-row-actions">
                <input type="email" class="gift-regift-email" placeholder="${t('re-gift to email…')}"
                    aria-label="${t('Re-gift to email')}" autocomplete="off" autocapitalize="off" spellcheck="false">
                <button type="button" class="btn btn-primary gift-regift">${t('Re-gift')}</button>
                <button type="button" class="btn btn-secondary gift-claim">${t('Claim')}</button>
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
                showErrorToast(t('Enter an email to re-gift to.'));
                emailInput.focus();
                return;
            }
            run(
                () => regiftReturned(gift.id, email),
                () => showSuccessToast(t('Re-gifted {amount} to {email}.', { amount: creditAmount(gift.credits, 0), email }))
            );
        });
        row.querySelector('.gift-claim')?.addEventListener('click', () =>
            run(
                () => claimReturnedGift(gift.id),
                () => showSuccessToast(t('{amount} added to your balance.', { amount: creditAmount(gift.credits, 0) }))
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
        toggle.textContent = shown ? t('Hide') : t('Show');
        toggle.setAttribute('aria-expanded', String(shown));
    });

    const del = root.querySelector<HTMLButtonElement>('#acct-delete');
    del?.addEventListener('click', () => {
        void (async () => {
            const ok = await confirmTypedDialog(
                t('This permanently deletes your account ({email}). Any remaining credits are forfeited and it can\'t be undone. You can sign up again later, but won\'t get the free credits a second time.\n\nType "delete" to confirm.', { email }),
                { requiredText: 'delete', okLabel: t('Delete account'), danger: true }
            );
            if (!ok) return;
            del.disabled = true;
            try {
                await deleteAccount();
            } catch (err) {
                del.disabled = false;
                await alertDialog(err instanceof Error ? err.message : t('Could not delete the account.'));
                return;
            }
            await alertDialog(t('Your account has been deleted.'));
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
