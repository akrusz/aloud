/**
 * What the setup screen shows of something it heard and could not place:
 * `Heard "…"`, so a mishearing reads as one and not as a dead mic. The pill
 * cuts it to the room it has (`.voice-start-note.heard` in app-base.css), so
 * nothing here shortens it.
 */

/** Past this it is the room talking (a television, a conversation), and
 *  nothing is shown at all: words, or characters of an unspaced script. */
const ROOM = { words: 12, han: 30 };

/** `text` as it is shown back, or null when it is too long to be anything
 *  said to the app. */
export function heardNote(text: string): string | null {
    const said = text.trim().replace(/[.。!?！？…]+$/u, '');
    if (!said) return null;
    const han = /\p{Script=Han}/u.test(said);
    const length = han ? [...said.replace(/\s+/g, '')].length : said.split(/\s+/).length;
    return length > (han ? ROOM.han : ROOM.words) ? null : said;
}
