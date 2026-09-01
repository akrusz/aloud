/**
 * Shared end-session confirmation overlay, used by session.ts and
 * noting-session.ts (both render an identical `#session-confirm`). The primary
 * button follows the user's Save-session-logs preference:
 *
 * - saveByDefault=true  -> primary saves; the text link discards.
 * - saveByDefault=false -> primary discards; the text link saves.
 *
 * Handlers are wired fresh each call and removed on any choice, so re-opening
 * never carries a stale destination.
 */

import { t } from '../i18n.js';

export interface EndConfirmConfig {
    /** When true, saving is the recommended action (primary button saves). */
    saveByDefault: boolean;
    /** End the session. `skipSave=true` discards without persisting. */
    end: (skipSave: boolean) => void;
    /** Invoked just before a saving end (e.g. to show a "Saving…" overlay).
     *  Not called when the chosen action discards. */
    onBeforeSave?: () => void;
}

export function showEndConfirm(
    root: ParentNode,
    message: string,
    config: EndConfirmConfig
): void {
    const overlay = root.querySelector<HTMLElement>('#session-confirm');
    const text = root.querySelector<HTMLElement>('#confirm-text');
    const yes = root.querySelector<HTMLButtonElement>('#confirm-yes');
    const no = root.querySelector<HTMLButtonElement>('#confirm-no');
    const skip = root.querySelector<HTMLButtonElement>('#confirm-skip-save');
    if (!overlay || !text || !yes || !no || !skip) return;

    text.textContent = message;
    // The primary label stays "End Session" either way (the Save-logs setting
    // decides what that does); the link spells out the opposite choice.
    yes.textContent = t('End Session');
    skip.textContent = config.saveByDefault ? t('End Without Saving') : t('Save & End');
    skip.classList.remove('hidden');
    overlay.classList.remove('hidden');

    const cleanup = (): void => {
        overlay.classList.add('hidden');
        yes.removeEventListener('click', onYes);
        no.removeEventListener('click', onNo);
        skip.removeEventListener('click', onSkip);
    };
    const choose = (save: boolean): void => {
        cleanup();
        if (save) config.onBeforeSave?.();
        config.end(!save);
    };
    // Primary saves only when saving is the default; otherwise the link saves.
    const onYes = (): void => choose(config.saveByDefault);
    const onSkip = (): void => choose(!config.saveByDefault);
    const onNo = (): void => cleanup();
    yes.addEventListener('click', onYes);
    no.addEventListener('click', onNo);
    skip.addEventListener('click', onSkip);
}
