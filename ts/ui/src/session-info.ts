/**
 * In-session info panel — the small popover behind the nav "ⓘ" button.
 *
 * Keeps session facts (which model you're talking to, the mode, a speed note
 * when relevant, …) out of the always-on chrome and one tap away instead. The
 * content is caller-supplied via `buildRows`, so the meditation session and the
 * noting circle can show different things through the same panel.
 *
 * The overlay is appended to the view root, so it's torn down with the view.
 */

export interface SessionInfoRow {
    /** Short label ("Model", "Mode"). */
    label: string;
    /** The value shown for this row. */
    value: string;
    /** Optional sub-line under the value — e.g. a speed heads-up. */
    note?: string;
}

export interface SessionInfoAction {
    /** Button label ("Report a bug"). */
    label: string;
    /** Fired on click; the panel closes first. */
    onClick: () => void;
}

export interface SessionInfoPanel {
    open(): void;
    close(): void;
    toggle(): void;
    /** Re-render if the panel is currently open (e.g. after a model swap). */
    refresh(): void;
    isOpen(): boolean;
    /** Remove the overlay + its document-level listener. Wire to the view's
     *  teardown so nothing leaks across sessions. */
    dispose(): void;
}

function escape(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
    );
}

/**
 * Mount the info panel into `root`. Returns handles to open/close/refresh it.
 * `buildRows` is called each time the panel opens (and on refresh), so it can
 * reflect live session state.
 */
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
                <button type="button" class="session-info-close" data-info-close aria-label="Close">&times;</button>
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

    function render(): void {
        body.innerHTML = buildRows()
            .map(
                (r) => `
                <div class="session-info-row">
                    <span class="session-info-label">${escape(r.label)}</span>
                    <span class="session-info-value">${escape(r.value)}</span>
                    ${r.note ? `<span class="session-info-note">${escape(r.note)}</span>` : ''}
                </div>`
            )
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
