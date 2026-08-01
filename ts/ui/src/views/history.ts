/**
 * History view - past sessions with per-row Continue / Copy / Delete; rows
 * expand inline to the transcript. Continue stashes the session id in
 * sessionStorage and routes to setup, which picks it up and hydrates the next
 * session with the old exchanges.
 */

import {
    getMode,
    isSyntheticEventTurn,
    type SessionState,
    type Exchange,
} from '../../../src/facilitation/index.js';
import { sessionStore } from '../state.js';
import { appUrl } from '../app-base.js';
import { confirmDialog } from '../dialog.js';
import { isTauri } from '../is-desktop.js';

export interface HistoryViewHandle {
    show(): Promise<void>;
}

export async function mountHistoryView(
    root: HTMLElement,
    onLeave: () => void
): Promise<HistoryViewHandle> {
    const expanded = new Set<string>();

    async function loadAndRender(): Promise<void> {
        const ids = await sessionStore.list();
        const states = await Promise.all(ids.map((id) => sessionStore.load(id)));
        const sessions = states.filter((s): s is SessionState => s !== null);
        // Newest first by startTime; SessionStore carries no saved-at field.
        sessions.sort((a, b) => b.startTime - a.startTime);

        root.innerHTML = renderShellHTML(sessions);
        wireEvents(sessions);

        // Desktop persists sessions as files (reveal the folder); web offers a
        // JSON download instead.
        const folderBtn = root.querySelector<HTMLButtonElement>('#btn-open-sessions-folder');
        folderBtn?.addEventListener('click', () => {
            void fetch(appUrl('/open-sessions-folder'), { method: 'POST' }).catch(() => {});
        });
        const exportBtn = root.querySelector<HTMLButtonElement>('#btn-export-sessions');
        exportBtn?.addEventListener('click', () => exportSessions(sessions));
    }

    function wireEvents(sessions: readonly SessionState[]): void {
        for (const session of sessions) {
            const item = root.querySelector<HTMLElement>(
                `.session-item[data-session-id="${cssEscape(session.sessionId)}"]`
            );
            if (!item) continue;

            const header = item.querySelector<HTMLElement>('.session-item-header');
            header?.addEventListener('click', () => {
                toggleExpansion(item, session);
            });

            const continueBtn = item.querySelector<HTMLButtonElement>('.btn-continue');
            continueBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                continueSession(session);
            });

            const copyBtn = item.querySelector<HTMLButtonElement>('.btn-copy');
            copyBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                copyTranscript(session, copyBtn);
            });

            const revealBtn = item.querySelector<HTMLButtonElement>('.btn-reveal');
            revealBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                revealSessionFile(session, revealBtn);
            });

            const deleteBtn = item.querySelector<HTMLButtonElement>('.btn-delete');
            deleteBtn?.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!(await confirmDialog('Delete this session permanently?', { okLabel: 'Delete', danger: true })))
                    return;
                await sessionStore.delete(session.sessionId);
                // Fade out before re-rendering so other rows don't jump.
                item.style.transition = 'opacity 0.3s';
                item.style.opacity = '0';
                setTimeout(() => {
                    expanded.delete(session.sessionId);
                    void loadAndRender();
                }, 300);
            });
        }
    }

    function toggleExpansion(item: HTMLElement, session: SessionState): void {
        const id = session.sessionId;
        const body = item.querySelector<HTMLElement>('.session-item-body');
        if (!body) return;
        if (expanded.has(id)) {
            item.classList.remove('open');
            body.classList.add('hidden');
            expanded.delete(id);
        } else {
            item.classList.add('open');
            body.classList.remove('hidden');
            expanded.add(id);
            const tx = body.querySelector<HTMLElement>('.session-transcript');
            if (tx && tx.dataset['loaded'] !== '1') {
                tx.innerHTML = renderTranscript(session.exchanges);
                tx.dataset['loaded'] = '1';
            }
        }
    }

    function continueSession(session: SessionState): void {
        // Setup picks this up via loadQueuedContinuation() and threads it
        // through onBegin.
        if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem('continueFrom', session.sessionId);
            const { summary } = sessionTypeAndSummary(session);
            if (summary) sessionStorage.setItem('continueFromSummary', summary);
            else sessionStorage.removeItem('continueFromSummary');
        }
        onLeave();
    }

    function copyTranscript(session: SessionState, btn: HTMLButtonElement): void {
        const lines: string[] = [];
        for (const ex of session.exchanges) {
            if (ex.role === 'user' && isSyntheticEventTurn(ex.content)) continue;
            const role = ex.name ?? (ex.role === 'assistant' ? 'Facilitator' : 'You');
            lines.push(`${role}\n${ex.content}`);
        }
        const text = lines.join('\n\n');
        if (!text) return;
        const original = btn.textContent;
        const restore = () => setTimeout(() => (btn.textContent = original), 1500);
        navigator.clipboard
            .writeText(text)
            .then(() => {
                btn.textContent = 'Copied';
                restore();
            })
            .catch(() => {
                btn.textContent = 'Copy failed';
                restore();
            });
    }

    await loadAndRender();
    return { show: loadAndRender };
}

/** Reveal this session's JSON file on disk (desktop only). A missing file
 *  (never saved) flips the label briefly rather than failing silently. */
function revealSessionFile(session: SessionState, btn: HTMLButtonElement): void {
    const original = btn.textContent;
    fetch(appUrl(`/open-session-file/${encodeURIComponent(session.sessionId)}`), { method: 'POST' })
        .then((res) => {
            if (res.ok) return;
            btn.textContent = 'Not on disk';
            setTimeout(() => (btn.textContent = original), 1500);
        })
        .catch(() => {
            btn.textContent = "Couldn't open";
            setTimeout(() => (btn.textContent = original), 1500);
        });
}

/** Download all saved sessions as one JSON file (web only; desktop reveals the
 *  on-disk sessions folder instead). */
function exportSessions(sessions: readonly SessionState[]): void {
    try {
        const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `aloud-sessions-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (err) {
        console.warn('Session export failed', err);
    }
}

// ---- rendering ----

function renderShellHTML(sessions: readonly SessionState[]): string {
    const header = `
        <div class="history-header">
            <h1>Past Sessions</h1>
            ${
                sessions.length === 0
                    ? ''
                    : isTauri()
                      ? `<button class="btn-config-path" id="btn-open-sessions-folder" type="button">Open sessions folder</button>`
                      : `<button class="btn-config-path" id="btn-export-sessions" type="button">Export sessions</button>`
            }
        </div>`;

    const body =
        sessions.length === 0
            ? `<div id="empty-state" class="empty-state">
                   <p>No saved sessions yet.</p>
                   <p class="muted">Sessions you end with at least one turn show up here.</p>
               </div>`
            : `<div class="session-list" id="session-list">${sessions.map(renderItem).join('')}</div>`;

    return `<div class="history-container">${header}${body}</div>`;
}

/**
 * Meditation type + display summary, tolerating legacy data: sessions saved
 * before `meditationType` existed stored the literal `"noting circle"` in
 * `notes` (the LLM-summary slot), so infer the type and drop it as a summary.
 */
function sessionTypeAndSummary(session: SessionState): { typeLabel: string; summary: string } {
    const rawNotes = session.notes ?? '';
    const legacyNoting = !session.meditationType && rawNotes === 'noting circle';
    const type = session.meditationType ?? (legacyNoting ? 'noting' : undefined);
    const mode = getMode(type);
    return {
        // A mode this build doesn't know (removed, or newer) shows no label.
        typeLabel: mode ? (mode.historyLabel ?? mode.label) : '',
        summary: legacyNoting ? '' : rawNotes,
    };
}

function renderItem(session: SessionState): string {
    const dateText = formatDate(session.startTime);
    const durationText = formatDuration(session);
    const turnCount = session.exchanges.length;
    const { typeLabel, summary } = sessionTypeAndSummary(session);
    const meta =
        `${durationText} · ${turnCount} exchanges` + (typeLabel ? ` · ${typeLabel}` : '');

    return `
    <div class="session-item" data-session-id="${attr(session.sessionId)}" data-summary="${attr(summary)}">
        <div class="session-item-header">
            <div class="session-item-info">
                <span class="session-date">${escape(dateText)}</span>
                <span class="session-meta">${escape(meta)}</span>
                ${summary ? `<span class="session-summary">${escape(summary)}</span>` : ''}
            </div>
            <span class="session-expand">&#9662;</span>
        </div>
        <div class="session-item-body hidden">
            <div class="session-transcript" data-loaded="0">
                <p class="loading-text">Loading...</p>
            </div>
            <div class="session-actions">
                <button type="button" class="btn btn-secondary btn-small btn-continue">Continue from here</button>
                <button type="button" class="btn btn-secondary btn-small btn-copy">Copy text</button>
                ${isTauri() ? `<button type="button" class="btn btn-secondary btn-small btn-reveal">Open on disk</button>` : ''}
                <button type="button" class="btn btn-danger btn-small btn-delete">Delete</button>
            </div>
        </div>
    </div>`;
}

function renderTranscript(exchanges: readonly Exchange[]): string {
    if (exchanges.length === 0) {
        return '<p class="loading-text">No exchanges recorded.</p>';
    }
    return exchanges
        // Synthetic check-in events are model context, not the user speaking.
        .filter((ex) => !(ex.role === 'user' && isSyntheticEventTurn(ex.content)))
        .map((ex) => {
            const role = ex.name ?? (ex.role === 'assistant' ? 'Facilitator' : 'You');
            return `
            <div class="transcript-message">
                <div class="transcript-role ${ex.role}">${escape(role)}</div>
                <div class="transcript-text">${escape(ex.content)}</div>
            </div>`;
        })
        .join('');
}

function formatDate(startTime: number): string {
    const d = new Date(startTime * 1000);
    return d.toLocaleDateString(undefined, {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
    });
}

function formatDuration(s: SessionState): string {
    const end = s.endTime ?? s.startTime;
    const seconds = Math.max(0, Math.round(end - s.startTime));
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins === 0) return `${secs}s`;
    return `${mins}m ${secs}s`;
}

function escape(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
    );
}

function attr(s: string): string {
    return escape(s);
}

function cssEscape(s: string): string {
    return s.replace(/"/g, '\\"');
}
