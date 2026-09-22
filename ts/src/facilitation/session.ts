/**
 * Session state and conversation context: the live transcript, the compute
 * usage tally, and the context-window strategy shaping LLM prompts.
 * Timestamps are unix seconds; callers format for display.
 */

import { realClock, type Clock } from '../clock.js';
import type { CompletionResult, StreamChunk } from '../llm/index.js';
import { isSyntheticEventTurn } from './session-timer.js';

export type Role = 'user' | 'assistant' | 'system';

/**
 * What a non-spoken exchange is for. Unset = a real turn (the meditator's words
 * or the facilitator's reply).
 *  - 'opener': the one-shot instruction that produced the greeting.
 *  - 'event': a check-in or timer event that the facilitator answered aloud.
 *  - 'phase': a staged-mode phase note (role 'system').
 *  - 'setting': a mid-sit change the frozen system prompt can't take (role
 *    'system'), e.g. voice commands switched on.
 *  - 'context': resume scaffolding (recap, hand-off note).
 */
export type ExchangeKind = 'opener' | 'event' | 'phase' | 'setting' | 'context';

/** The kinds that travel as a mid-conversation system note. */
export type SystemNoteKind = Extract<ExchangeKind, 'phase' | 'setting'>;

/**
 * One entry of the session log. The log is exactly what the model was sent,
 * append-only: a turn's request is the previous request plus what happened
 * since, so the prompt cache always extends (meditation-pal-8qai). Views that
 * show speech filter the control entries out (spokenExchanges).
 */
export interface Exchange {
    role: Role;
    content: string;
    /** Set on control entries (never spoken or shown); see ExchangeKind. */
    kind?: ExchangeKind;
    /** Unix timestamp in seconds. */
    timestamp: number;
    /** Display name, e.g. participant name in noting circles. */
    name?: string;
    /**
     * LLM usage, present only on assistant turns from a completion (not user
     * turns or static/fallback messages). Input and output stay SEPARATE
     * (priced very differently); cache fields appear only when non-zero.
     */
    tokensIn?: number;
    tokensOut?: number;
    cacheRead?: number;
    cacheCreation?: number;
}

/**
 * Running tally of compute consumed by a session. The three legs mirror the
 * metered-billing model (LLM tokens, STT seconds, TTS chars). `llmCalls` counts
 * every completion including off-transcript ones (summary, resume-intent,
 * noting labels), so totals can exceed the sum of per-exchange token counts.
 */
export interface SessionUsage {
    llmCalls: number;
    llmTokensIn: number;
    llmTokensOut: number;
    llmCacheRead: number;
    llmCacheCreation: number;
    sttSeconds: number;
    ttsChars: number;
}

/** One LLM completion's usage, as captured from a CompletionResult. */
export interface LlmUsage {
    tokensIn?: number | null;
    tokensOut?: number | null;
    cacheRead?: number | null;
    cacheCreation?: number | null;
    /** Subset of cacheCreation written at the 1h TTL (2x input vs the 5m
     *  default's 1.25x). Absent when the turn used no 1h breakpoint. */
    cacheCreation1h?: number | null;
}

/** The usage split of a completion result or final stream chunk. */
export function llmUsageOf(r: CompletionResult | StreamChunk): LlmUsage {
    return {
        tokensIn: r.inputTokens ?? null,
        tokensOut: r.outputTokens ?? null,
        cacheRead: r.cacheReadTokens ?? null,
        cacheCreation: r.cacheCreationTokens ?? null,
        cacheCreation1h: r.cacheCreation1hTokens ?? null,
    };
}

export function emptyUsage(): SessionUsage {
    return {
        llmCalls: 0,
        llmTokensIn: 0,
        llmTokensOut: 0,
        llmCacheRead: 0,
        llmCacheCreation: 0,
        sttSeconds: 0,
        ttsChars: 0,
    };
}

/**
 * True for an entry that is model context rather than speech. Sessions saved
 * before `kind` existed mark event turns only by their text prefix.
 */
export function isControlExchange(ex: Pick<Exchange, 'role' | 'content' | 'kind'>): boolean {
    if (ex.kind !== undefined || ex.role === 'system') return true;
    return ex.role === 'user' && isSyntheticEventTurn(ex.content);
}

/** The spoken turns only: what transcripts, recaps, and exports show. */
export function spokenExchanges<T extends Pick<Exchange, 'role' | 'content' | 'kind'>>(
    exchanges: readonly T[]
): T[] {
    return exchanges.filter((ex) => !isControlExchange(ex));
}

/** Did the meditator say anything? Gates saving a session at all. */
export function hasSpokenUserTurn(
    exchanges: ReadonlyArray<Pick<Exchange, 'role' | 'content' | 'kind'>>
): boolean {
    return exchanges.some((ex) => ex.role === 'user' && !isControlExchange(ex));
}

export interface SessionState {
    sessionId: string;
    /** Unix timestamp in seconds. */
    startTime: number;
    /** Unix timestamp in seconds. */
    endTime: number | null;
    exchanges: Exchange[];
    tags: string[];
    notes: string;
    /**
     * A ModeSpec id from modes.ts ('exploration', 'noting', 'felt_sense'). A
     * plain string so saved sessions survive modes coming and going across
     * releases. Optional for sessions saved before this field existed; the
     * history view falls back to inferring it from legacy `notes`.
     */
    meditationType?: string;
    /**
     * Active phase id for staged modes (StagedModeController). Persisted by
     * autosave so an interrupted session resumes where it left off.
     */
    modePhase?: string;
    /**
     * Human-readable name of the facilitating LLM ("Claude Fable 5", "Sonnet
     * (Subscription)"), so history can show who ran a session and a different
     * model resuming it is told who came before (buildResumeContext). Stamped
     * at save time from the live setup; omitted on older or unknown-model
     * sessions.
     */
    model?: string;
    /** The Provider id behind `model` ('claude_proxy', 'aloud'). Kept for
     *  history/analytics; display uses `model`. */
    provider?: string;
    /**
     * The session language (2-letter app code, e.g. 'en', 'zh'; language.ts).
     * Stamped at session start from the live setup so a resume keeps speaking
     * the language the sit began in. Absent on sessions from before the field
     * existed = 'en'.
     */
    language?: string;
    /** Compute usage tally. Always present on sessions started by this code. */
    usage: SessionUsage;
}

export type ContextStrategy = 'rolling' | 'full';

export interface SessionManagerOptions {
    contextStrategy?: ContextStrategy;
    /** Rolling-window size in MESSAGES, not exchange pairs. 'rolling' only. */
    windowSize?: number;
    clock?: Clock;
    /** Override for generated session IDs (default: date-based). */
    generateSessionId?: () => string;
}

function defaultSessionId(clock: Clock): string {
    const d = new Date(clock() * 1000);
    const pad = (n: number) => n.toString().padStart(2, '0');
    // Random suffix so two sessions started in the same second (a quick
    // end-and-restart) can't collide on the same store key.
    const suffix = Math.random().toString(36).slice(2, 6);
    return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
        `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${suffix}`
    );
}

export class SessionManager {
    readonly contextStrategy: ContextStrategy;
    readonly windowSize: number;
    private readonly clock: Clock;
    private readonly generateSessionId: () => string;

    private _state: SessionState | null = null;
    /** System notes waiting for the next user entry, by kind, in order. */
    private readonly pendingNotes = new Map<SystemNoteKind, string>();

    constructor(options: SessionManagerOptions = {}) {
        this.contextStrategy = options.contextStrategy ?? 'full';
        this.windowSize = options.windowSize ?? 10;
        this.clock = options.clock ?? realClock;
        this.generateSessionId =
            options.generateSessionId ?? (() => defaultSessionId(this.clock));
    }

    get state(): SessionState | null {
        return this._state;
    }

    get isActive(): boolean {
        return this._state !== null && this._state.endTime === null;
    }

    get duration(): number {
        if (this._state === null) return 0;
        const end = this._state.endTime ?? this.clock();
        return end - this._state.startTime;
    }

    startSession(sessionId?: string, meditationType?: string): SessionState {
        this._state = {
            sessionId: sessionId ?? this.generateSessionId(),
            startTime: this.clock(),
            endTime: null,
            exchanges: [],
            tags: [],
            notes: '',
            ...(meditationType !== undefined && { meditationType }),
            usage: emptyUsage(),
        };
        this.pendingNotes.clear();
        return this._state;
    }

    /** Record or clear the active staged-mode phase (SessionState.modePhase). */
    setModePhase(phaseId: string | null): void {
        if (this._state === null) return;
        if (phaseId === null) delete this._state.modePhase;
        else this._state.modePhase = phaseId;
    }

    endSession(): SessionState | null {
        if (this._state === null) return null;
        this._state.endTime = this.clock();
        return this._state;
    }

    addUserMessage(content: string, name?: string): void {
        this.requireActive().exchanges.push({
            role: 'user',
            content,
            timestamp: this.clock(),
            ...(name !== undefined && { name }),
        });
        this.flushSystemNotes();
    }

    /**
     * Append a control entry: model context that is never spoken or shown
     * (ExchangeKind). A 'user' control entry flushes pending system notes like
     * a spoken turn does.
     */
    addControlMessage(role: 'user' | 'assistant', content: string, kind: ExchangeKind): void {
        this.requireActive().exchanges.push({ role, content, kind, timestamp: this.clock() });
        if (role === 'user') this.flushSystemNotes();
    }

    /**
     * Queue a system note (a staged-mode phase, a mid-sit setting change). It
     * lands right after the next user entry, not now: a phase moves on the
     * facilitator's reply, and a system message the API accepts
     * mid-conversation must follow a user message. A newer note of the same
     * kind replaces one still pending.
     */
    queueSystemNote(content: string, kind: SystemNoteKind): void {
        this.pendingNotes.delete(kind);
        this.pendingNotes.set(kind, content);
    }

    private flushSystemNotes(): void {
        if (this.pendingNotes.size === 0) return;
        const exchanges = this.requireActive().exchanges;
        for (const [kind, content] of this.pendingNotes) {
            exchanges.push({ role: 'system', content, kind, timestamp: this.clock() });
        }
        this.pendingNotes.clear();
    }

    /**
     * Add an assistant (facilitator) message. Pass `usage` from the
     * CompletionResult for LLM turns, omit for static/fallback messages. Usage
     * is recorded on the exchange AND folded into the session tally, so callers
     * must not also call recordLlmUsage.
     */
    addAssistantMessage(content: string, name?: string, usage?: LlmUsage): void {
        const hasUsage =
            usage !== undefined &&
            (usage.tokensIn != null || usage.tokensOut != null);
        this.requireActive().exchanges.push({
            role: 'assistant',
            content,
            timestamp: this.clock(),
            ...(name !== undefined && { name }),
            ...(hasUsage && {
                tokensIn: usage.tokensIn ?? 0,
                tokensOut: usage.tokensOut ?? 0,
                ...(usage.cacheRead ? { cacheRead: usage.cacheRead } : {}),
                ...(usage.cacheCreation ? { cacheCreation: usage.cacheCreation } : {}),
            }),
        });
        if (hasUsage) this.recordLlmUsage(usage);
    }

    /**
     * Fold one LLM completion into the session usage tally. Call directly only
     * for off-transcript completions (summary, resume-intent, noting labels);
     * `addAssistantMessage` already calls it for on-transcript turns.
     */
    recordLlmUsage(usage: LlmUsage): void {
        if (this._state === null) return;
        const u = this._state.usage;
        u.llmCalls += 1;
        u.llmTokensIn += usage.tokensIn ?? 0;
        u.llmTokensOut += usage.tokensOut ?? 0;
        u.llmCacheRead += usage.cacheRead ?? 0;
        u.llmCacheCreation += usage.cacheCreation ?? 0;
    }

    /**
     * Accumulate STT audio seconds. Counts all transcriptions, including
     * speculative/command audio, since each consumes STT compute.
     */
    recordStt(seconds: number): void {
        if (this._state !== null && seconds) {
            this._state.usage.sttSeconds += seconds;
        }
    }

    /**
     * Accumulate server-side synthesized TTS characters. Browser
     * speechSynthesis isn't counted (no server compute).
     */
    recordTts(chars: number): void {
        if (this._state !== null && chars) {
            this._state.usage.ttsChars += chars;
        }
    }

    /** Append previously-saved exchanges, for session continuation. */
    loadExchanges(exchanges: ReadonlyArray<Partial<Exchange> & { role: Exchange['role']; content: string }>): void {
        const state = this.requireActive();
        for (const ex of exchanges) {
            state.exchanges.push({
                role: ex.role,
                content: ex.content,
                timestamp: ex.timestamp ?? 0,
                ...(ex.kind !== undefined && { kind: ex.kind }),
                ...(ex.name !== undefined && { name: ex.name }),
            });
        }
    }

    /**
     * Conversation history shaped for an LLM provider (role/content only):
     * the whole log, control entries included, exactly as recorded.
     *
     * The 'rolling' strategy returns at most `windowSize` MESSAGES, trimmed
     * forward to the nearest user-message boundary: a window opening on an
     * assistant message breaks providers that require alternation starting from
     * user. A window with no user message at all is returned as-is.
     */
    getContextMessages(): Array<{ role: Exchange['role']; content: string }> {
        if (this._state === null) return [];
        let exchanges = this._state.exchanges;
        if (this.contextStrategy === 'rolling') {
            exchanges = exchanges.slice(-this.windowSize);
            const firstUser = exchanges.findIndex((e) => e.role === 'user');
            if (firstUser > 0) exchanges = exchanges.slice(firstUser);
        }
        return exchanges.map((e) => ({ role: e.role, content: e.content }));
    }

    getLastUserMessage(): string | null {
        if (this._state === null) return null;
        for (let i = this._state.exchanges.length - 1; i >= 0; i--) {
            const ex = this._state.exchanges[i];
            if (ex && ex.role === 'user' && !isControlExchange(ex)) return ex.content;
        }
        return null;
    }

    addTag(tag: string): void {
        if (this._state === null) return;
        if (!this._state.tags.includes(tag)) {
            this._state.tags.push(tag);
        }
    }

    setNotes(notes: string): void {
        if (this._state === null) return;
        this._state.notes = notes;
    }

    private requireActive(): SessionState {
        if (this._state === null) {
            throw new Error('No active session');
        }
        return this._state;
    }
}
