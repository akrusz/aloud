/**
 * The zh house voices' Chinese names. Their catalog names (server
 * voice-catalog.ts) are the pinyin of these, which is what storage, the server
 * and every English screen use; a zh session says and shows the characters:
 *
 * - Spoken: a zh line says the name in characters (`spokenVoiceName`).
 * - Shown: the zh UI calls a voice what its lines call it
 *   (`displayVoiceName`), so 大海 on the screen is 大海 out loud.
 * - Heard: `zhSaysName` finds the voice in what a zh recognizer wrote.
 *
 * The names were chosen because local Whisper writes them right
 * (dev-docs/voice-commands.md). Changing `said` changes the text of the zh
 * lines that carry the name, and their clips stop playing until re-rendered.
 * A voice that isn't here keeps its Latin name in both directions. Matched on
 * simplified text (zh-script.ts).
 */

interface ZhName {
    /** What a zh line says and the zh UI shows. */
    said: string;
    /** What a recognizer writes for it, anywhere in what was said. */
    heard: RegExp;
}

// With the other spellings local Whisper wrote for them on a few takes each
// (dev-docs/voice-commands.md): 大孩; 小玉, and 小悦 and 晓月, which sound
// exactly like 小月.
const ZH_NAMES: Readonly<Record<string, ZhName>> = {
    Dahai: { said: '大海', heard: /大[海孩]/u },
    Xiaoyue: { said: '小月', heard: /[小晓][月玉悦]/u },
};

/** The name as a line in `language` says it. */
export function spokenVoiceName(name: string, language: string): string {
    return language === 'zh' ? (ZH_NAMES[name]?.said ?? name) : name;
}

/** The name as the UI in `language` shows it: what its lines say. */
export function displayVoiceName(name: string, language: string): string {
    return spokenVoiceName(name, language);
}

/** Whether simplified zh text names the voice: its catalog name in Latin
 *  letters, or what a recognizer writes for its Chinese name. */
export function zhSaysName(text: string, name: string): boolean {
    if (name && text.toLowerCase().includes(name.toLowerCase())) return true;
    return ZH_NAMES[name]?.heard.test(text) ?? false;
}

/** The names, as said, for a zh recognizer's phrase list. */
export function zhVoicePhrases(): string[] {
    return Object.values(ZH_NAMES).map((n) => n.said);
}
