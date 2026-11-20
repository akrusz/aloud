/**
 * The meditator's preview bubble in a session (views/session.ts listen loop):
 * up from a turn's first speculative transcript until the turn's own bubble
 * takes its place, or the turn is dropped.
 *
 * It used to come down the moment the final transcript arrived, while the
 * turn's own bubble only goes up once the turn is dispatched, and a short turn
 * waits on the command judge first. For that long the words were gone from
 * the screen, then came back (hosted Parakeet on Android, 2026-11-19).
 */

import { isNonSpeechOnly } from '../../src/platform/stt.js';

/** How the bubble is drawn: the view's own message helpers. */
export interface PreviewBubbles<B> {
    add(text: string): B;
    set(bubble: B, text: string): void;
    remove(bubble: B): void;
}

export interface TurnPreview {
    /** A speculative transcript of the turn being heard. `echo`: it reads as
     *  the facilitator's own words, which never show as the meditator's.
     *  Wordless text leaves what is shown alone: it is not newer words. */
    partial(text: string, echo: boolean): void;
    /** The turn's final transcript is in. Kept means the turn goes on to be
     *  dispatched and the preview stays up until `replaceWith`; not kept (no
     *  words, the facilitator's echo, the mic muted meanwhile) takes it down. */
    final(kept: boolean): void;
    /** The turn's own bubble goes up in the preview's place, in one task, so
     *  nothing paints between the two. */
    replaceWith(showTurn: () => void): void;
    /** Take down anything left: a turn dispatched without a bubble of its own
     *  (a "say that again"), or the loop starting over. */
    clear(): void;
}

export function createTurnPreview<B>(bubbles: PreviewBubbles<B>): TurnPreview {
    let shown: B | null = null;
    const clear = (): void => {
        if (shown !== null) bubbles.remove(shown);
        shown = null;
    };
    return {
        partial(text, echo) {
            if (echo) return clear();
            if (isNonSpeechOnly(text)) return;
            if (shown === null) shown = bubbles.add(text);
            else bubbles.set(shown, text);
        },
        final(kept) {
            if (!kept) clear();
        },
        replaceWith(showTurn) {
            clear();
            showTurn();
        },
        clear,
    };
}
