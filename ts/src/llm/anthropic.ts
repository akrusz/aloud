/**
 * Anthropic API provider: direct fetch, no SDK.
 *
 * Prompt caching: the breakpoint on the LAST message caches the whole
 * system+conversation prefix, so each later turn reads the transcript at ~0.1x
 * instead of re-billing it as fresh input - the dominant cost on this
 * input-heavy (~45:1) workload. The entry lives five minutes from the start of
 * the request that last wrote or read it; a quiet stretch longer than that is
 * bridged by keepAlive (keep-alive.ts), not by a 1h breakpoint: reading a 5m
 * entry restarts its 5 minutes even from a request that marks the block 1h, so
 * a 1h breakpoint behind the tail is never written while the cache is warm.
 *
 * The system prompt gets no breakpoint of its own: the tail's entry already
 * covers it, and every request in a sit carries the same one.
 *
 * The cache only pays if each request starts byte-identically with the last, so
 * the conversation is rendered 1:1 from the session log: no merging, no stubs,
 * and a `system` entry (a staged-mode phase note) renders the same way every
 * time it is resent (renderConversation).
 */

import type {
    CompletionAttempt,
    CompletionDiagnostics,
    CompletionOptions,
    CompletionResult,
    LLMProvider,
    Message,
    StreamChunk,
} from './base.js';
import { systemNoteAsUserText } from './base.js';
import { fetchWithRetry, retryOptions, type RetryOptions, type SleepFn } from './retry.js';
import { iterateSseEvents, safeJson } from './sse.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const DEFAULT_MAX_TOKENS = 300;

/**
 * How a model treats `thinking`, decided by FAMILY rather than by an exact-id
 * allowlist, so a new release (fable-5-1, opus-5-1, ...) is served correctly
 * the day it shows up on /v1/models instead of after a code edit:
 *
 *  - always-on (Fable, Mythos, Opus 5.5+): thinking can't be disabled
 *    (`{type:"disabled"}` 400s at every effort on Opus 5.5), so pin
 *    `output_config.effort` to `low` - the shortest think-before-speak, capping
 *    both the preamble latency and thinking tokens (billed as output).
 *  - between-tools (Sonnet 5.5+): the disable 400s here too, but this family
 *    has its own off switch, `{type:"between_tools"}`: no extended thinking,
 *    so no preamble and no thinking tokens. NO effort override alongside (it
 *    is accepted only at effort `high` or lower, the default) and no other
 *    field inside `thinking`. Only Sonnet 5.5+ takes it. Adaptive thinking
 *    at effort `low` was no faster on the real prompts (evals, 2026-10-02).
 *  - opt-out (Opus and Sonnet 5.0-5.4, Haiku 5+): omitting `thinking` runs
 *    adaptive thinking, costing a silent delay plus output-billed thinking
 *    tokens every turn, so send an explicit disable. NO effort override
 *    alongside: Opus 5 accepts the disable only at effort `high` or lower
 *    (omitting `output_config` leaves it at the `high` default), and
 *    `xhigh`/`max` next to a disable is a 400.
 *  - none (the 4.x opt-in models, claude-3-*): already off without a param, and
 *    `output_config`/`effort` 400s on claude-3-opus.
 *
 * A future family whose rules differ is caught by `send()`: a 400 that blames
 * the tuning gets one retry without it, and the provider stays untuned for the
 * rest of the session.
 */
export type ThinkingPolicy = 'always-on' | 'between-tools' | 'opt-out' | 'none';

export function thinkingPolicy(model: string): ThinkingPolicy {
    const m = model.toLowerCase();
    if (/^claude-(fable|mythos)-/.test(m)) return 'always-on';
    const gen = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d)(?!\d))?/.exec(m);
    if (!gen) return 'none';
    const version = Number(gen[2]) + Number(gen[3] ?? 0) / 10;
    if (gen[1] === 'opus' && version >= 5.5) return 'always-on';
    if (gen[1] === 'sonnet' && version >= 5.5) return 'between-tools';
    if (version >= 5) return 'opt-out';
    return 'none';
}

/**
 * Does the model take `role: "system"` entries inside `messages`
 * (mid-conversation system messages)? Fable, Mythos, Opus 4.8+, and Sonnet
 * and Haiku 5.5+; not the earlier Sonnets or Haikus. A model this guesses
 * wrong on is caught by `send()`: the 400 gets one retry with system entries
 * rendered as user text, and the provider stays that way for the session.
 */
export function supportsMidConversationSystem(model: string): boolean {
    const m = model.toLowerCase();
    if (/^claude-(fable|mythos)-/.test(m)) return true;
    const gen = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d)(?!\d))?/.exec(m);
    if (!gen) return false;
    const version = Number(gen[2]) + Number(gen[3] ?? 0) / 10;
    return version >= (gen[1] === 'opus' ? 4.8 : 5.5);
}

/** Does a 400 body reject a mid-conversation system message? */
function isSystemRoleRejection(detail: string): boolean {
    return /role\W+system/i.test(detail);
}

/** Does a 400 body blame the thinking/effort tuning (vs. the prompt itself)? */
function isTuningRejection(detail: string): boolean {
    return /thinking|effort|output_config/i.test(detail);
}

/**
 * Does the model run Anthropic's safety classifiers, and so get the
 * server-side refusal fallback? Fable, Mythos, Opus 5+, Sonnet 5.5+.
 *
 * A classifier decline is an HTTP 200 with `stop_reason: "refusal"` and no
 * text, and it tends to repeat: the append-only session log resends whatever
 * tripped it on every later turn. `fallbacks: "default"` has the API re-run
 * a declined request on the model Anthropic recommends for that refusal
 * category, inside the same call, and keeps the conversation on that model
 * for about an hour (sticky routing), so the sit carries on in a slightly
 * different voice instead of going quiet. Categories with no recommended
 * fallback (reasoning_extraction) still come back as refusals.
 *
 * A model this guesses wrong on is caught by `send()`: a 400 naming the
 * fallback gets one retry without it, and the provider stays that way.
 */
export function takesRefusalFallback(model: string): boolean {
    const m = model.toLowerCase();
    if (/^claude-(fable|mythos)-/.test(m)) return true;
    const gen = /^claude-(opus|sonnet)-(\d+)(?:-(\d)(?!\d))?/.exec(m);
    if (!gen) return false;
    const version = Number(gen[2]) + Number(gen[3] ?? 0) / 10;
    return version >= (gen[1] === 'opus' ? 5 : 5.5);
}

/** The beta that takes the `"default"` form of `fallbacks`. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Does a 400 body reject the refusal fallback? */
function isFallbackRejection(detail: string): boolean {
    return /fallback/i.test(detail);
}

/** The default 5-minute TTL, on the rolling tail. */
const CACHE_5M = { type: 'ephemeral' } as const;

export interface AnthropicProviderOptions {
    apiKey: string;
    model?: string;
    maxTokens?: number;
    /** Endpoint URL, default Anthropic's hosted API. */
    baseUrl?: string;
    /**
     * Send `anthropic-dangerous-direct-browser-access`, which opts a
     * browser-origin request into Anthropic's CORS allowance. Required to call
     * api.anthropic.com from a webview (hosted web, Tauri, Capacitor); without
     * it the preflight fails and every turn dies on a network error.
     *
     * "Dangerous" is Anthropic's name for the general case - a key shipped to
     * untrusted browsers. Here the key is the user's own BYOK key, typed into
     * their own browser and never leaving it, which is the case the flag exists
     * for. Harmless from Node, but off by default so it's an explicit choice.
     */
    directBrowserAccess?: boolean;
    /** Override fetch for testing. */
    fetchImpl?: typeof fetch;
    /**
     * Retries on transient upstream failures (429 / 5xx / network), default 3
     * (retry.ts). Anthropic, Haiku especially, returns 429 and 529 under load;
     * without retry a single hiccup kills the turn (mid-session turns failed
     * ~5/6 of the time).
     */
    maxRetries?: number;
    /** Override the inter-retry sleep (tests inject a no-op to stay fast). */
    sleepImpl?: SleepFn;
}

interface AnthropicUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    /** Per-TTL breakdown. The flat field above stays the total (5m + 1h);
     *  nothing here writes at 1h any more, but the split is still billed when
     *  it is reported. */
    cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
    };
    output_tokens_details?: { thinking_tokens?: number };
    /** One entry per model that ran, on a call with `fallbacks` set: a model
     *  that declined is a `message` entry, the one that answered after it a
     *  `fallback_message`. The fields above cover only the answering one. */
    iterations?: AnthropicIteration[];
}

interface AnthropicIteration {
    type?: string;
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_creation?: { ephemeral_1h_input_tokens?: number };
}

/** Set only when stop_reason is "refusal". */
interface AnthropicStopDetails {
    category?: string | null;
}

interface AnthropicMessagesResponse {
    model?: string;
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string | null;
    stop_details?: AnthropicStopDetails | null;
    usage?: AnthropicUsage;
}

export class AnthropicProvider implements LLMProvider {
    readonly model: string;
    readonly maxTokens: number;
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly directBrowserAccess: boolean;
    private readonly fetchImpl: typeof fetch;
    private readonly retry: RetryOptions;

    constructor(options: AnthropicProviderOptions) {
        if (!options.apiKey) throw new Error('Anthropic API key required.');
        this.apiKey = options.apiKey;
        this.model = options.model ?? DEFAULT_MODEL;
        this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.baseUrl = options.baseUrl ?? ANTHROPIC_API_URL;
        this.directBrowserAccess = options.directBrowserAccess ?? false;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
        this.retry = retryOptions(options);
    }

    /** Set once a model 400s on the thinking tuning; every later turn skips it. */
    private tuningRejected = false;
    /** Set once a model 400s on a mid-conversation system message. */
    private systemRoleRejected = false;
    /** Set once a model 400s on the refusal fallback. */
    private fallbackRejected = false;

    private buildRequest(
        messages: Message[],
        options: CompletionOptions,
        stream: boolean,
        tune: boolean
    ): { url: string; init: RequestInit; tuned: boolean; systemRole: boolean; fallback: boolean } {
        const systemRole =
            !this.systemRoleRejected &&
            supportsMidConversationSystem(this.model) &&
            messages.some((m, i) => i > 0 && m.role === 'system');
        const convo = renderConversation(messages, systemRole);
        const tailIndex = cacheableAtOrBefore(convo, convo.length - 1);

        const anthropicMessages = convo.map((m, i) =>
            i === tailIndex
                ? { role: m.role, content: [{ type: 'text', text: m.content, cache_control: CACHE_5M }] }
                : { role: m.role, content: m.content }
        );

        const systemParam = options.system
            ? [{ type: 'text', text: options.system }]
            : undefined;

        const body: Record<string, unknown> = {
            model: this.model,
            max_tokens: options.maxTokens ?? this.maxTokens,
            messages: anthropicMessages,
            ...(stream && { stream: true }),
        };
        if (systemParam) body['system'] = systemParam;
        // Every branch exists so the facilitator speaks sooner (see thinkingPolicy).
        const policy = tune ? thinkingPolicy(this.model) : 'none';
        if (policy === 'always-on') body['output_config'] = { effort: 'low' };
        if (policy === 'between-tools') body['thinking'] = { type: 'between_tools' };
        if (policy === 'opt-out') body['thinking'] = { type: 'disabled' };
        const fallback = !this.fallbackRejected && takesRefusalFallback(this.model);
        if (fallback) body['fallbacks'] = 'default';

        const headers: Record<string, string> = {
            'content-type': 'application/json',
            'anthropic-version': ANTHROPIC_API_VERSION,
        };
        if (fallback) headers['anthropic-beta'] = FALLBACK_BETA;
        headers['x-api-key'] = this.apiKey;
        if (this.directBrowserAccess) headers['anthropic-dangerous-direct-browser-access'] = 'true';
        if (stream) headers['accept'] = 'text/event-stream';

        return {
            url: this.baseUrl,
            init: {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                ...(options.signal && { signal: options.signal }),
            },
            tuned: policy !== 'none',
            systemRole,
            fallback,
        };
    }

    /**
     * One request, tuned per thinkingPolicy, with mid-conversation system
     * messages where supportsMidConversationSystem says so and the refusal
     * fallback where takesRefusalFallback does. A 400 that rejects any of those
     * guesses gets a retry without it, and the provider stays that way for the
     * session - the safety net for a family whose rules don't match.
     * Resolves to an ok response or throws.
     */
    private async send(
        messages: Message[],
        options: CompletionOptions,
        stream: boolean
    ): Promise<Response> {
        for (;;) {
            const req = this.buildRequest(messages, options, stream, !this.tuningRejected);
            const response = await fetchWithRetry(this.fetchImpl, req.url, req.init, this.retry);
            if (response.ok) return response;
            const detail = await response.text().catch(() => '');
            if (response.status === 400 && req.systemRole && isSystemRoleRejection(detail)) {
                this.systemRoleRejected = true;
                continue;
            }
            // Before the tuning check: a fallback 400 may also name thinking.
            if (response.status === 400 && req.fallback && isFallbackRejection(detail)) {
                this.fallbackRejected = true;
                continue;
            }
            if (response.status === 400 && req.tuned && isTuningRejection(detail)) {
                this.tuningRejected = true;
                continue;
            }
            throw new Error(`Anthropic API error ${response.status}: ${detail}`);
        }
    }

    async complete(messages: Message[], options: CompletionOptions = {}): Promise<CompletionResult> {
        const response = await this.send(messages, options, false);

        const data = (await response.json()) as AnthropicMessagesResponse;
        // Take the TEXT blocks, not content[0]: an always-thinking model (Fable
        // 5) leads with a `thinking` block, so content[0].text is undefined and
        // the response would be dropped. Joining survives any block ordering.
        const text = (data.content ?? [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('');

        return {
            text,
            finishReason: data.stop_reason ?? null,
            ...usageToResult(data.usage, data.stop_details, data.model),
        };
    }

    async *completeStream(
        messages: Message[],
        options: CompletionOptions = {}
    ): AsyncIterable<StreamChunk> {
        const response = await this.send(messages, options, true);

        let stopReason: string | null = null;
        let stopDetails: AnthropicStopDetails | null | undefined;
        let servedModel: string | undefined;
        let usage: AnthropicUsage | undefined;

        for await (const evt of iterateSseEvents(response)) {
            if (evt.event === 'content_block_delta') {
                const parsed = safeJson<{ delta?: { type?: string; text?: string } }>(evt.data);
                const delta = parsed?.delta;
                if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                    yield { text: delta.text, done: false };
                }
            } else if (evt.event === 'message_start') {
                // Input + cache tokens arrive here, output tokens in
                // message_delta, so merge both.
                // After a decline before any output, `model` here already
                // names the fallback that is answering.
                const parsed = safeJson<{ message?: { model?: string; usage?: AnthropicUsage } }>(evt.data);
                if (parsed?.message?.model) servedModel = parsed.message.model;
                if (parsed?.message?.usage) usage = { ...usage, ...parsed.message.usage };
            } else if (evt.event === 'message_delta') {
                const parsed = safeJson<{
                    delta?: { stop_reason?: string | null; stop_details?: AnthropicStopDetails | null };
                    usage?: AnthropicUsage;
                }>(evt.data);
                if (parsed?.delta?.stop_reason !== undefined) {
                    stopReason = parsed.delta.stop_reason;
                }
                if (parsed?.delta?.stop_details !== undefined) {
                    stopDetails = parsed.delta.stop_details;
                }
                if (parsed?.usage) usage = { ...usage, ...parsed.usage };
            } else if (evt.event === 'message_stop') {
                break;
            }
        }

        yield {
            text: '',
            done: true,
            finishReason: stopReason,
            ...usageToResult(usage, stopDetails, servedModel),
        };
    }

    /**
     * Read the cache entry the request for `messages` left at its tail, so it
     * lives another five minutes. The request is the one `complete()` builds
     * for the same messages and options, at max_tokens 0 and not streamed:
     * nothing is generated and only the read is billed. Thinking and effort
     * stay as the real call sends them, since both render into the cached
     * prompt.
     *
     * One fetch and none of send()'s retries: a 400 here must not flip the
     * flags the real turns are built with, or the next turn would miss the
     * entry this exists to keep. Any failure throws.
     */
    async keepAlive(messages: Message[], options: CompletionOptions = {}): Promise<CompletionResult> {
        const req = this.buildRequest(messages, { ...options, maxTokens: 0 }, false, !this.tuningRejected);
        const response = await this.fetchImpl(req.url, req.init);
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Anthropic API error ${response.status}: ${detail}`);
        }
        const data = (await response.json()) as AnthropicMessagesResponse;
        return {
            text: '',
            finishReason: data.stop_reason ?? null,
            ...usageToResult(data.usage, data.stop_details, data.model),
        };
    }
}

/**
 * The session log as Messages API turns, one message per entry. Nothing is
 * merged or inserted (consecutive same-role messages are legal; the API joins
 * them), so the rendering of an entry never depends on what comes after it
 * and each request extends the previous one byte for byte.
 *
 * A `system` entry (a phase note) stays a system message only where the API
 * takes it: `systemRole` on, after a user message, and last or followed by an
 * assistant turn. Anywhere else, and on every model without the feature, it
 * is sent as user text. Placement is re-judged each request, so an entry whose
 * reply was discarded switches to user text once a later user turn follows
 * it: one cache miss from that point, in a rare path.
 *
 * A leading system entry is dropped (the system prompt travels in `system`)
 * and an assistant opening gets a user stub; neither happens with a session
 * log, which starts with the opener instruction.
 */
function renderConversation(messages: Message[], systemRole: boolean): Message[] {
    const out: Message[] = [];
    messages.forEach((m, i) => {
        if (m.role !== 'system') {
            out.push({ role: m.role, content: m.content });
            return;
        }
        if (i === 0) return;
        const next = messages[i + 1];
        const placed =
            messages[i - 1]?.role === 'user' && (next === undefined || next.role === 'assistant');
        out.push(
            systemRole && placed
                ? { role: 'system', content: m.content }
                : { role: 'user', content: systemNoteAsUserText(m.content) }
        );
    });
    if (out[0]?.role === 'assistant') {
        out.unshift({ role: 'user', content: '[Resuming a previous session.]' });
    }
    return out;
}

/**
 * Index of the last message at or before `index` that isn't a system message
 * (-1 for none). Breakpoints stay off system messages (the API 400s
 * cache_control on the turn-scoped kind), so a trailing phase note's falls on
 * the user turn it follows; the note itself is read fresh once, then cached by
 * the next turn's breakpoint.
 */
function cacheableAtOrBefore(convo: Message[], index: number): number {
    let i = index;
    while (i >= 0 && convo[i]!.role === 'system') i--;
    return i;
}

/**
 * Map Anthropic's usage object to the CompletionResult split fields. Cache
 * fields appear only when prompt caching is active. `tokensUsed` is the
 * input+output sum for back-compat, excluding cache reads/creation.
 *
 * On a refusal the category is recorded in diagnostics. When a fallback model
 * answered (a `fallback_message` iteration), `attempts` lists every model that
 * ran so billing can price each at its own rates, and `servedBy` names the one
 * that answered; the top-level usage is that answering attempt's alone.
 */
function usageToResult(
    usage: AnthropicUsage | undefined,
    stopDetails?: AnthropicStopDetails | null,
    servedModel?: string
): {
    tokensUsed: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
    cacheCreation1hTokens: number | null;
    diagnostics?: CompletionDiagnostics;
    attempts?: CompletionAttempt[];
} {
    const diagnostics: CompletionDiagnostics = {};
    if (stopDetails) diagnostics.refusalCategory = stopDetails.category ?? null;
    const attempts = attemptsOf(usage);
    const served = attempts?.find((a) => a.fallback)?.model ?? (attempts ? servedModel : undefined);
    if (served) diagnostics.servedBy = served;
    if (!usage) {
        return {
            tokensUsed: null,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheCreationTokens: null,
            cacheCreation1hTokens: null,
            ...(Object.keys(diagnostics).length > 0 && { diagnostics }),
        };
    }
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const thinkingTokens = usage.output_tokens_details?.thinking_tokens;
    if (thinkingTokens !== undefined) diagnostics.thinkingTokens = thinkingTokens;
    return {
        tokensUsed: inputTokens + outputTokens,
        inputTokens,
        outputTokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? null,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? null,
        cacheCreation1hTokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? null,
        ...(Object.keys(diagnostics).length > 0 && { diagnostics }),
        ...(attempts && { attempts }),
    };
}

/**
 * The per-model attempts of a call that fell back, or undefined when one
 * model did all the work (no `fallback_message` iteration): then the
 * top-level usage is the whole bill. The answering attempt takes the
 * top-level counts, which carry the 1h cache-write split an iteration entry
 * may not.
 */
function attemptsOf(usage: AnthropicUsage | undefined): CompletionAttempt[] | undefined {
    const iterations = usage?.iterations;
    if (!iterations?.some((it) => it.type === 'fallback_message')) return undefined;
    return iterations.map((it) => {
        const fallback = it.type === 'fallback_message';
        const src = fallback ? usage! : it;
        return {
            model: it.model ?? '',
            fallback,
            inputTokens: src.input_tokens ?? 0,
            outputTokens: src.output_tokens ?? 0,
            cacheReadTokens: src.cache_read_input_tokens ?? 0,
            cacheCreationTokens: src.cache_creation_input_tokens ?? 0,
            cacheCreation1hTokens: src.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        };
    });
}
