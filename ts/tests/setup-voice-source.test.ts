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

    it("waits out a session's close before it builds a listener, holding the session's mic meanwhile", () => {
        // session-mic-order.test.ts plays this order against the real engine
        // and sounds, with the wait written into the test: this is what ties
        // it to runVoiceSync.
        const start = setup.indexOf('async function runVoiceSync(');
        expect(start).toBeGreaterThan(0);
        const ends = ['\n    function ', '\n    async function ']
            .map((next) => setup.indexOf(next, start + 1))
            .filter((at) => at > 0);
        const sync = setup.slice(start, Math.min(...ends));
        const close = sync.search(/const close = waitForClose\(\);/);
        const hold = sync.indexOf('micHandover.hold(close.release)');
        const over = sync.indexOf('await close.over');
        const build = sync.indexOf('createSttForChoice(');
        const listen = sync.indexOf('listenOnSetup(');
        expect(close).toBeGreaterThan(0);
        expect(hold).toBeGreaterThan(close);
        expect(over).toBeGreaterThan(hold);
        expect(build).toBeGreaterThan(over);
        expect(listen).toBeGreaterThan(build);
    });
});

describe("the tour's speech recognition model", () => {
    it('is named on each request, so the tour neither rebuilds the listener nor reopens the mic', () => {
        // The recognizer is the same in and out of the tour: a listener is
        // replaced only when listenerChoice changes (runVoiceSync).
        expect(setup).toMatch(/const listenerChoice = \(\): SttEngineChoice => tourChoice \?\? sttSetupChoice\(\);/);
        // The model is asked for on each pass, from the tour's state as it is.
        const build = setup.indexOf('createSttForChoice(choice, {');
        expect(build).toBeGreaterThan(0);
        const opts = setup.slice(build, setup.indexOf('});', build));
        expect(opts).toMatch(
            /hostedChoice: \(built\) =>\s*setupHostedChoice\(built, appSettings\[tourPickKey\] \?\? null, tourChoice !== null\)/
        );
        // Whose pick decides: the setting the tour's recognizer came from.
        expect(setup).toMatch(/tourPickKey = sttSettingKey\(setup\.meditationType\);/);
    });
});
