/**
 * Promise-based in-app confirm / alert dialogs.
 *
 * window.confirm()/alert()/prompt() are unreliable inside the Tauri webview:
 * they can return immediately without showing a dialog, making confirm-gated
 * actions (voice Uninstall, history Delete, Ollama model removal) silently do
 * nothing. These render a themed overlay that behaves the same in browser and
 * desktop shell. Styling in ui/src/style.css (.app-dialog*).
 */

import { t } from './i18n.js';

interface ButtonSpec<T> {
    label: string;
    value: T;
    /** The affirmative action: focused on open, triggered by Enter. */
    action?: boolean;
    danger?: boolean;
}

interface DialogExtras {
    asHtml?: boolean;
    /** Content between the message and the buttons. */
    extra?: HTMLElement | undefined;
    /** Content below the buttons: a caller-built secondary route, subordinate
     *  to the main action by position. Its own controls don't settle the
     *  dialog. */
    footer?: HTMLElement | undefined;
    /** Render a top-right × (like the About modal) that dismisses. For dialogs
     *  whose "no thanks" doesn't earn a place in the button row. */
    closeX?: boolean;
    /** Center the button row instead of the right-aligned default, which reads
     *  better when there's a single action rather than a choice pair. */
    centerButtons?: boolean;
}

function showDialog<T>(
    message: string,
    buttons: ButtonSpec<T>[],
    dismissValue: T,
    { asHtml = false, extra, footer, closeX = false, centerButtons = false }: DialogExtras = {}
): Promise<T> {
    return new Promise((resolve) => {
        if (typeof document === 'undefined') {
            resolve(dismissValue);
            return;
        }
        const backdrop = document.createElement('div');
        backdrop.className = 'app-dialog-backdrop';
        const box = document.createElement('div');
        box.className = 'app-dialog';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');

        const msg = document.createElement('p');
        msg.className = 'app-dialog-message';
        // textContent by default so ordinary callers can't inject markup;
        // asHtml is opt-in for OUR OWN static copy (e.g. cloud-glyph outline
        // spans in the clouds explainer), never for user or server strings.
        if (asHtml) msg.innerHTML = message;
        else msg.textContent = message;
        box.appendChild(msg);
        if (extra) box.appendChild(extra);

        const btnRow = document.createElement('div');
        btnRow.className = centerButtons ? 'app-dialog-buttons is-centered' : 'app-dialog-buttons';

        let settled = false;
        const finish = (v: T): void => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey, true);
            backdrop.remove();
            resolve(v);
        };
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') {
                e.preventDefault();
                finish(dismissValue);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const action = buttons.find((b) => b.action);
                finish(action ? action.value : dismissValue);
            }
        };

        if (closeX) {
            box.classList.add('has-close');
            const x = document.createElement('button');
            x.type = 'button';
            // Same face as the About / voice modal close.
            x.className = 'app-dialog-close voice-modal-close';
            x.innerHTML = '&times;';
            x.setAttribute('aria-label', t('Close'));
            x.addEventListener('click', () => finish(dismissValue));
            box.prepend(x);
        }

        let actionBtn: HTMLButtonElement | null = null;
        for (const b of buttons) {
            const el = document.createElement('button');
            el.type = 'button';
            // html mode covers the labels too, so a ☁️ in a button can carry
            // its cloud-glyph outline span. Same trust rule as the message.
            if (asHtml) el.innerHTML = b.label;
            else el.textContent = b.label;
            // btn-primary (not btn-begin): the CTA's big padding/radius read
            // mismatched next to its sibling. Full-size .btn padding, not
            // btn-small - dialog buttons are the focal point of their surface.
            el.className = `btn ${b.danger ? 'btn-danger' : b.action ? 'btn-primary' : 'btn-secondary'}`;
            el.addEventListener('click', () => finish(b.value));
            if (b.action) actionBtn = el;
            btnRow.appendChild(el);
        }
        box.appendChild(btnRow);
        if (footer) box.appendChild(footer);
        backdrop.appendChild(box);
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) finish(dismissValue);
        });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(backdrop);
        actionBtn?.focus();
    });
}

export interface ConfirmOptions {
    okLabel?: string;
    cancelLabel?: string;
    /** Style the affirmative button as destructive. */
    danger?: boolean;
    /** Render the message AND button labels as markup - static app copy only,
     *  nothing untrusted. */
    html?: boolean;
    /** Which button is the default (focused, Enter, primary-styled). 'ok'
     *  unless the affirmative is a pushy upsell - then 'cancel' keeps the
     *  quiet dismissal as the path of least resistance. */
    primary?: 'ok' | 'cancel';
}

/** Resolves true if the user confirms, false on cancel / backdrop / Escape. */
export function confirmDialog(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
    const cancelIsPrimary = opts.primary === 'cancel';
    return showDialog(
        message,
        [
            { label: opts.cancelLabel ?? t('Cancel'), value: false, action: cancelIsPrimary },
            {
                label: opts.okLabel ?? t('OK'),
                value: true,
                action: !cancelIsPrimary,
                danger: opts.danger ?? false,
            },
        ],
        false,
        { asHtml: opts.html ?? false }
    );
}

/** A one-button acknowledgement. Resolves once dismissed. `html: true`
 *  renders the message as markup - static app copy only, nothing untrusted. */
export function alertDialog(
    message: string,
    okLabel?: string,
    opts: { html?: boolean } = {}
): Promise<void> {
    return showDialog(
        message,
        [{ label: okLabel ?? t('OK'), value: true, action: true }],
        true,
        { asHtml: opts.html ?? false }
    ).then(() => undefined);
}

export interface ChoiceSpec {
    label: string;
    /** Returned when picked. */
    value: string;
    /** The default: focused on open, triggered by Enter, styled primary. */
    action?: boolean;
}

export interface ChoiceOptions {
    cancelLabel?: string;
    /** Dismiss with a top-right × instead of a Cancel button, keeping the
     *  button row to the real choices. */
    closeX?: boolean;
    /** Content between the message and the buttons. */
    extra?: HTMLElement;
    /** Content below the buttons: a secondary route the caller wires itself
     *  (it doesn't resolve the dialog). */
    footer?: HTMLElement;
    /** Center the button row rather than right-aligning it. */
    centerButtons?: boolean;
}

/**
 * More than two ways forward. Resolves to the picked `value`, or null on
 * dismissal (Cancel / × / backdrop / Escape).
 */
export function choiceDialog(
    message: string,
    choices: ChoiceSpec[],
    opts: ChoiceOptions = {}
): Promise<string | null> {
    const cancel: ButtonSpec<string | null>[] = opts.closeX
        ? []
        : [{ label: opts.cancelLabel ?? t('Cancel'), value: null }];
    return showDialog<string | null>(
        message,
        [...cancel, ...choices],
        null,
        {
            extra: opts.extra,
            footer: opts.footer,
            closeX: opts.closeX ?? false,
            centerButtons: opts.centerButtons ?? false,
        }
    );
}

export interface ConfirmTypedOptions {
    /** Phrase the user must type (matched trimmed + case-insensitively) before
     *  the affirmative button enables. */
    requiredText: string;
    okLabel?: string;
    cancelLabel?: string;
    /** Style the affirmative button as destructive. */
    danger?: boolean;
}

/**
 * Affirmative button stays disabled until the user types `requiredText`: extra
 * friction for irreversible actions (account deletion). Separate from
 * showDialog because it carries an input.
 */
export function confirmTypedDialog(message: string, opts: ConfirmTypedOptions): Promise<boolean> {
    return new Promise((resolve) => {
        if (typeof document === 'undefined') {
            resolve(false);
            return;
        }
        const backdrop = document.createElement('div');
        backdrop.className = 'app-dialog-backdrop';
        const box = document.createElement('div');
        box.className = 'app-dialog';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');

        const msg = document.createElement('p');
        msg.className = 'app-dialog-message';
        msg.textContent = message;
        box.appendChild(msg);

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'app-dialog-input';
        input.placeholder = opts.requiredText;
        input.setAttribute('aria-label', t('Type {text} to confirm', { text: opts.requiredText }));
        input.autocomplete = 'off';
        input.autocapitalize = 'off';
        input.spellcheck = false;
        box.appendChild(input);

        const btnRow = document.createElement('div');
        btnRow.className = 'app-dialog-buttons';

        let settled = false;
        const finish = (v: boolean): void => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey, true);
            backdrop.remove();
            resolve(v);
        };
        const matches = (): boolean =>
            input.value.trim().toLowerCase() === opts.requiredText.trim().toLowerCase();

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = opts.cancelLabel ?? t('Cancel');
        cancelBtn.className = 'btn btn-small btn-secondary';
        cancelBtn.addEventListener('click', () => finish(false));

        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.textContent = opts.okLabel ?? t('Confirm');
        okBtn.className = `btn btn-small ${opts.danger ? 'btn-danger' : 'btn-begin'}`;
        okBtn.disabled = true;
        okBtn.addEventListener('click', () => {
            if (!okBtn.disabled) finish(true);
        });

        input.addEventListener('input', () => {
            okBtn.disabled = !matches();
        });

        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') {
                e.preventDefault();
                finish(false);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (matches()) finish(true);
            }
        };

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);
        box.appendChild(btnRow);
        backdrop.appendChild(box);
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) finish(false);
        });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(backdrop);
        input.focus();
    });
}
