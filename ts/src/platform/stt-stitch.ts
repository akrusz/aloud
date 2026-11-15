/**
 * Joining a turn's transcript from pieces: incremental transcription sends
 * only the audio since the last pass, with the text so far as the model's
 * `prompt`, and stitches the replies together (meditation-pal-12q9).
 *
 * No guard against the model echoing its prompt: on a real session it never
 * did, and the guard's only catches were phrases the speaker really said twice.
 *
 * Its one import, end-of-turn.ts, is dependency-free like stt.ts.
 */

import { endsOnDanglingWord } from '../facilitation/end-of-turn.js';

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;

/** The turn's text so far joined with the next piece's. */
export function joinTranscripts(prev: string, next: string): string {
    let head = prev.trim();
    let tail = next.trim();
    if (!head) return tail;
    if (!tail) return head;
    // A period before a piece marks only where the previous clip ended when
    // the piece goes on in lowercase, or when the clip closed on a word no
    // sentence ends on ("think about. My brother"): then the piece's capital
    // is the clip's too, except on "I". An ellipsis stays.
    if (/(?:^|[^.])\.$/u.test(head)) {
        if (/^\p{Ll}/u.test(tail)) head = head.slice(0, -1);
        else if (/^\p{Lu}/u.test(tail) && !/^I(?!\p{L})/u.test(tail) && endsOnDanglingWord(head)) {
            head = head.slice(0, -1);
            tail = tail.replace(/^\p{Lu}/u, (c) => c.toLowerCase());
        }
    }
    const glue = CJK.test(head.slice(-1)) && CJK.test(tail[0]!) ? '' : ' ';
    return head + glue + tail;
}

/** The tail of `text` to send as the next piece's prompt: at most `maxChars`
 *  code points, starting on a word boundary in spaced scripts. Counted by code
 *  point so the cut never splits a surrogate pair, which encodeURIComponent
 *  would throw on. */
export function priorPrompt(text: string, maxChars = 400): string {
    const chars = Array.from(text.trim());
    if (chars.length <= maxChars) return chars.join('');
    const inWord = (ch: string | undefined): boolean => !!ch && /\S/u.test(ch) && !CJK.test(ch);
    let start = chars.length - maxChars;
    while (start < chars.length && inWord(chars[start - 1]) && inWord(chars[start])) start++;
    return chars.slice(start).join('').trim();
}
