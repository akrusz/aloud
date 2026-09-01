/**
 * Resume-session modal (meditation-pal-v73p). When Android kills a backgrounded
 * session, the next launch offers to resume it. A modal - not the inline setup
 * banner - so switching mode tabs underneath can never shift the layout, and the
 * choice stays explicit. Reuses the shared .voice-modal-* chrome.
 */

import { manageModalFocus } from './modal-focus.js';
import { t } from './i18n.js';

const OVERLAY_ID = 'resume-modal-overlay';

export interface ResumeModalConfig {
    /** "felt sense · 12 min in" - where the session was cut off. */
    detail: string;
    /** Resume the interrupted session. */
    onResume: () => void;
    /** Drop it and start clean (clears the durable resume pointer). */
    onStartFresh: () => void;
}

export function showResumeModal(config: ResumeModalConfig): void {
    if (document.getElementById(OVERLAY_ID)) return;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'voice-modal-overlay';
    overlay.innerHTML = `
        <div class="voice-modal resume-modal" role="dialog" aria-modal="true" aria-label="${t('Resume session')}">
            <div class="voice-modal-header">
                <span class="voice-modal-title">${t('Resume your session?')}</span>
                <button type="button" class="voice-modal-close" id="resume-modal-close" aria-label="${t('Not now')}">&times;</button>
            </div>
            <p class="resume-modal-detail"></p>
            <div class="resume-modal-actions">
                <button type="button" class="btn btn-primary" id="resume-modal-resume">${t('Resume session')}</button>
                <button type="button" class="btn btn-secondary" id="resume-modal-fresh">${t('Start fresh')}</button>
            </div>
        </div>`;
    // textContent (not innerHTML): the detail is derived session data, keep inert.
    overlay.querySelector<HTMLElement>('.resume-modal-detail')!.textContent = config.detail;
    document.body.appendChild(overlay);
    const releaseFocus = manageModalFocus(overlay);

    const close = (): void => {
        document.removeEventListener('keydown', onKey);
        releaseFocus();
        overlay.remove();
    };
    // ×/Escape/backdrop = "not now": leave the session pointer in place so it's
    // offered again next launch, without committing to resume or start-fresh.
    const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') close();
    };
    overlay.querySelector('#resume-modal-close')?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });
    document.addEventListener('keydown', onKey);
    overlay.querySelector('#resume-modal-resume')?.addEventListener('click', () => {
        close();
        config.onResume();
    });
    overlay.querySelector('#resume-modal-fresh')?.addEventListener('click', () => {
        close();
        config.onStartFresh();
    });
}
