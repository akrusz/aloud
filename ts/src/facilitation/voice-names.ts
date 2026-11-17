/**
 * A hosted voice's name as a Chinese sentence says it, and as a Chinese
 * recognizer writes it. The catalog names are Latin (server voice-catalog.ts),
 * which is right for display and storage and wrong in two places:
 *
 * - Spoken: a zh line read "我是 Yunfan" letter by letter, an English word in
 *   a Chinese voice, so the one accented word in the line was its own name.
 *   `zhSpokenName` gives the line the name in characters instead.
 * - Heard: a zh recognizer writes what was said in characters (云帆, 雲帆,
 *   云凡 ...), and the matchers (setup-pick.ts, tour-command.ts) looked for
 *   the Latin name in the text. `zhSaysName` reads those spellings.
 *
 * - Shown: the zh UI calls a voice what its lines call it
 *   (`displayVoiceName`), so 云帆 on the screen is 云帆 out loud. Storage, the
 *   server and every English screen keep the catalog name.
 *
 * Only the house voices of a zh session are here; a voice that isn't keeps its
 * Latin name in both directions. Matched on simplified text (zh-script.ts).
 */

interface ZhName {
    /** What a zh line says and the zh UI shows. Latin where the name is
     *  foreign to Chinese too. */
    said: string;
    /** The characters a recognizer may write for it, anywhere in what was
     *  said, by syllable: each class is one syllable's homophones (tones and a
     *  soft n/ng aside) and what local Whisper was seen to write for it. */
    heard: RegExp;
    /** Spellings that are everyday words too (缘分, 远方) or barely the name:
     *  they count only as the whole answer, with nothing around them but the
     *  words of a pick (`PICK_WORDS`), so a sentence that contains one picks
     *  nothing. */
    loose?: RegExp;
    /** How a zh recognizer spells it in Latin letters, as one lowercase word
     *  with hyphens taken out (regex source, matched whole). */
    latin?: string;
}

const ZH_NAMES: Readonly<Record<string, ZhName>> = {
    // Azure gives no characters (its voices/list LocalName is "Yunfan Dragon
    // HD Latest", where the older voices have 云希, 云健); 云帆 is the usual
    // name spelled yún fān, and the 云 matches Azure's other male voices.
    Yunfan: {
        said: '云帆',
        // Measured on local Whisper (base, zh, unprompted), 2026-11-17: for
        // yún it also writes yuán (元, 原, 圆, 远, 缘, 援), yín (银) and yǒng
        // (勇), most of all from male voices, and for fān it writes fēn (芬,
        // 分, 粉, 氛), fāng (芳) and shān (山), seen after 云 only. Any other
        // pairing of those is loose: 缘分, 远方 and 均匀分布 are everyday
        // words.
        heard: /[云允运韵芸匀耘昀晕蕴元原圆园员源远院愿缘援银勇][帆凡翻番繁范饭烦泛樊藩反返犯]|云[芬分粉氛纷方芳放山]/u,
        loose: /[云允运韵芸匀耘昀晕蕴元原圆园员源远院愿缘援银音勇余于人一您][帆凡翻番繁范饭烦泛樊藩反返犯潘芬分粉氛纷方芳放山三酸]/u,
    },
    // An English name, which a Chinese sentence keeps as one (people with
    // English names are introduced that way), so the line says "Serena". Said
    // back it may still come out as a transliteration: 瑟琳娜, 塞雷娜, 赛琳娜.
    Serena: {
        said: 'Serena',
        // Said in a Chinese sentence it mostly comes back in Latin letters
        // (Sarina, Srina, Cirina, sureena, "就是Rina" with the s run into 是),
        // and as characters with a particle for the last syllable (色林呢,
        // 色灵啊).
        heard: /[瑟塞赛萨莎色思斯司丝苏][琳雷瑞蕾丽莉锐林玲睿芮蕊霖灵凌铃领里][娜纳那拿呐哪呢啊]/u,
        // Two syllables (司霖了吧), or a first one heard as another word (死淋了吧,
        // 我选是林娜). Never 死 alone: 要死了 is something else.
        loose: /[瑟塞赛萨莎色思斯司丝苏死撕是择][琳雷瑞蕾丽莉锐林玲睿芮蕊霖灵凌铃领里淋零](?:[娜纳那拿呐哪呢啊])?/u,
        latin: '(?:s[aeiouy]{0,3}|c[eiy][aeiouy]{0,2})r[aeiouy]{1,3}n{1,2}a?|r[aeiouy]{1,3}n{1,2}a',
    },
};

/** The name as a line in `language` says it. */
export function spokenVoiceName(name: string, language: string): string {
    return language === 'zh' ? (ZH_NAMES[name]?.said ?? name) : name;
}

/** The name as the UI in `language` shows it: what its lines say. */
export function displayVoiceName(name: string, language: string): string {
    return spokenVoiceName(name, language);
}

const LATIN_GLUE = /[\-‐·・.]+/g;

/** The words of a pick around a name, and punctuation: what a whole answer
 *  may hold besides a loose spelling (我要缘分的声音, 选人翻吧). */
const PICK_WORDS = /[\s。，！？、．.…,!?~]|我|想|要|选|用|就|是|吧|巴|八|的|声音|语音|这个|那个|喜欢|谢谢|好|请|嗯|啊|呀|了|呢|听听|试听|换成|一下|个/gu;

/** Whether simplified zh text names the voice: its Latin name (spaced or
 *  hyphenated as a recognizer may write it), what a recognizer writes for it
 *  in characters, or its Latin respelling. */
export function zhSaysName(text: string, name: string): boolean {
    if (!name) return false;
    const flat = (s: string) => s.toLowerCase().replace(/\s+/g, '').replace(LATIN_GLUE, '');
    if (flat(text).includes(flat(name))) return true;
    const zh = ZH_NAMES[name];
    if (!zh) return false;
    if (zh.heard.test(text)) return true;
    const loose = zh.loose?.exec(text);
    if (loose && (text.slice(0, loose.index) + text.slice(loose.index + loose[0].length)).replace(PICK_WORDS, '') === '') return true;
    return zh.latin !== undefined && (flat(text).match(/[a-z]+/g) ?? []).some((run) => latinIs(run, zh.latin!));
}

/** A run of Latin letters as the respelling, glue and all. */
function latinIs(run: string, latin: string): boolean {
    return new RegExp(`^(?:${latin})$`, 'i').test(run.replace(LATIN_GLUE, ''));
}

/**
 * Whether one word an English-reading matcher split out (tour-command.ts on a
 * transcript with no characters) is the voice's name or, for a zh house
 * voice, a zh recognizer's Latin respelling of it ("Sarina", "Srina").
 */
export function wordIsName(word: string, name: string): boolean {
    if (word === name.toLowerCase()) return true;
    const latin = ZH_NAMES[name]?.latin;
    return latin !== undefined && latinIs(word, latin);
}

/** The names, as said, for a zh recognizer's phrase list. */
export function zhVoicePhrases(): string[] {
    return Object.values(ZH_NAMES).map((n) => n.said);
}
