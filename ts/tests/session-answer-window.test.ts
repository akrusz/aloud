import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The end question's window (endConfirmUntil) routes the next utterance to
// handleEndConfirm for 45s. A line spoken after the question inside that
// window (a check-in, a timer notice) can ask its own question, and a yes to
// it must not end the sit: every line closes the window as it starts. Pinned
// on the source: mounting the session view takes a harness these tests don't
// have (the engine's own expectation is tested in whisper-pcm-answer.test.ts).

const UI_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'src');

function withoutComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe("the end question's window", () => {
    const session = withoutComments(readFileSync(join(UI_SRC, 'views', 'session.ts'), 'utf8'));

    it('closes when the next line starts playing', () => {
        const body = session.match(/function ttsPlaybackStarted\(text: string\): void \{([\s\S]*?)\n {4}\}/)?.[1];
        expect(body).toBeDefined();
        expect(body).toMatch(/endConfirmUntil = 0;/);
    });

    it('is opened only after the question has been spoken', () => {
        expect(session).toMatch(/after: \(\) => \{\s*endAskedAt = Date\.now\(\);\s*endConfirmUntil = /);
        expect(session).toMatch(/await speakCommandLine\(userText, [^\n]*\);\s*for \(const d of done\) d\.after\?\.\(\);/);
    });
});
