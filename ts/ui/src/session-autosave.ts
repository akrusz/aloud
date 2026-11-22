/**
 * The session views' autosave (views/session.ts, views/noting-session.ts): the
 * transcript written after each turn, so a crash or a killed app still leaves
 * it in History, kept in step with how the session ends.
 *
 * Writes go one after another, so an older snapshot never lands over a newer
 * one. Once the session ends nothing more is written, and the end waits for
 * the write in flight: landing late, it would put a session ended without
 * saving back in History, or a provisional snapshot over the final save.
 */

import type { SessionState } from '../../src/facilitation/index.js';
import type { SessionStoreApi } from '../../src/platform/index.js';

export interface SessionAutosave {
    /** Writes the snapshot after any autosave before it, unless the session
     *  has ended by then. True when it was written; a failure is logged and
     *  the last autosave stands. */
    save(snapshot: SessionState): Promise<boolean>;
    /** The session has ended: nothing more is autosaved. Resolves once the
     *  write in flight, if any, has landed, so the final save comes after it. */
    close(): Promise<void>;
    /** Closes, then deletes the row autosave wrote: a session ended without
     *  saving leaves nothing in History that was not there before it. */
    discard(): Promise<void>;
}

export function sessionAutosave(store: SessionStoreApi): SessionAutosave {
    let writing: Promise<unknown> = Promise.resolve();
    let closed = false;
    // A resumed session runs under an id of its own (SessionManager.startSession),
    // so this is never the row of the session it continued from. Were a resume
    // ever to keep the old id, discard would delete that session.
    let wrote: string | null = null;

    function close(): Promise<void> {
        closed = true;
        return writing.then(() => undefined);
    }

    return {
        save(snapshot) {
            if (closed) return Promise.resolve(false);
            const write = writing
                .then(async () => {
                    if (closed) return false;
                    wrote = snapshot.sessionId;
                    await store.save(snapshot);
                    return true;
                })
                .catch((err: unknown) => {
                    console.warn('Session autosave failed', err);
                    return false;
                });
            writing = write;
            return write;
        },
        close,
        async discard() {
            await close();
            if (wrote !== null) await store.delete(wrote);
        },
    };
}
