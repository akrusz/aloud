/**
 * Emit the bilingual Chinese-translation review doc: every zh string in the
 * app paired with its English source, plus the constraints a reviewer (or
 * their AI) must respect. Regenerate after merging edits so the doc always
 * reflects the shipped strings.
 *
 *   npm run zh:review-doc      (writes dev-docs/zh-translation-review.md)
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

import { ZH } from '../ui/src/i18n/zh.js';
import {
    CHECK_IN_PROMPTS,
    COMMON_OPENERS,
    MINIMAL_OPENERS,
    HOLD_REENTRY_LINES,
    FOCUS_OPENERS,
    QUALITY_OPENERS,
} from '../src/facilitation/prompts.js';
import {
    ZH_CHECK_IN_PROMPTS,
    ZH_COMMON_OPENERS,
    ZH_MINIMAL_OPENERS,
    ZH_HOLD_REENTRY_LINES,
    ZH_FOCUS_OPENERS,
    ZH_QUALITY_OPENERS,
    ZH_TIMER_APPROACH_FALLBACKS,
    ZH_TIMER_COMPLETION_FALLBACKS,
    ZH_TIMER_CLOSE_FALLBACKS,
    ZH_FELT_SENSE_OPENERS,
    ZH_FELT_SENSE_CHECK_INS,
    ZH_NOTING_CHECK_IN_PROMPTS,
    ZH_NOTING_STATIC_OPENERS,
} from '../src/facilitation/language.js';
import {
    TIMER_APPROACH_FALLBACKS,
    TIMER_COMPLETION_FALLBACKS,
    TIMER_CLOSE_FALLBACKS,
} from '../src/facilitation/session-timer.js';
import { FELT_SENSE_OPENERS, FELT_SENSE_CHECK_INS } from '../src/facilitation/felt-sense.js';
import { NOTING_CHECK_IN_PROMPTS, NOTING_STATIC_OPENERS } from '../src/facilitation/noting.js';

const out: string[] = [];

out.push(`# aloud 中文翻译审校 / Chinese translation review

This doc pairs every Chinese string in aloud with its English source. Edit the
\`ZH:\` lines only (any tool is fine - AI included), leave the \`EN:\` lines
untouched, and send the whole file back; edits are merged by matching the EN
line.

本文档列出了 aloud 中所有中文文案及其英文原文。只需修改 \`ZH:\` 行（可以借助任何
AI 工具），\`EN:\` 行请保持原样，改完把整个文件发回即可。

## Rules 约束

- 语气：温暖、自然、口语化 - 这是一个冥想应用，不是企业软件。第一部分的句子会被
  **读出声**，轻轻说进静默里，请读出来检查是否自然。
- \`{placeholders}\`、HTML 标签（\`<strong>\` 等）、\`&amp;\` 之类的实体必须原样保留。
- "aloud"、"aloud cloud" 是产品名，永远不翻译。
- 界面按钮和标签（较短的条目）需要保持简短，放得进按钮里。
- 不用破折号"——"，用逗号或" - "。

---

## Part 1 · Spoken lines 引导者会说出口的句子

These are spoken aloud by the facilitator's voice - the most important part.
这些句子由引导者的声音读出来，是最重要的部分。
`);

function pool(title: string, en: readonly string[], zh: readonly string[]): void {
    out.push(`### ${title}\n`);
    en.forEach((line, i) => {
        out.push(`EN: ${line}`);
        out.push(`ZH: ${zh[i] ?? '(missing)'}`);
        out.push('');
    });
}

pool('Check-ins during silence 静默中的问候', CHECK_IN_PROMPTS, ZH_CHECK_IN_PROMPTS);
pool('Session openers 开场', COMMON_OPENERS, ZH_COMMON_OPENERS);
pool('Minimal openers 极简开场', MINIMAL_OPENERS, ZH_MINIMAL_OPENERS);
pool('Returning to silence 回到静默', HOLD_REENTRY_LINES, ZH_HOLD_REENTRY_LINES);
pool('Timer approaching 计时将到', TIMER_APPROACH_FALLBACKS, ZH_TIMER_APPROACH_FALLBACKS);
pool('Timer complete 计时结束', TIMER_COMPLETION_FALLBACKS, ZH_TIMER_COMPLETION_FALLBACKS);
pool('Timer closing word 结束语', TIMER_CLOSE_FALLBACKS, ZH_TIMER_CLOSE_FALLBACKS);
pool('Felt sense openers 体会模式开场', FELT_SENSE_OPENERS, ZH_FELT_SENSE_OPENERS);
pool('Felt sense check-ins 体会模式问候', FELT_SENSE_CHECK_INS, ZH_FELT_SENSE_CHECK_INS);
pool('Noting check-ins 标记模式问候', NOTING_CHECK_IN_PROMPTS, ZH_NOTING_CHECK_IN_PROMPTS);
pool('Noting opener 标记模式开场', NOTING_STATIC_OPENERS, ZH_NOTING_STATIC_OPENERS);
for (const [key, en] of Object.entries(FOCUS_OPENERS)) {
    if (en) pool(`Focus openers · ${key}`, en, ZH_FOCUS_OPENERS[key] ?? []);
}
for (const [key, en] of Object.entries(QUALITY_OPENERS)) {
    if (en) pool(`Vibe openers · ${key}`, en, ZH_QUALITY_OPENERS[key] ?? []);
}

out.push(`---

## Part 2 · UI text 界面文案

Everything on screen: labels, descriptions, hints, errors. Alphabetical by the
English source. 屏幕上的所有文字：标签、说明、提示、错误信息。按英文原文排序。
`);

for (const [en, zh] of Object.entries(ZH)) {
    if (en === zh) continue; // untranslated-on-purpose entries carry no signal
    out.push(`EN: ${en.replaceAll('\n', '\\n')}`);
    out.push(`ZH: ${zh.replaceAll('\n', '\\n')}`);
    out.push('');
}

const dest = resolve(dirname(fileURLToPath(import.meta.url)), '../../dev-docs/zh-translation-review.md');
writeFileSync(dest, out.join('\n'));
console.log(`wrote ${dest}`);
