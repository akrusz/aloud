import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// What a cut-off reply keeps (heard() in streaming-tts.ts) is known once the
// engine has stopped: a whole-reply clip reports the chunks it reached inside
// cancel() (CloudTtsEngine.reportMarks). So every path that hushes a reply
// must cancel the voice before the reply is cut (cutReply, which reads
// heard()), and a barge-in must cancel before it aborts. Pinned on the source:
// mounting the session view takes a harness these tests don't have.

const UI_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'src');

function withoutComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The source between the last function start before `at` and `at`. */
function enclosing(code: string, at: number): string {
    const before = code.slice(0, at);
    const start = Math.max(before.lastIndexOf('function '), before.lastIndexOf('=> {'));
    return before.slice(start);
}

describe('a cut-off reply is cut only after the voice was stopped', () => {
    const session = withoutComments(readFileSync(join(UI_SRC, 'views', 'session.ts'), 'utf8'));

    it('cancels the voice before every cutReply (takeFloor, respondTo)', () => {
        const sites = [...session.matchAll(/cutReply\?\.\(\)/g)].map((m) => m.index);
        expect(sites.length).toBeGreaterThanOrEqual(2);
        for (const at of sites) expect(enclosing(session, at), `cutReply at ${at}`).toMatch(/tts\.cancel\(\)/);
    });

    it('cancels before it aborts on both barge-in paths', () => {
        const whisper = session.indexOf('activeTtsAbort?.abort();\n            onBargeIn();');
        expect(whisper).toBeGreaterThan(0);
        expect(enclosing(session, whisper)).toMatch(/void tts\.cancel\(\);\s*$/);
        const wrapper = withoutComments(readFileSync(join(UI_SRC, 'barge-in.ts'), 'utf8'));
        expect(wrapper).toMatch(/void inner\.cancel\(\);\s*if \(options\.onBargeIn\) options\.onBargeIn\(\);/);
    });
});
