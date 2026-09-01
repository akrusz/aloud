/**
 * In-session info panel: the popover behind the nav "ⓘ" button. Keeps session
 * facts (model, mode, speed notes) one tap away instead of in the always-on
 * chrome. Content is caller-supplied via `buildRows`, so the meditation session
 * and the noting circle share the panel with different rows.
 *
 * The overlay is appended to the view root, so it tears down with the view.
 */

export interface SessionInfoRow {
    /** Short label ("Model", "Mode"). */
    label: string;
    value: string;
    /** Optional sub-line under the value, e.g. a speed heads-up. */
    note?: string;
    /**
     * Makes the row a control rather than a fact: it renders as a button and
     * the panel closes before this fires. Used for settings that are otherwise
     * only reachable by tapping their in-session widget - the session clock can
     * be hidden from the input row, and without this there'd be no way back.
     */
    onClick?: () => void;
}

export interface SessionInfoAction {
    /** Button label ("Report a bug"). */
    label: string;
    /** The panel closes before this fires. */
    onClick: () => void;
}

export interface SessionInfoPanel {
    open(): void;
    close(): void;
    toggle(): void;
    /** Re-render if open, e.g. after a model swap. */
    refresh(): void;
    isOpen(): boolean;
    /** Wire to the view's teardown; removes the document-level listener too. */
    dispose(): void;
}

import { t } from './i18n.js';

function escape(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
    );
}

/** `buildRows` runs on every open and refresh, so rows reflect live state. */
export function mountSessionInfoPanel(
    root: HTMLElement,
    buildRows: () => SessionInfoRow[],
    title = 'Session',
    footerActions: SessionInfoAction[] = []
): SessionInfoPanel {
    const overlay = document.createElement('div');
    overlay.className = 'session-info-overlay hidden';
    overlay.id = 'session-info-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);
    overlay.innerHTML = `
        <div class="session-info-backdrop" data-info-close></div>
        <div class="session-info-panel">
            <div class="session-info-head">
                <h3 class="session-info-title">${escape(title)}</h3>
                <button type="button" class="session-info-close" data-info-close aria-label="${t('Close')}">&times;</button>
            </div>
            <div class="session-info-body" id="session-info-body"></div>
            ${
                footerActions.length
                    ? `<div class="session-info-actions">${footerActions
                          .map(
                              (a, i) =>
                                  `<button type="button" class="btn btn-secondary btn-small session-info-action" data-info-action="${i}">${escape(a.label)}</button>`
                          )
                          .join('')}</div>`
                    : ''
            }
        </div>`;
    root.appendChild(overlay);
    const body = overlay.querySelector<HTMLElement>('#session-info-body')!;

    /** Rows carrying an onClick, in render order, for the click delegate. */
    let clickableRows: SessionInfoRow[] = [];

    function render(): void {
        const rows = buildRows();
        clickableRows = rows.filter((r) => r.onClick);
        body.innerHTML = rows
            .map((r) => {
                const inner =
                    `<span class="session-info-label">${escape(r.label)}</span>` +
                    `<span class="session-info-value">${escape(r.value)}</span>` +
                    (r.note ? `<span class="session-info-note">${escape(r.note)}</span>` : '');
                if (!r.onClick) return `<div class="session-info-row">${inner}</div>`;
                const i = clickableRows.indexOf(r);
                return `<button type="button" class="session-info-row session-info-row-action" data-info-row="${i}">${inner}</button>`;
            })
            .join('');
    }

    function open(): void {
        render();
        overlay.classList.remove('hidden');
    }
    function close(): void {
        overlay.classList.add('hidden');
    }
    function isOpen(): boolean {
        return !overlay.classList.contains('hidden');
    }

    overlay.addEventListener('click', (e) => {
        const el = e.target as HTMLElement;
        if (el.closest('[data-info-close]')) {
            close();
            return;
        }
        const action = el.closest<HTMLElement>('[data-info-action]');
        if (action) {
            close();
            footerActions[Number(action.dataset['infoAction'])]?.onClick();
            return;
        }
        const row = el.closest<HTMLElement>('[data-info-row]');
        if (row) {
            close();
            clickableRows[Number(row.dataset['infoRow'])]?.onClick?.();
        }
    });
    const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape' && isOpen()) close();
    };
    document.addEventListener('keydown', onKey);

    return {
        open,
        close,
        toggle: () => (isOpen() ? close() : open()),
        refresh: () => {
            if (isOpen()) render();
        },
        isOpen,
        dispose: () => {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
        },
    };
}
