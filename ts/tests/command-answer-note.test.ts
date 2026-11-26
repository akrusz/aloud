import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every line the session speaks in answer to a spoken command is logged with a
// note behind it, COMMAND_ANSWER_NOTE the first time and COMMAND_ANSWER_AGAIN
// after (SessionManager.addCommandAnswer, tested in session.test.ts and
// cache-prefix.test.ts), or the facilitator reads the line as its own and takes
// it back (meditation-pal-3zwy). Pinned on the source: mounting the session
// view takes a harness these tests don't have.

const UI_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'src');

function withoutComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function functionBody(code: string, name: string): string {
    const body = code.match(new RegExp(`\\n {4}(?:async )?function ${name}\\([\\s\\S]*?\\n {4}\\}\\n`))?.[0];
    expect(body, name).toBeDefined();
    return body!;
}

describe("a spoken command's answer", () => {
    const session = withoutComments(readFileSync(join(UI_SRC, 'views', 'session.ts'), 'utf8'));

    it('is logged with the note that it was the app', () => {
        expect(functionBody(session, 'respondWithFacilitatorLine')).toMatch(
            /if \(kind === 'command'\) session\.addCommandAnswer\(text, COMMAND_ANSWER_NOTE, COMMAND_ANSWER_AGAIN\);\s*else session\.addAssistantMessage\(text\);/
        );
        expect(functionBody(session, 'speakCommandLine')).toMatch(/await respondWithFacilitatorLine\(line, 'command'\);/);
    });

    it('reaches the log only through speakCommandLine', () => {
        // applyCommand (and adjustPause inside it) returns lines that
        // runVoiceCommand hands to speakCommandLine; anywhere else a line is
        // spoken, it is passed to speakCommandLine where it is built.
        expect(functionBody(session, 'runVoiceCommand')).toMatch(
            /const done = cmd\.commands\.map\(\(c\) => applyCommand\(c, userText, lang\)\);\s*await speakCommandLine\(userText, done\.map/
        );
        expect(session.match(/applyCommand\(/g)?.length).toBe(2);
        expect(session.match(/adjustPause\(/g)?.length).toBe(3);
        const lines = session.split('\n');
        let inFunction = '';
        for (const line of lines) {
            const opened = /^ {4}(?:async )?function (\w+)/.exec(line);
            if (opened) inFunction = opened[1]!;
            if (!line.includes('COMMAND_LINES') || /^\s*COMMAND_LINES,$/.test(line)) continue;
            const ok =
                inFunction === 'applyCommand' ||
                inFunction === 'adjustPause' ||
                /await speakCommandLine\(userText, COMMAND_LINES\.\w+\(/.test(line);
            expect(ok, `${inFunction}: ${line.trim()}`).toBe(true);
        }
    });
});
