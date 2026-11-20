import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// How views/setup.ts wires the setup screen's listener. Mounting the view
// takes a harness these tests don't have, so the wiring is pinned on the
// source; what each piece does is tested on its own (voice-start.test.ts).

const UI_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'src');

function withoutComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const setup = withoutComments(readFileSync(join(UI_SRC, 'views', 'setup.ts'), 'utf8'));

describe("the setup screen's listener", () => {
    it('runs its capture on and hears through lines only where setupCaptureRunsOn allows', () => {
        const at = setup.indexOf('continuous: {');
        expect(at).toBeGreaterThan(0);
        expect(setup.indexOf('continuous: {', at + 1)).toBe(-1);
        expect(setup.slice(setup.lastIndexOf('...(', at), at)).toMatch(/&& setupCaptureRunsOn\(\)\s*\?/);
    });
});
