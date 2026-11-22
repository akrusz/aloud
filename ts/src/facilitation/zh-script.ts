/**
 * Chinese as a recognizer writes it, brought to what the on-device matchers
 * read (the modules that import this one: the session's mute, end and timer
 * requests, and the setup screen's).
 *
 * Those are written in simplified characters. Local Whisper's base model
 * writes traditional ones for most Mandarin unless prompted otherwise, and a
 * recognizer set to zh-TW always does, so 開始 has to be 开始. Only the
 * matching reads the result: the transcript shown and sent to the model keeps
 * the script it was heard in.
 *
 * The table is the matchers' own vocabulary, not the language: the traditional
 * forms of exactly the characters they read (tests/zh-script.test.ts fails
 * when a matcher reads one it lacks). Every pair is one character to one, so
 * the result lines up with the input index for index (setup-command.ts slices
 * an intention out of the original).
 */

const PAIRS =
    '點点導导體体會会標标記记緒绪開开闊阔愛爱輕轻鬆松計计時时鐘钟鍾钟說说應应簡简長长問问關关聽听靜静麥麦幫帮選选項项圖图刪删' +
    '設设為为爲为換换個个費费覺觉內内隨随擾扰們们請请嗎吗謝谢後后麼么還还給给聲声啟启啓启圍围兩两閉闭風风來来錯错煩烦別别' +
    '練练習习繼继續续複复結结覽览讀读話话過过夠够現现號号這这樣样離离調调擇择對对兒儿沒没額额與与傷伤寫写幾几當当顯显' +
    '條条檔档級级補补觀观試试語语間间隱隐頁页預预復复裡里裏里箇个説说関关' +
    // Forms of another sense that simplified merged into the same character.
    '剋克尅克齣出彆别隻只廻回迴回噹当註注翫玩錶表麵面蔴麻' +
    // Simplified characters too (著名, 幺麽), but how traditional writes 接着说
    // and 什么, and no matcher reads them. 瞭 stays out: simplified too
    // (瞭望), and no matcher's 了 is ever written 瞭.
    '著着麽么' +
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
