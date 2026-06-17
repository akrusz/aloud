/**
 * Browser-facing claude_proxy provider.
 *
 * The real ClaudeProxyProvider (ts/src/llm/claude-proxy.ts) shells out
 * via node:child_process, which is Node-only — browsers and Capacitor
 * WebViews can't run it. This thin wrapper POSTs to the app backend's
 * /app/v1/llm/claude_proxy/complete endpoint (the Rust shell on desktop),
 * which performs the subprocess call and returns a CompletionResult-shaped
 * JSON body. Used by the session view when the user has picked the
 * "Anthropic (Subscription)" provider.
 *
 * Desktop-only by nature — the route is only present when running
 * against the app backend. The provider option is gated by
 * isDesktopSync() in the settings/setup dropdowns so mobile users
 * don't see it.
 */

import type {
    CompletionOptions,
    CompletionResult,
    LLMProvider,
    Message,
} from '../../../src/llm/index.js';
import { appUrl } from '../app-base.js';

const DEFAULT_MODEL = 'sonnet';
const DEFAULT_MAX_TOKENS = 400;
const ENDPOINT = appUrl('/llm/claude_proxy/complete');

export interface ClaudeProxyHttpProviderOptions {
    model?: string;
    maxTokens?: number;
    endpointUrl?: string;
    fetchImpl?: typeof fetch;
}

interface ClaudeProxyResponse {
    text?: string;
    finish_reason?: string | null;
    tokens_used?: number | null;
    error?: string;
}

export class ClaudeProxyHttpProvider implements LLMProvider {
    readonly model: string;
    readonly maxTokens: number;
    private readonly endpointUrl: string;
    private readonly fetchImpl: typeof fetch;

    constructor(options: ClaudeProxyHttpProviderOptions = {}) {
        this.model = options.model ?? DEFAULT_MODEL;
        this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.endpointUrl = options.endpointUrl ?? ENDPOINT;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    }

    async complete(
        messages: Message[],
        options: CompletionOptions = {}
    ): Promise<CompletionResult> {
        const body: Record<string, unknown> = {
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            model: this.model,
            max_tokens: options.maxTokens ?? this.maxTokens,
        };
        if (options.system) body['system'] = options.system;

        const response = await this.fetchImpl(this.endpointUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            // Forward the turn's abort signal so a superseded/torn-down turn
            // actually cancels the request. Dropping the connection lets the
            // Rust handler future drop too, and its kill_on_drop reaps the
            // spawned `claude` child — otherwise the CLI runs to its 90s cap
            // and returns a stale answer long after the session ended.
            signal: options.signal ?? null,
        });

        if (!response.ok) {
            // The proxy returns JSON {error: ...} on failure. 503 means the
            // `claude` CLI isn't installed or available; surface that as a
            // friendly error so the session view's error rendering can show
            // it directly.
            let detail = '';
            try {
                const data = (await response.json()) as ClaudeProxyResponse;
                detail = data.error ?? '';
            } catch {
                detail = await response.text().catch(() => '');
            }
            throw new Error(
                detail ||
                    `Claude Subscription proxy returned ${response.status}`
            );
        }

        const data = (await response.json()) as ClaudeProxyResponse;
        return {
            text: data.text ?? '',
            finishReason: data.finish_reason ?? null,
            tokensUsed: data.tokens_used ?? null,
        };
    }
}
