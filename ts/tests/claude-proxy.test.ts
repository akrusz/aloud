import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

import { ClaudeProxyProvider } from '../src/llm/claude-proxy.js';

interface SpawnCall {
    binary: string;
    args: readonly string[];
    options?: { shell?: boolean };
}

let activeSpawnState: {
    calls: SpawnCall[];
    stdout: string;
    exitCode: number;
    stderr?: string;
    /** Never emit 'close' on its own — only kill() ends the process. */
    hang?: boolean;
} | null = null;

// When true, every fs.access call rejects with ENOENT — lets us simulate
// "no claude binary anywhere" regardless of what's actually on disk.
let forceAccessFail = false;

// Same pattern as the spawn mock: a module-level toggle that tests flip on,
// since fs.access is itself an ESM read-only binding (vi.spyOn fails).
vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return {
        ...actual,
        access: ((path: string, mode?: number) => {
            if (forceAccessFail) {
                return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
            }
            return actual.access(path, mode);
        }) as typeof actual.access,
    };
});

// vi.mock is hoisted; the factory closes over a module-level state object
// that tests reset in beforeEach. Lets us inject stdout/exitCode per test
// without trying to redefine child_process.spawn (an ESM read-only binding).
vi.mock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    return {
        ...actual,
        spawn: ((cmd: string, args: readonly string[], options?: { shell?: boolean }) => {
            const state = activeSpawnState;
            if (!state) throw new Error('spawn called without active fake state');
            state.calls.push({ binary: cmd, args, ...(options && { options }) });

            // Mock both the process and its stdout/stderr streams as
            // EventEmitters; the consumer attaches on('data') listeners
            // so we emit data events synchronously after they bind, then
            // 'close' on a microtask boundary.
            const proc = new EventEmitter() as ChildProcess;
            const stdout = new EventEmitter();
            const stderr = new EventEmitter();
            (proc as unknown as { stdout: EventEmitter }).stdout = stdout;
            (proc as unknown as { stderr: EventEmitter }).stderr = stderr;
            proc.kill = ((sig?: NodeJS.Signals) => {
                queueMicrotask(() => proc.emit('close', null, sig ?? 'SIGTERM'));
                return true;
            }) as ChildProcess['kill'];
            if (!state.hang) {
                queueMicrotask(() => {
                    stdout.emit('data', Buffer.from(state.stdout));
                    if (state.stderr) stderr.emit('data', Buffer.from(state.stderr));
                    proc.emit('close', state.exitCode, null);
                });
            }
            return proc;
        }) as unknown as typeof actual.spawn,
    };
});

function fakeSpawn(
    stdout: string,
    exitCode: number = 0,
    extra: { stderr?: string; hang?: boolean } = {}
): SpawnCall[] {
    activeSpawnState = { calls: [], stdout, exitCode, ...extra };
    return activeSpawnState.calls;
}

describe('ClaudeProxyProvider', () => {
    beforeEach(() => {
        activeSpawnState = null;
    });

    it('shells out to claude with the right flags and a JSON output format', async () => {
        const calls = fakeSpawn(JSON.stringify({ result: 'What do you notice?', stop_reason: 'end_turn' }));
        const provider = new ClaudeProxyProvider({ binaryPath: '/usr/local/bin/claude' });
        const result = await provider.complete([{ role: 'user', content: 'hi' }], {
            system: 'be a facilitator',
        });
        expect(result.text).toBe('What do you notice?');
        expect(result.finishReason).toBe('end_turn');
        expect(calls).toHaveLength(1);
        const { binary, args } = calls[0]!;
        expect(binary).toBe('/usr/local/bin/claude');
        expect(args).toContain('-p');
        expect(args).toContain('--no-session-persistence');
        expect(args).toContain('--disable-slash-commands');
        expect(args).toContain('--output-format');
        expect(args).toContain('json');
        expect(args).toContain('--system-prompt');
        expect(args).toContain('be a facilitator');
        // The model arg defaults to 'sonnet'.
        const modelIdx = args.indexOf('--model');
        expect(args[modelIdx + 1]).toBe('sonnet');
    });

    it('formats multi-turn history as a User/Assistant transcript', async () => {
        const calls = fakeSpawn(JSON.stringify({ result: 'ok' }));
        const provider = new ClaudeProxyProvider({ binaryPath: '/bin/claude' });
        await provider.complete([
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
            { role: 'user', content: 'how are you' },
        ]);
        const lastArg = calls[0]!.args[calls[0]!.args.length - 1];
        expect(lastArg).toContain('User: hi');
        expect(lastArg).toContain('Assistant: hello');
        expect(lastArg).toContain('User: how are you');
    });

    it('passes the bare content when the conversation is a single user message', async () => {
        const calls = fakeSpawn(JSON.stringify({ result: 'ok' }));
        const provider = new ClaudeProxyProvider({ binaryPath: '/bin/claude' });
        await provider.complete([{ role: 'user', content: 'breathe' }]);
        // Last arg is the prompt; for single-user it's the bare content.
        expect(calls[0]!.args[calls[0]!.args.length - 1]).toBe('breathe');
    });

    it('surfaces non-zero exit codes', async () => {
        fakeSpawn('', 1);
        const provider = new ClaudeProxyProvider({ binaryPath: '/bin/claude' });
        await expect(provider.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
            /exit 1/
        );
    });

    it('includes a stderr tail when the CLI exits non-zero', async () => {
        fakeSpawn('', 1, { stderr: 'Error: invalid API key\nplease run claude login' });
        const provider = new ClaudeProxyProvider({ binaryPath: '/bin/claude' });
        await expect(provider.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
            /invalid API key.*claude login/
        );
    });

    it('reports a timeout as "timed out", not a bare exit/signal', async () => {
        fakeSpawn('', 0, { hang: true });
        const provider = new ClaudeProxyProvider({ binaryPath: '/bin/claude', timeoutMs: 20 });
        await expect(provider.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
            /timed out after 0s/
        );
    });

    it('aborting via CompletionOptions.signal kills the process and throws AbortError', async () => {
        fakeSpawn('', 0, { hang: true });
        const provider = new ClaudeProxyProvider({ binaryPath: '/bin/claude' });
        const controller = new AbortController();
        const pending = provider.complete([{ role: 'user', content: 'hi' }], {
            signal: controller.signal,
        });
        // Let the spawn happen, then barge in.
        await new Promise((r) => setTimeout(r, 0));
        controller.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('spawns .cmd shims through the shell with quoted args', async () => {
        const calls = fakeSpawn(JSON.stringify({ result: 'ok' }));
        const provider = new ClaudeProxyProvider({ binaryPath: 'C:\\npm\\claude.cmd' });
        await provider.complete([{ role: 'user', content: 'hi there' }]);
        const { binary, args, options } = calls[0]!;
        expect(options?.shell).toBe(true);
        expect(binary).toBe('"C:\\npm\\claude.cmd"');
        // Every arg is cmd.exe-quoted so spaces in prompts survive the shell.
        expect(args[0]).toBe('"-p"');
        expect(args[args.length - 1]).toBe('"hi there"');
    });

    it('surfaces is_error: true responses', async () => {
        fakeSpawn(
            JSON.stringify({ is_error: true, result: 'something broke' })
        );
        const provider = new ClaudeProxyProvider({ binaryPath: '/bin/claude' });
        await expect(provider.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(
            /something broke/
        );
    });

    it('throws a friendly error when the binary cannot be found', async () => {
        // Clear PATH AND force fs.access to always reject — otherwise the
        // hardcoded fallback paths in findClaudeCli (~/.local/bin/claude,
        // /opt/homebrew/bin/claude, ...) resolve on dev machines with
        // Claude Code installed, and the spawn mock fires without active
        // state instead of letting the discovery return null.
        const originalPath = process.env['PATH'];
        process.env['PATH'] = '';
        forceAccessFail = true;
        try {
            const provider = new ClaudeProxyProvider();
            await expect(
                provider.complete([{ role: 'user', content: 'hi' }])
            ).rejects.toThrow(/claude CLI not found/);
        } finally {
            forceAccessFail = false;
            process.env['PATH'] = originalPath;
        }
    });

    it('reports tokensUsed from the usage block', async () => {
        fakeSpawn(
            JSON.stringify({
                result: 'ok',
                usage: { input_tokens: 50, output_tokens: 5 },
            })
        );
        const provider = new ClaudeProxyProvider({ binaryPath: '/bin/claude' });
        const result = await provider.complete([{ role: 'user', content: 'hi' }]);
        expect(result.tokensUsed).toBe(55);
    });

    it('reports the input/output/cache split', async () => {
        fakeSpawn(
            JSON.stringify({
                result: 'ok',
                usage: {
                    input_tokens: 50,
                    output_tokens: 5,
                    cache_read_input_tokens: 30,
                    cache_creation_input_tokens: 8,
                },
            })
        );
        const provider = new ClaudeProxyProvider({ binaryPath: '/bin/claude' });
        const result = await provider.complete([{ role: 'user', content: 'hi' }]);
        expect(result.inputTokens).toBe(50);
        expect(result.outputTokens).toBe(5);
        expect(result.cacheReadTokens).toBe(30);
        expect(result.cacheCreationTokens).toBe(8);
    });

    it('reports null splits when usage is absent', async () => {
        fakeSpawn(JSON.stringify({ result: 'ok' }));
        const provider = new ClaudeProxyProvider({ binaryPath: '/bin/claude' });
        const result = await provider.complete([{ role: 'user', content: 'hi' }]);
        expect(result.tokensUsed).toBeNull();
        expect(result.inputTokens).toBeNull();
        expect(result.outputTokens).toBeNull();
        expect(result.cacheReadTokens).toBeNull();
    });
});
