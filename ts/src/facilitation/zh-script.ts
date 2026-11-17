/**
 * Chinese as a recognizer writes it, brought to what the on-device matchers
 * read (begin-command.ts, setup-command.ts, tour-command.ts).
 *
 * Those are written in simplified characters. Local Whisper's base model
 * writes traditional ones for most Mandarin unless prompted otherwise, and a
 * recognizer set to zh-TW always does, so 開始 has to be 开始.
 *
 * The table is the matchers' own vocabulary and the words around it, not the
 * language: a character missing here only matters once a matcher reads it.
 * Every pair is one character to one, so the result lines up with the input
 * index for index (setup-command.ts slices an intention out of the original).
 */

const PAIRS =
    '點点導导體体會会標标記记緒绪開开闊阔愛爱輕轻鬆松計计時时鐘钟鍾钟說说應应簡简長长問问關关聽听靜静麥麦幫帮選选項项圖图刪删' +
    '設设為为爲为換换個个費费覺觉內内隨随擾扰們们請请嗎吗謝谢後后麼么還还給给聲声啟启啓启圍围兩两閉闭風风來来錯错煩烦別别' +
    '練练習习繼继續续複复結结覽览讀读話话過过夠够現现號号這这樣样離离歡欢調调擇择' +
    // The zh house voices' names as a recognizer may write them (voice-names.ts).
    '曉晓悅悦';

const T2S: ReadonlyMap<string, string> = new Map(
    PAIRS.match(/[㐀-鿿]{2}/gu)!.map((pair) => [pair[0]!, pair[1]!] as [string, string])
);

/** Traditional characters to simplified, for the characters the matchers read. */
export function toSimplified(text: string): string {
    return text.replace(/[㐀-鿿]/gu, (c) => T2S.get(c) ?? c);
}

/**
 * What local Whisper leaves at the end of a line that nobody said: a
 * character it could not finish (U+FFFD) and, after a prompt, a stray
 * fullwidth digit ("半小时４").
 */
export function trimHeardZh(text: string): string {
    return text.replace(/[\s�０-９]+$/u, '');
}
