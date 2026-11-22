/**
 * The model's reasoning, kept from the speaker. It reaches a reply in three
 * shapes: a closed block (<think>…</think>), a closing tag whose opening one
 * was in the prompt (Qwen-style chat templates: bonsai-2, and Kimi K2 on a
 * hard turn; meditation-pal-wgtb), and reasoning with no tags at all
 * (meditation-pal-dqti). The first two come off the text (stripReasoning);
 * the third makes the whole reply unusable (isReasoningAloud), and callers
 * treat it as a blank completion.
 */

const TAG = 'think|thinking|reasoning|scratchpad';

/**
 * A reasoning block and its CONTENTS - local models reason in <think> by
 * default (deepseek-r1, qwen3), and a hosted one told not to think can still
 * leak a <thinking>. Dropping only the tags would leave the reasoning to be
 * read aloud, which is worse.
 */
const REASONING_BLOCK_RE = new RegExp(String.raw`<(${TAG})\b[^>]*>[\s\S]*?<\/\1\s*>`, 'gi');

/**
 * Everything up to the last closing tag left once the closed blocks are gone.
 * A closing tag with no opening one means the opening was in the prompt, so
 * all of it is reasoning; with nothing after the tag the reply is empty.
 *
 * The opposite case keeps the older choice: an OPENING tag that never closes
 * (reasoning cut off by the token cap) only loses its tag (XML_TAG_RE in
 * modes.ts) and its words are spoken, since a stray spoken line beats a
 * silent turn, unless they read as reasoning (isReasoningAloud). A lone
 * closing tag leaves no doubt about what came before it, and the reply, if
 * any, is what follows it.
 */
const THROUGH_LONE_CLOSE_RE = new RegExp(String.raw`^[\s\S]*<\/(?:${TAG})\s*>`, 'i');
const LONE_CLOSE_G = new RegExp(String.raw`<\/(?:${TAG})\s*>`, 'gi');
const OPEN_TAG_RE = new RegExp(String.raw`<(?:${TAG})\b[^>]*>`, 'i');

/** `text` without its reasoning blocks, and without everything up to a
 *  closing reasoning tag that has no opening one. */
export function stripReasoning(text: string): string {
    return text.replace(REASONING_BLOCK_RE, ' ').replace(THROUGH_LONE_CLOSE_RE, ' ');
}

/**
 * What of a reply still streaming may be spoken so far: stripReasoning's text,
 * cut at an opening tag still waiting for its close, so nothing inside an open
 * block is voiced before the block is known to be reasoning. `loneCloses`
 * counts the closing tags that had no opening one; when it grows, everything
 * before was reasoning, the words already handed to the voice included.
 * `final` (the stream is over) drops the cut: a block that never closed keeps
 * its words, as stripReasoning does.
 */
export function speakableSoFar(text: string, final = false): { text: string; loneCloses: number } {
    const unblocked = text.replace(REASONING_BLOCK_RE, ' ');
    const loneCloses = unblocked.match(LONE_CLOSE_G)?.length ?? 0;
    const rest = loneCloses > 0 ? unblocked.replace(THROUGH_LONE_CLOSE_RE, ' ') : unblocked;
    const open = final ? null : OPEN_TAG_RE.exec(rest);
    return { text: open ? rest.slice(0, open.index) : rest, loneCloses };
}

// Where a sentence starts: the text's start, a line break, or after a sentence
// end. Untagged reasoning announces itself in its first sentence.
const SENTENCE_START = String.raw`(?:^|\n|[.!?…]["'”’)\]]*\s)\s*`;
const LEAD_IN = String.raw`(?:(?:okay|ok|alright|all right|so|hmm+|well|now)[,.!]?\s+)*`;
// ...and that sentence never says "you": an echo of the meditator's own words
// ("The user said your design was too complex") is addressed to them.
const NO_YOU = String.raw`(?![^.!?\n]*\byou(?:r|rs|rself)?\b)`;
const ZH_NO_YOU = String.raw`(?![^。！？!?\n]*你)`;

/**
 * Reasoning shapes, each one speech addressed to the meditator cannot take: a
 * facilitator says "you", so a sentence that opens on the user or the
 * meditator in the third person, goes on to what they are doing or said, and
 * has no "you" in it is the model reading the transcript ("The user is
 * describing dissociation...", Kimi K2; "The user wants a brief, natural
 * opening...", an opener from Claude). Kept to the sentence's opening and to
 * those verbs because "the user" can turn up inside a real reply about the app
 * ("...until the user stops speaking"). Then the model planning its own reply:
 * "I should:" over a list, "my response should...".
 *
 * 中文: a sentence with no 你 that opens on 用户 ("user") and a verb of saying
 * or wanting ("用户描述了…", "好的，用户说…"), and "我的回应应该…" /
 * "我应该：". Never 冥想者 ("meditator"): "冥想者感到困倦很常见" is ordinary
 * speech.
 *
 * Measured with no false positive over every saved facilitator line
 * (meditation-pal-dqti); a false positive silences a good reply, so widen
 * only against that corpus.
 */
const REASONING_ALOUD_RE = new RegExp(
    [
        String.raw`${SENTENCE_START}${NO_YOU}${LEAD_IN}the (?:user|meditator)\s+(?:(?:is|was)\s+[a-z]+ing\b|(?:wants|wanted|says|said|seems|seemed|appears|describes|described|mentions|mentioned|reports|reported|asks|asked|expresses|expressed|shares|shared|feels|felt|needs|just|has (?:just|been|said|described|shared|mentioned|asked|expressed))\b)`,
        String.raw`\bI (?:should|need to|will|must|want to|could)\s*:`,
        String.raw`\bmy (?:response|reply) (?:should|needs to|must|has to)\b`,
        String.raw`(?:^|\n|[。！？!?])\s*${ZH_NO_YOU}(?:(?:好的|好|嗯|那么|所以|首先)[，,、]?\s*)?用户(?:正在|现在|刚才|刚刚|似乎|好像|在|又|还)?(?:描述|说|提到|表示|表达|分享|感到|觉得|想要|想|希望|问|询问|请求|报告|的意思)`,
        String.raw`我的回[应复答](?:应该|需要|要)|我(?:应该|需要|要)[：:]`,
    ].join('|'),
    'i'
);

/**
 * True when `text` (a reply with its reasoning blocks and control tokens
 * already removed, or one sentence of it) is the model's reasoning rather than
 * words for the meditator. Such a reply is never spoken or stored: callers
 * handle it as a blank completion.
 */
export function isReasoningAloud(text: string): boolean {
    return REASONING_ALOUD_RE.test(text);
}
