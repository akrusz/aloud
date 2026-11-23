/**
 * The prompt ledger's rules (scripts/prompt-ledger/ledger.ts) on made-up
 * pieces. Nothing here reads the real ledger or the real prompts: editing a
 * prompt never fails a test.
 */

import { describe, expect, it } from 'vitest';
import { compare, IdError, mark, resolveId, stamp, type Ledger, type Piece } from '../scripts/prompt-ledger/ledger.js';

const piece = (id: string, hash: string): Piece => ({ id, reach: 'session', file: 'ts/a.ts', hash });
const at = (sha: string) => ({ sha, date: '2026-11-23' });

describe('compare', () => {
    it('reports changed, new and removed pieces, and nothing else', () => {
        const ledger = stamp(null, [piece('a', '1'), piece('b', '2'), piece('c', '3')], at('s1'));
        const d = compare(ledger, [piece('a', '1'), piece('b', '9'), piece('d', '4')]);
        expect(d.changed.map((p) => p.id)).toEqual(['b']);
        expect(d.added.map((p) => p.id)).toEqual(['d']);
        expect(d.removed.map((p) => p.id)).toEqual(['c']);
    });
});

describe('stamp', () => {
    it('starts every piece as baseline', () => {
        const ledger = stamp(null, [piece('a', '1'), piece('b', '2')], at('s1'));
        expect(Object.values(ledger.pieces).map((e) => e.status)).toEqual(['baseline', 'baseline']);
        expect(ledger.stampedAt).toBe('s1');
    });

    it('makes changed and new pieces draft unless Alex is named for them', () => {
        const first = stamp(null, [piece('a', '1'), piece('b', '2'), piece('c', '3')], at('s1'));
        const next = stamp(first, [piece('a', '1'), piece('b', '9'), piece('c', '8'), piece('d', '4')], at('s2'), {
            edited: ['c'],
        });
        expect(next.pieces.a?.status).toBe('baseline');
        expect(next.pieces.b?.status).toBe('draft');
        expect(next.pieces.c?.status).toBe('edited');
        expect(next.pieces.d?.status).toBe('draft');
    });

    it('sends a piece read or edited back to draft when its text changes, saying what it was', () => {
        const first = stamp(null, [piece('a', '1'), piece('b', '2')], at('aaaaaaaa1111'), { read: ['a'], edited: ['b'] });
        const next = stamp(first, [piece('a', '7'), piece('b', '8')], at('s2'));
        expect(next.pieces.a).toMatchObject({ status: 'draft', note: 'was read at aaaaaaaa, changed since' });
        expect(next.pieces.b).toMatchObject({ status: 'draft', note: 'was edited at aaaaaaaa, changed since' });
        const again = stamp(next, [piece('a', '6'), piece('b', '8')], at('s3'), { read: ['b'] });
        expect(again.pieces.a?.note).toBe('was read at aaaaaaaa, changed since');
        expect(again.pieces.b).toEqual({ hash: '8', reach: 'session', file: 'ts/a.ts', status: 'read' });
    });

    it('keeps an unchanged piece as it was, and drops a removed one', () => {
        const first = stamp(null, [piece('a', '1'), piece('b', '2')], at('s1'), { read: ['a'] });
        const next = stamp(first, [piece('a', '1')], at('s2'));
        expect(next.pieces.a?.status).toBe('read');
        expect(next.pieces.b).toBeUndefined();
    });
});

describe('mark', () => {
    const ledger: Ledger = stamp(null, [piece('a', '1')], at('s1'));

    it('records the current text as read, and keeps the stamped text for draft', () => {
        expect(mark(ledger, 'a', 'read', piece('a', '5')).pieces.a).toMatchObject({ status: 'read', hash: '5' });
        expect(mark(ledger, 'a', 'draft', piece('a', '5')).pieces.a).toMatchObject({ status: 'draft', hash: '1' });
    });

    it('refuses to mark a piece that is no longer a prompt as read', () => {
        expect(() => mark(ledger, 'a', 'read', undefined)).toThrow(IdError);
    });
});

describe('resolveId', () => {
    const ids = ['prompts/STEPPING_OUT_FRAGMENT', 'prompts/STEPPING_OUT_NOTE', 'rubric/1a', 'rubric/13', 'jev/trouble'];

    it('takes the id itself, a unique prefix, or a unique part', () => {
        expect(resolveId(ids, 'rubric/13')).toBe('rubric/13');
        expect(resolveId(ids, 'jev/')).toBe('jev/trouble');
        expect(resolveId(ids, 'out_note')).toBe('prompts/STEPPING_OUT_NOTE');
    });

    it('refuses an ambiguous id and names the candidates', () => {
        try {
            resolveId(ids, 'STEPPING_OUT');
            expect.unreachable();
        } catch (err) {
            expect(err).toBeInstanceOf(IdError);
            expect((err as IdError).candidates).toEqual(['prompts/STEPPING_OUT_FRAGMENT', 'prompts/STEPPING_OUT_NOTE']);
            expect((err as Error).message).toContain('prompts/STEPPING_OUT_NOTE');
        }
        expect(() => resolveId(ids, 'rubric/1')).toThrow(IdError);
        expect(() => resolveId(ids, 'nothing-like-it')).toThrow(/No prompt id matches/);
    });
});
