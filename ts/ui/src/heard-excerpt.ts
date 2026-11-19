/**
 * What the setup screen shows of something it heard and could not place:
 * `Heard "…"`, so a mishearing reads as one and not as a dead mic.
 */

/** How much of it is shown, in words (or characters of an unspaced script). */
const SHOWN = { words: 6, chars: 40, han: 12 };
/** Past this it is the room talking (a television, a conversation), and
 *  nothing is shown at all. */
const ROOM = { words: 12, han: 30 };

/** The opening of `text` to show back, or null when it is too long to be
 *  anything said to the app. */
export function heardExcerpt(text: string): string | null {
    const said = text.trim().replace(/[.。!?！？…]+$/u, '');
    if (!said) return null;
    const han = /\p{Script=Han}/u.test(said);
    const units = han ? [...said.replace(/\s+/g, '')] : said.split(/\s+/);
    if (units.length > (han ? ROOM.han : ROOM.words)) return null;
    const whole = units.join(han ? '' : ' ');
    let shown = units.slice(0, han ? SHOWN.han : SHOWN.words).join(han ? '' : ' ');
    if (!han && shown.length > SHOWN.chars) shown = shown.slice(0, SHOWN.chars);
    if (shown === whole) return whole;
    return `${shown.replace(/[\s,，、;；:：-]+$/u, '')}…`;
}
