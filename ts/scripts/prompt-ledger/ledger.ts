/**
 * The prompt ledger's rules, apart from git and the registry so they can be
 * tested on made-up pieces: what differs from the ledger, what a restamp or a
 * mark records, and which piece a typed id means.
 */

import { createHash } from 'node:crypto';

/** Where a prompt runs (dev-docs/prompt-writing.md, "When you touch a prompt"). */
export type Reach = 'session' | 'support' | 'dev';

/** baseline: in the app when the ledger began; draft: written or changed by
 *  an agent, not yet read by Alex; read: he said he read it; edited: the
 *  wording is his. */
export type Status = 'baseline' | 'draft' | 'read' | 'edited';
export const STATUSES: readonly Status[] = ['baseline', 'draft', 'read', 'edited'];

export interface Piece {
    id: string;
    reach: Reach;
    file: string;
    hash: string;
}

export interface Entry {
    hash: string;
    reach: Reach;
    file: string;
    status: Status;
    note?: string;
}

export interface Ledger {
    stampedAt: string;
    stampedOn: string;
    pieces: Record<string, Entry>;
}

export const hashText = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

export interface Differences {
    changed: Piece[];
    added: Piece[];
    removed: Array<Entry & { id: string }>;
}

export function compare(ledger: Ledger, current: readonly Piece[]): Differences {
    const ids = new Set(current.map((p) => p.id));
    return {
        changed: current.filter((p) => ledger.pieces[p.id] && ledger.pieces[p.id]!.hash !== p.hash),
        added: current.filter((p) => !ledger.pieces[p.id]),
        removed: Object.entries(ledger.pieces)
            .filter(([id]) => !ids.has(id))
            .map(([id, e]) => ({ id, ...e })),
    };
}

/** The ledger at a new commit. The first stamp makes every piece baseline;
 *  after that a changed or new piece is draft unless Alex is named for it. */
export function stamp(
    prev: Ledger | null,
    current: readonly Piece[],
    at: { sha: string; date: string },
    named: { read?: readonly string[]; edited?: readonly string[] } = {}
): Ledger {
    const pieces: Record<string, Entry> = {};
    for (const p of current) {
        const was = prev?.pieces[p.id];
        const entry: Entry = { hash: p.hash, reach: p.reach, file: p.file, status: 'draft' };
        if (named.edited?.includes(p.id)) entry.status = 'edited';
        else if (named.read?.includes(p.id)) entry.status = 'read';
        else if (!prev) entry.status = 'baseline';
        else if (was && was.hash === p.hash) {
            entry.status = was.status;
            if (was.note) entry.note = was.note;
        } else if (was?.status === 'read' || was?.status === 'edited') {
            entry.note = `was ${was.status} at ${prev.stampedAt.slice(0, 8)}, changed since`;
        } else if (was?.note) {
            entry.note = was.note;
        }
        pieces[p.id] = entry;
    }
    return { stampedAt: at.sha, stampedOn: at.date, pieces };
}

/** One piece's status, without a restamp. Read or edited records the text as
 *  it is now (`piece`), since that is the text Alex saw; draft keeps the
 *  ledger's, so a change since the stamp still shows. */
export function mark(ledger: Ledger, id: string, status: Exclude<Status, 'baseline'>, piece: Piece | undefined): Ledger {
    const was = ledger.pieces[id];
    const base = status === 'draft' ? (was ?? piece) : piece;
    if (!base) throw new IdError(`"${id}" is no longer a prompt, so it cannot be marked ${status}.`, []);
    const entry: Entry = { hash: base.hash, reach: base.reach, file: base.file, status };
    if (status === 'draft' && was?.note) entry.note = was.note;
    return { ...ledger, pieces: { ...ledger.pieces, [id]: entry } };
}

export class IdError extends Error {
    constructor(
        message: string,
        readonly candidates: readonly string[]
    ) {
        super(message);
    }
}

/** The id itself, else the one id it starts, else the one id holding it
 *  (ignoring case). Refuses an ambiguous one, naming the candidates. */
export function resolveId(ids: readonly string[], query: string): string {
    if (ids.includes(query)) return query;
    const q = query.toLowerCase();
    const prefixed = ids.filter((id) => id.toLowerCase().startsWith(q));
    const found = prefixed.length ? prefixed : ids.filter((id) => id.toLowerCase().includes(q));
    if (found.length === 1) return found[0]!;
    if (found.length === 0) {
        throw new IdError(`No prompt id matches "${query}". Every id is listed in ts/prompt-ledger.json.`, []);
    }
    throw new IdError(`"${query}" matches ${found.length} prompts; give more of the id:\n  ${found.join('\n  ')}`, found);
}
