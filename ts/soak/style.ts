/**
 * Counts beside the judge's "holds the session" (rubric dimension 12), free
 * on every session: how often a reply ends in a question, the opening a
 * facilitator keeps reaching for, whether replies grow over the sit, and for a
 * scenario with callbacks whether the early particulars came back after their
 * cue. Numbers for a reader, never verdicts: the judge decides whether a
 * question was the right move or an early word was used well.
 */

import type { SessionCallback, SessionRunResult, SessionStyle, TurnRecord } from './types.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

/** Word-like segments, so Chinese counts words too, not one run of characters. */
export function wordsOf(text: string): string[] {
    return [...segmenter.segment(text)].filter((s) => s.isWordLike).map((s) => s.segment.toLowerCase());
}

export function endsInQuestion(text: string): boolean {
    return /[?？]["'”’)\s]*$/.test(text.trim());
}

function median(xs: number[]): number | null {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

const facilitatorReplies = (result: SessionRunResult): TurnRecord[] =>
    result.transcript.filter((t) => t.role === 'assistant' && t.kind === 'reply' && t.text.trim());

/** The most frequent first three words, first seen winning a tie. */
function topOpening(replies: TurnRecord[]): SessionStyle['topOpening'] {
    const counts = new Map<string, number>();
    for (const r of replies) {
        const opening = wordsOf(r.text).slice(0, 3).join(' ');
        if (opening) counts.set(opening, (counts.get(opening) ?? 0) + 1);
    }
    let best: SessionStyle['topOpening'] = null;
    for (const [words, count] of counts) if (!best || count > best.count) best = { words, count };
    return best;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface CallbackOutcome {
    callback: SessionCallback;
    early: TurnRecord | undefined;
    cue: TurnRecord | undefined;
    /** The first facilitator line after the cue carrying an echo word. */
    echo: TurnRecord | undefined;
    /** Its place among the facilitator lines after the cue, from 1. */
    echoedAfter: number | null;
    /** Facilitator lines after the cue. */
    linesAfterCue: number;
    /** The meditator said an echo word again after the cue, before the
     *  facilitator did: an echo past that point repeats them, so it is not
     *  counted. */
    meditatorFirst: TurnRecord | undefined;
}

/** Where each callback's early line, cue and echo fell. */
export function callbackOutcomes(result: SessionRunResult): CallbackOutcome[] {
    const t = result.transcript;
    const said = (text: string, phrase: string): boolean => text.toLowerCase().includes(phrase.toLowerCase());
    return (result.scenario.callbacks ?? []).map((callback) => {
        const early = t.find((x) => x.role === 'user' && x.kind === 'user' && said(x.text, callback.early));
        const after = early ? t.slice(t.indexOf(early) + 1) : [];
        const cue = after.find((x) => x.role === 'user' && x.kind === 'user' && said(x.text, callback.cue));
        const echoRe = new RegExp(`\\b(?:${callback.echo.map(escape).join('|')})\\b`, 'i');
        const rest = cue ? t.slice(t.indexOf(cue) + 1) : [];
        let seen = 0;
        let echo: TurnRecord | undefined;
        let meditatorFirst: TurnRecord | undefined;
        for (const x of rest) {
            if (x.role === 'assistant' && x.text.trim()) {
                seen++;
                if (echoRe.test(x.text)) {
                    echo = x;
                    break;
                }
            } else if (x.role === 'user' && x.kind === 'user' && echoRe.test(x.text)) {
                meditatorFirst = x;
                break;
            }
        }
        return {
            callback,
            early,
            cue,
            echo,
            echoedAfter: echo ? seen : null,
            linesAfterCue: rest.filter((x) => x.role === 'assistant' && x.text.trim()).length,
            meditatorFirst,
        };
    });
}

/** A session's replies, and those in the first and last third of its time. */
export interface ReplyThirds {
    all: TurnRecord[];
    first: TurnRecord[];
    last: TurnRecord[];
}

export function replyThirds(result: SessionRunResult): ReplyThirds {
    const all = facilitatorReplies(result);
    const third = result.fakeDurationSec / 3;
    return { all, first: all.filter((r) => r.at <= third), last: all.filter((r) => r.at >= 2 * third) };
}

/** The counts over replies; several sessions' thirds concatenated pool them. */
export function styleOf({ all, first, last }: ReplyThirds): Omit<SessionStyle, 'callbacks'> {
    const wordCount = (r: TurnRecord): number => wordsOf(r.text).length;
    return {
        replies: all.length,
        questionShare: all.length ? all.filter((r) => endsInQuestion(r.text)).length / all.length : null,
        topOpening: topOpening(all),
        medianWordsFirstThird: median(first.map(wordCount)),
        medianWordsLastThird: median(last.map(wordCount)),
    };
}

export function sessionStyle(result: SessionRunResult): SessionStyle {
    const style: SessionStyle = styleOf(replyThirds(result));
    if (result.scenario.callbacks?.length) {
        style.callbacks = callbackOutcomes(result).map((o) => ({
            id: o.callback.id,
            saidEarly: o.early !== undefined,
            cued: o.cue !== undefined,
            echoedAfter: o.echoedAfter,
            meditatorFirst: o.meditatorFirst !== undefined,
        }));
    }
    return style;
}
