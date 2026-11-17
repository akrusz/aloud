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
    /** The characters a recognizer may write for it, by syllable: each class
     *  is one syllable's homophones, tones and a soft n/ng aside. */
    heard: RegExp;
}

const ZH_NAMES: Readonly<Record<string, ZhName>> = {
    // Azure gives no characters (its voices/list LocalName is "Yunfan Dragon
    // HD Latest", where the older voices have 云希, 云健); 云帆 is the usual
    // name spelled yún fān, and the 云 matches Azure's other male voices.
    Yunfan: {
        said: '云帆',
        heard: /[云允运韵芸匀耘昀晕蕴][帆凡翻番繁范饭烦泛樊藩反返]/u,
    },
    // An English name, which a Chinese sentence keeps as one (people with
    // English names are introduced that way), so the line says "Serena". Said
    // back it may still come out as a transliteration: 瑟琳娜, 塞雷娜, 赛琳娜.
    Serena: {
        said: 'Serena',
        heard: /[瑟塞赛萨莎色思斯][琳雷瑞蕾丽莉锐林玲睿芮蕊][娜纳那拿]/u,
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

/** Whether simplified zh text names the voice: its Latin name, or what a
 *  recognizer writes for it in characters. */
export function zhSaysName(text: string, name: string): boolean {
    if (name && text.toLowerCase().includes(name.toLowerCase())) return true;
    return ZH_NAMES[name]?.heard.test(text) ?? false;
}

/** The names, as said, for a zh recognizer's phrase list. */
export function zhVoicePhrases(): string[] {
    return Object.values(ZH_NAMES).map((n) => n.said);
}
