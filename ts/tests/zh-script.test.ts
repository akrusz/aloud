import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toSimplified, trimHeardZh } from '../src/facilitation/zh-script.js';

describe('toSimplified', () => {
    it('brings the matchers\' words to the script they are written in', () => {
        expect(toSimplified('開始')).toBe('开始');
        expect(toSimplified('切換到體會')).toBe('切换到体会');
        expect(toSimplified('輕鬆有玩心')).toBe('轻松有玩心');
        expect(toSimplified('設定45分鐘')).toBe('设定45分钟');
        expect(toSimplified('就這樣吧')).toBe('就这样吧');
        expect(toSimplified('曉月 小悅')).toBe('晓月 小悦');
        expect(toSimplified('靜音')).toBe('静音');
        expect(toSimplified('結束這個冥想')).toBe('结束这个冥想');
        expect(toSimplified('對，還沒有，再坐一會兒')).toBe('对，还没有，再坐一会儿');
        expect(toSimplified('兩個小時')).toBe('两个小时');
    });

    it('takes every traditional form of a character, and none that is simplified in its own right', () => {
        expect(toSimplified('這箇')).toBe('这个');
        expect(toSimplified('這裡 這裏')).toBe('这里 这里');
        expect(toSimplified('接著說')).toBe('接着说');
        expect(toSimplified('瞭望')).toBe('瞭望');
    });

    it('keeps the length, so an index into one is an index into the other', () => {
        const said = '我的意圖是放鬆，然後 rest';
        expect(toSimplified(said)).toHaveLength(said.length);
    });

    it('leaves simplified and everything else alone', () => {
        expect(toSimplified('开始 twenty minutes')).toBe('开始 twenty minutes');
    });
});

describe('trimHeardZh', () => {
    it('drops what nobody said from the end, and only from the end', () => {
        expect(trimHeardZh('半小时４')).toBe('半小时');
        expect(trimHeardZh('切换到体会\uFFFD')).toBe('切换到体会');
        expect(trimHeardZh('２０分钟')).toBe('２０分钟');
    });
});

// ---- the table keeps up with the matchers -----------------------------------

/**
 * Every Han character the zh matchers read goes in one of these two. With it,
 * the other forms a recognizer may write it in: its traditional forms, as
 * ICU's Traditional-Simplified transform gives them over the whole CJK block
 * (on macOS, CFStringTransform with "Hant-Hans" finds them), and 妳 and 覆,
 * which ICU leaves (zh-script.ts says why).
 */
const NO_OTHER_FORM =
    '一七三上下不世串主九二五些什今以修候停充先全八六再冥分切列到前力加助十半去及取受口可吧呀呃和哪啊啦嗓嗯嘛器四在均坐基多' +
    '大天女好始孩它安完官定小少就已度延式引往心悲情想意感慈成我所打把指掉探接提撒播收改放散明是更月有期本束模次止此步氛求海' +
    '消添清焦然特玉用男界白的看知短示程空窗第等筒算索置者聆能良藏行衡要起跟跳身返退遍道那部重闢除零音' +
    '首正似乎像又描述享得希望告思答需';
const WITH_FORMS = (
    '与與 两兩 个個箇 为為爲 么麼麽 习習 了瞭 们們 会會 伤傷 体體 儿兒 克剋尅 关關関 内內 写寫 几幾 出齣 删刪 别別彆 只隻 号號 ' +
    '后後 吗嗎 听聽 启啓啟 回廻迴 围圍 图圖 声聲 复復複覆 够夠 对對 导導 帮幫 应應 开開 当當噹 悦悅 扰擾 择擇 换換 时時 显顯 ' +
    '晓曉 条條 来來 松鬆 标標 样樣 档檔 没沒 注註 点點 烦煩 爱愛 玩翫 现現 着著 离離 简簡 级級 练練 结結 给給 继繼 绪緒 续續 ' +
    '补補 表錶 观觀 览覽 觉覺 计計 记記 设設 试試 话話 语語 说說説 请請 读讀 调調 谢謝 费費 轻輕 过過 还還 这這 选選 里裏裡 ' +
    '钟鐘鍾 错錯 长長 闭閉 问問 间間 阔闊 随隨 隐隱 静靜 面麵 页頁 项項 预預 额額 风風 麦麥 麻蔴 ' +
    '你妳 户戶 刚剛 才纔 达達 询詢 报報 该該'
).split(' ');

/** Traditional forms the table leaves out on purpose (zh-script.ts says why). */
const LEFT_OUT = new Set(['瞭']);

const FORMS: ReadonlyMap<string, string> = new Map([
    ...Array.from(NO_OTHER_FORM, (c): [string, string] => [c, '']),
    ...WITH_FORMS.map((entry): [string, string] => [entry[0]!, entry.slice(1)]),
]);

/** Modules whose Chinese is only ever said, shown or sent to a model. */
const NOT_MATCHERS = new Set([
    'src/facilitation/language.ts',
    'src/facilitation/noting.ts',
    'src/facilitation/prompts.ts',
    'src/facilitation/setup-lines.ts',
    'src/facilitation/summary.ts',
    'src/facilitation/utterance-judge.ts',
    'src/facilitation/voice-command-specs.ts',
    'src/facilitation/zh-script.ts',
    'ui/src/app-settings.ts',
    'ui/src/i18n/zh.ts',
    'ui/src/views/settings.ts',
]);

/** A matcher that reads what its callers have already converted. */
const READS_CONVERTED = new Set(['src/facilitation/voice-names.ts']);

/** Where a matcher's module goes on to what the app says back. */
const SPOKEN_FROM: Readonly<Record<string, string>> = {
    'src/facilitation/voice-command.ts': 'export const COMMAND_LINES',
};

const TS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The core's and the UI's tracked sources, or every file on disk where git can't say. */
function sources(): string[] {
    try {
        return execFileSync('git', ['ls-files', '--', 'src', 'ui/src'], { cwd: TS_ROOT, encoding: 'utf8' })
            .split('\n')
            .filter((p) => p.endsWith('.ts'));
    } catch {
        const files: string[] = [];
        const walk = (dir: string): void => {
            for (const name of readdirSync(dir)) {
                const p = join(dir, name);
                if (statSync(p).isDirectory()) walk(p);
                else if (name.endsWith('.ts')) files.push(relative(TS_ROOT, p));
            }
        };
        walk(join(TS_ROOT, 'src'));
        walk(join(TS_ROOT, 'ui/src'));
        return files;
    }
}

function withoutComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

let scanned: ReadonlyMap<string, string> | null = null;

/** The code of every module with Chinese in it that is not in NOT_MATCHERS:
 *  the zh matchers, each up to where it starts saying things back. */
function matchers(): ReadonlyMap<string, string> {
    if (scanned) return scanned;
    const found = new Map<string, string>();
    for (const rel of sources()) {
        if (NOT_MATCHERS.has(rel)) continue;
        // The range every module tests for Chinese with is not a character read.
        const code = withoutComments(readFileSync(join(TS_ROOT, rel), 'utf8')).replaceAll('㐀-鿿', '');
        if (!/[㐀-鿿]/u.test(code)) continue;
        const marker = SPOKEN_FROM[rel];
        const end = marker === undefined ? code.length : code.indexOf(marker);
        if (end < 0) throw new Error(`${rel} no longer has "${marker}": say in SPOKEN_FROM where its lines start`);
        found.set(rel, code.slice(0, end));
    }
    scanned = found;
    return found;
}

function matcherChars(): Set<string> {
    return new Set([...matchers().values()].flatMap((code) => code.match(/[㐀-鿿]/gu) ?? []));
}

describe('the table and the zh matchers', () => {
    it("finds the matchers, the session's and the setup screen's", () => {
        expect([...matchers().keys()]).toEqual(
            expect.arrayContaining([
                'src/facilitation/mute-command.ts',
                'src/facilitation/end-command.ts',
                'src/facilitation/hesitation.ts',
                'src/facilitation/voice-command.ts',
                'src/facilitation/begin-command.ts',
                'src/facilitation/setup-command.ts',
                'src/facilitation/tour-command.ts',
            ])
        );
    });

    it('has every module that matches Chinese convert it first', () => {
        const unconverted = [...matchers()].filter(([rel, code]) => !READS_CONVERTED.has(rel) && !/\btoSimplified\(/.test(code));
        expect(
            unconverted.map(([rel]) => rel),
            'Chinese in the code and no toSimplified: convert first if this matches what a recognizer wrote, else add it to NOT_MATCHERS'
        ).toEqual([]);
    });

    it('knows every character the matchers read', () => {
        expect(
            [...matcherChars()].filter((c) => !FORMS.has(c)),
            'Read by a zh matcher, not listed here: add each to WITH_FORMS with its traditional forms, or to NO_OTHER_FORM'
        ).toEqual([]);
    });

    it('maps every traditional form of what they read, and none of what they read', () => {
        const wrong: string[] = [];
        for (const c of matcherChars()) {
            if (toSimplified(c) !== c) wrong.push(`${c} becomes ${toSimplified(c)} before any pattern sees it`);
            for (const t of FORMS.get(c) ?? '') {
                const want = LEFT_OUT.has(t) ? t : c;
                if (toSimplified(t) !== want) wrong.push(`${t} gives ${toSimplified(t)}, want ${want}`);
            }
        }
        expect(wrong, 'Pairs zh-script.ts is missing or has wrong').toEqual([]);
    });

    it('holds nothing else', () => {
        const read = matcherChars();
        const stray: string[] = [];
        for (let cp = 0x3400; cp <= 0x9fff; cp++) {
            const t = String.fromCodePoint(cp);
            const s = toSimplified(t);
            if (s !== t && !(read.has(s) && FORMS.get(s)!.includes(t))) stray.push(t + s);
        }
        expect(stray, 'Pairs in zh-script.ts for a character no matcher reads, or a form not listed here').toEqual([]);
    });
});
