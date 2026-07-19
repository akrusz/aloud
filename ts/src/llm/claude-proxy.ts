/**
 * Claude provider routing through the local `claude` CLI, so the user's Pro/Max
 * subscription quota is billed instead of API credits. Each completion spawns a
 * fresh `claude -p` (headless) subprocess, passes the system prompt via
 * --system-prompt (which fully replaces Claude Code's default), and parses the
 * JSON response.
 *
 * Node-only (node:child_process). Callers targeting multiple runtimes must
 * feature-check before constructing.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
    CompletionOptions,
    CompletionResult,
    LLMProvider,
    Message,
} from './base.js';

const DEFAULT_MODEL = 'sonnet';
const DEFAULT_MAX_TOKENS = 300;
const DEFAULT_TIMEOUT_MS = 90_000;

export interface ClaudeProxyProviderOptions {
    /** Model alias the `claude` CLI understands: sonnet/haiku/opus or a full ID. */
    model?: string;
    /** Hard cap on per-completion run time (default 90s). */
    timeoutMs?: number;
    /** Binary path. Default: auto-discovered via PATH and common install dirs. */
    binaryPath?: string;
    /** Accepted for API parity; the `claude` CLI ignores it. */
    maxTokens?: number;
}

interface ClaudeCliResponse {
    is_error?: boolean;
    result?: string;
    stop_reason?: string | null;
    api_error_status?: string;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
    };
}

export class ClaudeProxyProvider implements LLMProvider {
    readonly model: string;
    readonly maxTokens: number;
    private readonly timeoutMs: number;
    private readonly binaryPathOverride: string | undefined;

    constructor(options: ClaudeProxyProviderOptions = {}) {
        this.model = options.model ?? DEFAULT_MODEL;
        this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.binaryPathOverride = options.binaryPath;
    }

    async complete(
        messages: Message[],
        options: CompletionOptions = {}
    ): Promise<CompletionResult> {
        const binary = this.binaryPathOverride ?? (await findClaudeCli());
        if (!binary) {
            throw new Error(
                'claude CLI not found on PATH. Install Claude Code to use ' +
                    'the Anthropic Subscription provider.'
            );
        }

        const prompt = formatHistory(messages);
        const args = [
            '-p',
            '--tools',
            '',
            '--no-session-persistence',
            '--disable-slash-commands',
            '--output-format',
            'json',
            '--model',
            this.model,
        ];
        if (options.system) {
            args.push('--system-prompt', options.system);
        }
        args.push(prompt);

        const { stdout, stderr, exitCode, signal, timedOut } = await runProcess(
            binary,
            args,
            this.timeoutMs,
            options.signal
        );

        if (options.signal?.aborted) {
            // Killed via CompletionOptions.signal (barge-in): surface the
            // AbortError shape fetch-based providers throw.
            throw new DOMException('claude CLI call aborted', 'AbortError');
        }
        if (timedOut) {
            throw new Error(`claude CLI timed out after ${Math.round(this.timeoutMs / 1000)}s`);
        }
        if (exitCode !== 0) {
            const tail = stderrTail(stderr);
            throw new Error(
                `claude CLI failed (exit ${exitCode ?? 'null'}` +
                    (signal ? `, signal ${signal}` : '') +
                    ')' +
                    (tail ? `: ${tail}` : '')
            );
        }

        let data: ClaudeCliResponse;
        try {
            data = JSON.parse(stdout) as ClaudeCliResponse;
        } catch (err) {
            throw new Error(
                `claude CLI returned invalid JSON: ${(err as Error).message}`
            );
        }

        if (data.is_error) {
            throw new Error(
                `claude CLI error: ${data.result ?? data.api_error_status ?? 'unknown'}`
            );
        }

        const usage = data.usage ?? {};
        const reported = usage.input_tokens !== undefined;
        const inputTokens = usage.input_tokens ?? 0;
        const outputTokens = usage.output_tokens ?? 0;

        return {
            text: data.result ?? '',
            finishReason: data.stop_reason ?? null,
            tokensUsed: reported ? inputTokens + outputTokens : null,
            inputTokens: reported ? inputTokens : null,
            outputTokens: reported ? outputTokens : null,
            cacheReadTokens: usage.cache_read_input_tokens ?? null,
            cacheCreationTokens: usage.cache_creation_input_tokens ?? null,
        };
    }
}

// Helpers

/**
 * Encode multi-turn history as one prompt string: the CLI takes a single prompt
 * argument, so prior turns go inline as a "User: ... / Assistant: ..."
 * transcript. System messages are dropped; --system-prompt carries that.
 */
function formatHistory(messages: readonly Message[]): string {
    const convo = messages.filter((m) => m.role !== 'system');
    if (convo.length === 0) return '';
    if (convo.length === 1 && convo[0]!.role === 'user') {
        return convo[0]!.content;
    }
    return convo
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n');
}

/**
 * Find the `claude` binary on PATH or in common install locations. The macOS
 * app bundle's limited PATH often misses ~/.local/bin, so that is checked
 * explicitly; on Windows the npm install lands as a `.cmd` shim, so both
 * `.exe` and `.cmd` are probed.
 */
async function findClaudeCli(): Promise<string | null> {
    const path = process.env['PATH'] ?? '';
    const pathSep = process.platform === 'win32' ? ';' : ':';
    const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
    for (const dir of path.split(pathSep)) {
        if (!dir) continue;
        for (const name of names) {
            const candidate = join(dir, name);
            if (await isExecutable(candidate)) return candidate;
        }
    }
    const home = homedir();
    for (const candidate of [
        join(home, '.local', 'bin', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        join(home, 'bin', 'claude'),
    ]) {
        if (await isExecutable(candidate)) return candidate;
    }
    return null;
}

async function isExecutable(path: string): Promise<boolean> {
    try {
        await access(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** Last chunk of stderr, single-line, for inclusion in error messages. */
function stderrTail(stderr: string, maxChars = 300): string {
    const trimmed = stderr.trim().replace(/\s+/g, ' ');
    if (trimmed.length <= maxChars) return trimmed;
    return `…${trimmed.slice(-maxChars)}`;
}

/** Quote an argument for cmd.exe (`""` escapes a literal `"`). Needed only for
 *  `.cmd` shims, which require `shell: true` on Node 18+. */
function cmdQuote(arg: string): string {
    return `"${arg.replace(/"/g, '""')}"`;
}

interface ProcessResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    /** True when the run was killed by the timeoutMs cap. */
    timedOut: boolean;
}

function runProcess(
    binary: string,
    args: readonly string[],
    timeoutMs: number,
    abortSignal?: AbortSignal
): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
        let proc: ChildProcess;
        // Node refuses to spawn .cmd/.bat shims directly (EINVAL since the 18.x
        // security fix), so route those through the shell with cmd.exe quoting.
        const useShell = /\.(cmd|bat)$/i.test(binary);
        try {
            proc = useShell
                ? spawn(cmdQuote(binary), args.map(cmdQuote), {
                      stdio: ['ignore', 'pipe', 'pipe'],
                      shell: true,
                  })
                : spawn(binary, args as string[], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            reject(err);
            return;
        }
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        proc.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
        proc.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            proc.kill('SIGKILL');
        }, timeoutMs);

        const onAbort = () => proc.kill('SIGKILL');
        abortSignal?.addEventListener('abort', onAbort, { once: true });
        if (abortSignal?.aborted) onAbort();

        proc.on('error', (err) => {
            clearTimeout(timeout);
            abortSignal?.removeEventListener('abort', onAbort);
            reject(err);
        });
        proc.on('close', (code, signal) => {
            clearTimeout(timeout);
            abortSignal?.removeEventListener('abort', onAbort);
            resolve({
                stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
                stderr: Buffer.concat(stderrChunks).toString('utf-8'),
                exitCode: code,
                signal,
                timedOut,
            });
        });
    });
}
