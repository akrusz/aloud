/**
 * The hesitation sound a recognizer writes ahead of a command: "Uh, next.",
 * "Um, never mind.", 嗯，下一步. GPT never writes one; Parakeet, the English
 * default, does (13 of 299 clips, twice leading; meditation-pal-0ntn). The
 * on-device matchers read the whole utterance, so a command behind one read
 * as nothing, and the intention question took "Uh, never mind." as the
 * intention.
 */

/**
 * One English hesitation sound, stretched or not: uh, um, uhm, er, erm, ah,
 * hm, hmm, mm. A regex source, also inside setup-command.ts's `LEAVE_LEAD`.
 * Not "oh", which says something ("oh no", "oh, wait"): only the softeners
 * ahead of a leave take it, and they did before this.
 */
export const HESITATION_WORD = '(?:u+h+|u+h*m+|e+r+m*|a+h+|h+m+|m{2,})';

/** 嗯 and 呃, and 额 (額), which is written for 呃. */
const ZH_HESITATION = '[嗯呃额額]';

const OPENING_RE = new RegExp(
    `^[^\\p{L}\\p{N}]*(?:${HESITATION_WORD}(?![\\p{L}\\p{N}'])|${ZH_HESITATION})[^\\p{L}\\p{N}]*`,
    'iu'
);

/**
 * The utterance without the hesitation sounds it opens on, or unchanged when
 * they are all there is: "Uh." still matches nothing, and a bare 嗯 is a yes
 * to the end question (end-command.ts). Only the opening; what comes later is
 * each matcher's own business.
 */
export function skipHesitation(utterance: string): string {
    let rest = utterance;
    for (let m = OPENING_RE.exec(rest); m; m = OPENING_RE.exec(rest)) rest = rest.slice(m[0].length);
    return /[\p{L}\p{N}]/u.test(rest) ? rest : utterance;
}
