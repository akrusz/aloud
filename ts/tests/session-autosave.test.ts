/**
 * The session views' autosave (ui/src/session-autosave.ts) against a real
 * SessionStore: "End Without Saving" leaves no row behind, even with a save
 * still in flight, and a resumed session never takes the one it continued.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildResumeContext } from '../src/facilitation/resume.js';
import { SessionManager, type SessionState } from '../src/facilitation/session.js';
import { InMemoryKvStorage } from '../src/platform/storage.js';
import { SessionStore, type SessionStoreApi } from '../src/platform/session-store.js';
import { sessionAutosave } from '../ui/src/session-autosave.js';

function sit(id: string, said: string[] = ['hello']): SessionState {
    return {
        sessionId: id,
        startTime: 0,
        endTime: 60,
        exchanges: said.map((content, i) => ({ role: 'user' as const, content, timestamp: i })),
        notes: '',
        usage: {
            llmCalls: 0,
            llmTokensIn: 0,
            llmTokensOut: 0,
            llmCacheRead: 0,
            llmCacheCreation: 0,
            sttSeconds: 0,
            ttsChars: 0,
        },
    };
}

/** A SessionStore whose saves wait for `release()`, as a slow disk or the
 *  desktop shell's HTTP round trip would. */
function slowStore(): { store: SessionStoreApi; inner: SessionStore; release: () => void; calls: string[] } {
    const inner = new SessionStore(new InMemoryKvStorage());
    const calls: string[] = [];
    let gates: Array<() => void> = [];
    const store: SessionStoreApi = {
        save: async (state) => {
            calls.push(`save:${state.sessionId}:${state.exchanges.length}`);
            await new Promise<void>((resolve) => gates.push(resolve));
            await inner.save(state);
            calls.push(`saved:${state.sessionId}:${state.exchanges.length}`);
        },
        load: (id) => inner.load(id),
        delete: async (id) => {
            calls.push(`delete:${id}`);
            await inner.delete(id);
        },
        list: () => inner.list(),
    };
    const release = (): void => {
        const open = gates;
        gates = [];
        open.forEach((go) => go());
    };
    return { store, inner, release, calls };
}

/** Lets queued promise callbacks run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.restoreAllMocks());

describe('sessionAutosave', () => {
    it('discards the row autosave wrote', async () => {
        const store = new SessionStore(new InMemoryKvStorage());
        const autosave = sessionAutosave(store);
        expect(await autosave.save(sit('a'))).toBe(true);
        expect(await store.list()).toEqual(['a']);
        await autosave.discard();
        expect(await store.list()).toEqual([]);
        expect(await store.load('a')).toBeNull();
    });

    it('waits out a save in flight before it deletes, so the row is not written back', async () => {
        const { store, inner, release, calls } = slowStore();
        const autosave = sessionAutosave(store);
        const saving = autosave.save(sit('a'));
        await settle();
        const discarding = autosave.discard();
        await settle();
        expect(calls).toEqual(['save:a:1']);
        release();
        await Promise.all([saving, discarding]);
        expect(calls).toEqual(['save:a:1', 'saved:a:1', 'delete:a']);
        expect(await inner.list()).toEqual([]);
    });

    it('starts no save once closed, and drops one queued behind the write in flight', async () => {
        const { store, inner, release, calls } = slowStore();
        const autosave = sessionAutosave(store);
        const first = autosave.save(sit('a', ['one']));
        const queued = autosave.save(sit('a', ['one', 'two']));
        await settle();
        const closed = autosave.close();
        expect(await autosave.save(sit('a', ['one', 'two', 'three']))).toBe(false);
        release();
        await closed;
        expect(await first).toBe(true);
        expect(await queued).toBe(false);
        expect(calls).toEqual(['save:a:1', 'saved:a:1']);
        // What the final save then writes is what stays.
        await inner.save(sit('a', ['final']));
        expect((await inner.load('a'))?.exchanges.map((e) => e.content)).toEqual(['final']);
    });

    it('writes one snapshot after another, never an older over a newer', async () => {
        const { store, inner, release, calls } = slowStore();
        const autosave = sessionAutosave(store);
        const first = autosave.save(sit('a', ['one']));
        const second = autosave.save(sit('a', ['one', 'two']));
        await settle();
        expect(calls).toEqual(['save:a:1']);
        release();
        await first;
        await settle();
        release();
        await second;
        expect(calls).toEqual(['save:a:1', 'saved:a:1', 'save:a:2', 'saved:a:2']);
        expect((await inner.load('a'))?.exchanges).toHaveLength(2);
    });

    it('deletes nothing when nothing was autosaved (Save session logs off)', async () => {
        const store = new SessionStore(new InMemoryKvStorage());
        await store.save(sit('earlier'));
        const remove = vi.spyOn(store, 'delete');
        await sessionAutosave(store).discard();
        expect(remove).not.toHaveBeenCalled();
        expect(await store.list()).toEqual(['earlier']);
    });

    it('still deletes after a failed save, which may have written part of the row', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const store = new SessionStore(new InMemoryKvStorage());
        const remove = vi.spyOn(store, 'delete');
        vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk full'));
        const autosave = sessionAutosave(store);
        expect(await autosave.save(sit('a'))).toBe(false);
        await autosave.discard();
        expect(remove).toHaveBeenCalledWith('a');
    });

    it('leaves the session a discarded resume continued from as it was', async () => {
        const store = new SessionStore(new InMemoryKvStorage());
        const earlier = sit('earlier', ['first sit']);
        await store.save(earlier);
        // A resume as views/session.ts runs one: a new session seeded with the
        // earlier one's context.
        const session = new SessionManager({ contextStrategy: 'full' });
        session.startSession('exploration');
        session.loadExchanges(buildResumeContext(earlier, false));
        session.addUserMessage('back again');
        const resumed = session.state!;
        expect(resumed.sessionId).not.toBe('earlier');

        const autosave = sessionAutosave(store);
        await autosave.save({ ...resumed });
        expect((await store.list()).sort()).toEqual(['earlier', resumed.sessionId].sort());
        await autosave.discard();
        expect(await store.list()).toEqual(['earlier']);
        expect(await store.load('earlier')).toEqual(earlier);
    });
});
