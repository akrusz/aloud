/**
 * Promise-based in-app confirm / alert dialogs.
 *
 * window.confirm()/alert()/prompt() are unreliable inside the Tauri webview:
 * they can return immediately without showing a dialog, making confirm-gated
 * actions (voice Uninstall, history Delete, Ollama model removal) silently do
 * nothing. These render a themed overlay that behaves the same in browser and
 * desktop shell. Styling in ui/src/style.css (.app-dialog*).
 */

interface ButtonSpec {
    label: string;
    value: boolean;
    /** The affirmative action: focused on open, triggered by Enter. */
    action?: boolean;
    danger?: boolean;
}

function showDialog(
    message: string,
    buttons: ButtonSpec[],
    dismissValue: boolean,
    asHtml = false
): Promise<boolean> {
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
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') {
                e.preventDefault();
                finish(dismissValue);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                finish(buttons.find((b) => b.action)?.value ?? dismissValue);
            }
        };

        let actionBtn: HTMLButtonElement | null = null;
        for (const b of buttons) {
            const el = document.createElement('button');
            el.type = 'button';
            el.textContent = b.label;
            el.className = `btn btn-small ${b.danger ? 'btn-danger' : b.action ? 'btn-begin' : 'btn-secondary'}`;
            el.addEventListener('click', () => finish(b.value));
            if (b.action) actionBtn = el;
            btnRow.appendChild(el);
        }
        box.appendChild(btnRow);
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
    /** Render the message as markup - static app copy only, nothing untrusted. */
    html?: boolean;
}

/** Resolves true if the user confirms, false on cancel / backdrop / Escape. */
export function confirmDialog(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
    return showDialog(
        message,
        [
            { label: opts.cancelLabel ?? 'Cancel', value: false },
            { label: opts.okLabel ?? 'OK', value: true, action: true, danger: opts.danger ?? false },
        ],
        false,
        opts.html ?? false
    );
}

/** A one-button acknowledgement. Resolves once dismissed. `html: true`
 *  renders the message as markup - static app copy only, nothing untrusted. */
export function alertDialog(
    message: string,
    okLabel = 'OK',
    opts: { html?: boolean } = {}
): Promise<void> {
    return showDialog(
        message,
        [{ label: okLabel, value: true, action: true }],
        true,
        opts.html ?? false
    ).then(() => undefined);
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
        input.setAttribute('aria-label', `Type ${opts.requiredText} to confirm`);
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
        cancelBtn.textContent = opts.cancelLabel ?? 'Cancel';
        cancelBtn.className = 'btn btn-small btn-secondary';
        cancelBtn.addEventListener('click', () => finish(false));

        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.textContent = opts.okLabel ?? 'Confirm';
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
