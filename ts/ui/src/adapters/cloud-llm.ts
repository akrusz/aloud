/**
 * Hosted-server LLM provider — the web tier's only LLM source.
 *
 * POSTs to the aloud cloud's metered proxy (/v1/llm/complete) with a
 * bearer session token (see cloud-auth.ts). The server holds the real
 * provider keys, forwards the turn, meters it against the account's credits,
 * and returns the text (+ credits charged/remaining). The browser never sees
 * a provider key. Contrast claude-proxy-http.ts, which targets the desktop
 * Flask backend's `claude` CLI subprocess.
 *
 * Implements both complete() and completeStream() so it slots into the same
 * streaming-TTS pipeline as the BYOK providers. Tickets: meditation-pal-vd3
 * (this server), meditation-pal-8sj (metering), meditation-pal-rfb (auth).
 */

import type {
    CompletionOptions,
    CompletionResult,
    LLMProvider,
    Message,
    StreamChunk,
} from '../../../src/llm/index.js';
import { ensureCloudToken, clearCloudToken } from '../cloud-auth.js';
import { cloudUrl } from '../cloud-base.js';
import { setKnownBalance } from '../cloud-balance.js';
import { getCloudSessionId } from '../cloud-session.js';

/** Providers the server is willing to forward to (mirrors contract.ts ProviderId). */
export type CloudProviderId = 'anthropic' | 'groq' | 'openrouter' | 'google';

const ENDPOINT = '/llm/complete';
const DEFAULT_MAX_TOKENS = 400;

export interface CloudLlmProviderOptions {
    provider: CloudProviderId;
    model: string;
    maxTokens?: number;
    fetchImpl?: typeof fetch;
}

// ---- wire types (hand-mirrored from ts/server/src/contract.ts) -------------

interface CompleteResponseBody {
    text: string;
    finishReason: string | null;
    creditsCharged: number;
    creditsRemaining: number;
}

interface CompleteChunkBody {
    text: string;
    done: boolean;
    result?: CompleteResponseBody;
}

interface ApiErrorBody {
    error?: { code?: string; message?: string };
}

export class CloudLlmProvider implements LLMProvider {
    readonly model: string;
    private readonly provider: CloudProviderId;
    private readonly maxTokens: number;
    private readonly fetchImpl: typeof fetch;

    constructor(options: CloudLlmProviderOptions) {
        this.provider = options.provider;
        this.model = options.model;
        this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    }

    private body(messages: Message[], options: CompletionOptions, stream: boolean): string {
        const sessionId = getCloudSessionId();
        return JSON.stringify({
            provider: this.provider,
            model: this.model,
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            maxTokens: options.maxTokens ?? this.maxTokens,
            ...(options.system ? { system: options.system } : {}),
            stream,
            // Group this turn with the rest of the session for the cost report.
            ...(sessionId ? { sessionId } : {}),
        });
    }

    /** POST with bearer auth; on a 401 the cached token is stale — clear it,
     *  re-sign-in, and retry once before giving up. */
    private async post(
        messages: Message[],
        options: CompletionOptions,
        stream: boolean
    ): Promise<Response> {
        const send = async (token: string): Promise<Response> =>
            this.fetchImpl(cloudUrl(ENDPOINT), {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${token}`,
                    ...(stream ? { accept: 'text/event-stream' } : {}),
                },
                body: this.body(messages, options, stream),
            });

        let res = await send(await ensureCloudToken());
        if (res.status === 401) {
            await clearCloudToken();
            res = await send(await ensureCloudToken());
        }
        return res;
    }

    private async throwFromError(res: Response): Promise<never> {
        let message = `aloud cloud returned ${res.status}`;
        try {
            const data = (await res.json()) as ApiErrorBody;
            if (data.error?.message) message = data.error.message;
        } catch {
            /* non-JSON body — keep the status message */
        }
        throw new Error(message);
    }

    async complete(messages: Message[], options: CompletionOptions = {}): Promise<CompletionResult> {
        const res = await this.post(messages, options, false);
        if (!res.ok) return this.throwFromError(res);
        const data = (await res.json()) as CompleteResponseBody;
        // The server hands back the authoritative post-turn balance every call;
        // publish it so balance surfaces stay live without an extra /me round-trip
        // (meditation-pal-14s).
        if (typeof data.creditsRemaining === 'number') setKnownBalance(data.creditsRemaining);
        return {
            text: data.text ?? '',
            finishReason: data.finishReason ?? null,
            // Token usage stays server-side (private); credits are the user-facing unit.
            tokensUsed: null,
        };
    }

    async *completeStream(
        messages: Message[],
        options: CompletionOptions = {}
    ): AsyncIterable<StreamChunk> {
        const res = await this.post(messages, options, true);
        if (!res.ok) return void (await this.throwFromError(res));
        if (!res.body) {
            // No streaming body (some environments) — degrade to one chunk.
            const data = (await res.json()) as CompleteResponseBody;
            if (typeof data.creditsRemaining === 'number') setKnownBalance(data.creditsRemaining);
            yield { text: data.text ?? '', done: false };
            yield { text: '', done: true, finishReason: data.finishReason ?? null };
            return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finishReason: string | null = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // SSE frames are separated by a blank line.
            let sep: number;
            while ((sep = buffer.indexOf('\n\n')) !== -1) {
                const frame = buffer.slice(0, sep);
                buffer = buffer.slice(sep + 2);

                let event = 'message';
                let data = '';
                for (const line of frame.split('\n')) {
                    if (line.startsWith('event:')) event = line.slice(6).trim();
                    else if (line.startsWith('data:')) data += line.slice(5).trim();
                }
                if (!data) continue;

                if (event === 'error') {
                    const err = JSON.parse(data) as ApiErrorBody;
                    throw new Error(err.error?.message ?? 'upstream provider error');
                }

                const chunk = JSON.parse(data) as CompleteChunkBody;
                if (chunk.done) {
                    finishReason = chunk.result?.finishReason ?? null;
                    if (typeof chunk.result?.creditsRemaining === 'number') {
                        setKnownBalance(chunk.result.creditsRemaining);
                    }
                } else if (chunk.text) {
                    yield { text: chunk.text, done: false };
                }
            }
        }

        yield { text: '', done: true, finishReason };
    }
}
