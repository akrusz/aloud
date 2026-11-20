import { describe, it, expect } from 'vitest';

import { createTurnPreview } from '../ui/src/turn-preview.js';

/**
 * The preview bubble's life in a session's listen loop (turn-preview.ts): once
 * a turn's words are on screen they stay until newer words for the same turn
 * replace them, or the turn is dropped.
 */

type Bubble = { text: string; partial: boolean };

/** The transcript as a list of bubbles, top to bottom. */
function transcript() {
    const screen: Bubble[] = [];
    const preview = createTurnPreview<Bubble>({
        add: (text) => {
            const b = { text, partial: true };
            screen.push(b);
            return b;
        },
        set: (b, text) => {
            b.text = text;
        },
        remove: (b) => {
            screen.splice(screen.indexOf(b), 1);
        },
    });
    const showTurn = (text: string) => () => void screen.push({ text, partial: false });
    return { screen, preview, showTurn };
}

describe('the turn preview', () => {
    it('stays up from the final transcript until the turn\'s own bubble replaces it', () => {
        const { screen, preview, showTurn } = transcript();
        preview.partial('A remark on emptiness', false);
        preview.final(true);
        // The command judge is out on a short turn: the words stay.
        expect(screen).toEqual([{ text: 'A remark on emptiness', partial: true }]);
        let seenWhileShowing: Bubble[] = [];
        preview.replaceWith(() => {
            seenWhileShowing = [...screen];
            showTurn('A remark on emptiness.')();
        });
        expect(seenWhileShowing).toEqual([]);
        expect(screen).toEqual([{ text: 'A remark on emptiness.', partial: false }]);
    });

    it('updates one bubble in place as the words grow', () => {
        const { screen, preview } = transcript();
        preview.partial('I notice', false);
        preview.partial('I notice the breath', false);
        expect(screen).toEqual([{ text: 'I notice the breath', partial: true }]);
    });

    it('keeps the words when a later pass comes back wordless', () => {
        const { screen, preview } = transcript();
        preview.partial('I notice', false);
        preview.partial('[BLANK_AUDIO]', false);
        expect(screen).toEqual([{ text: 'I notice', partial: true }]);
    });

    it('shows nothing for a wordless pass on its own', () => {
        const { screen, preview } = transcript();
        preview.partial('(coughs)', false);
        expect(screen).toEqual([]);
    });

    it("comes down when the words turn out to be the facilitator's", () => {
        const { screen, preview } = transcript();
        preview.partial('Notice the breath', false);
        preview.partial('Notice the breath moving', true);
        expect(screen).toEqual([]);
    });

    it('comes down with a turn that is dropped', () => {
        const { screen, preview } = transcript();
        preview.partial('Notice the breath', false);
        preview.final(false);
        expect(screen).toEqual([]);
    });

    it('comes down when the turn showed no bubble of its own', () => {
        const { screen, preview } = transcript();
        preview.partial('Say that again', false);
        preview.final(true);
        preview.clear();
        expect(screen).toEqual([]);
    });

    it('lets a turn with no preview show its bubble', () => {
        const { screen, preview, showTurn } = transcript();
        preview.replaceWith(showTurn('Yes.'));
        expect(screen).toEqual([{ text: 'Yes.', partial: false }]);
    });
});
