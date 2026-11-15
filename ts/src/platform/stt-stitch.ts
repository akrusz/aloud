/**
 * Joining a turn's transcript from pieces: incremental transcription sends
 * only the audio since the last pass, with the text so far as the model's
 * `prompt`, and stitches the replies together (meditation-pal-12q9).
 *
 * No guard against the model echoing its prompt: on a real session it never
 * did, and the guard's only catches were phrases the speaker really said twice.
 *
 * Dependency-free, like stt.ts.
 */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;

/** The turn's text so far joined with the next piece's. */
export function joinTranscripts(prev: string, next: string): string {
    const head = prev.trim();
    const tail = next.trim();
    if (!head) return tail;
    if (!tail) return head;
    const glue = CJK.test(head.slice(-1)) && CJK.test(tail[0]!) ? '' : ' ';
    return head + glue + tail;
}

/** The tail of `text` to send as the next piece's prompt: at most `maxChars`,
 *  starting on a word boundary in spaced scripts. */
export function priorPrompt(text: string, maxChars = 400): string {
    const t = text.trim();
    if (t.length <= maxChars) return t;
    const inWord = (ch: string | undefined): boolean => !!ch && /\S/u.test(ch) && !CJK.test(ch);
    let start = t.length - maxChars;
    while (start < t.length && inWord(t[start - 1]) && inWord(t[start])) start++;
    return t.slice(start).trim();
}
