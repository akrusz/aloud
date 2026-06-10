/**
 * Session state management and conversation context.
 *
 * Holds the live transcript (exchanges), per-session compute usage tally,
 * and the context-window strategy used to shape LLM prompts. Timestamps
 * are unix seconds; callers format for display themselves.
 */

import { realClock, type Clock } from '../clock.js';

export type Role = 'user' | 'assistant' | 'system';

export interface Exchange {
    role: Exclude<Role, 'system'>;
    content: string;
    /** Unix timestamp in seconds. */
    timestamp: number;
    /** Display name (e.g. participant name in noting circles). */
    name?: string;
    /**
     * LLM usage for assistant turns produced by a completion (omitted
     * otherwise — user turns and static/fallback facilitator messages).
     * Input and output are kept SEPARATE (priced very differently); cache
     * fields are included only when non-zero.
     */
    tokensIn?: number;
    tokensOut?: number;
    cacheRead?: number;
    cacheCreation?: number;
}

/**
 * Running tally of compute consumed by a session. Three legs mirror the
 * metered-billing model (LLM tokens + STT seconds + TTS chars). `llmCalls`
 * counts every completion, including off-transcript ones (summary,
 * resume-intent, noting labels), so totals here can exceed the sum of
 * per-exchange token counts.
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
    /** Subset of cacheCreation written at the 1h TTL (priced at 2x input vs the
     *  5m default's 1.25x). Null/absent when the turn used no 1h breakpoint. */
    cacheCreation1h?: number | null;
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
     * Which meditation flow produced this session — a ModeSpec id from
     * modes.ts ('exploration', 'noting', 'felt_sense', ...). Deliberately a
     * plain string so saved sessions survive modes coming and going across
     * releases. Optional for backward compatibility with sessions saved
     * before this field existed; the history view falls back to inferring
     * it from legacy `notes`.
     */
    meditationType?: string;
    /**
     * Active phase id for staged modes (StagedModeController). Persisted by
     * autosave so an interrupted session resumes in the phase it left off.
     */
    modePhase?: string;
    /** Compute usage tally. Always present on sessions started by this code. */
    usage: SessionUsage;
}

export type ContextStrategy = 'rolling' | 'full';

export interface SessionManagerOptions {
    contextStrategy?: ContextStrategy;
    /**
     * Rolling-window size, in MESSAGES (not user/assistant exchange pairs).
     * Only used when contextStrategy is 'rolling'.
     */
    windowSize?: number;
    clock?: Clock;
    /** Override for generated session IDs (defaults to date-based). */
    generateSessionId?: () => string;
}

function defaultSessionId(clock: Clock): string {
    const d = new Date(clock() * 1000);
    const pad = (n: number) => n.toString().padStart(2, '0');
    // Short random suffix so two sessions started in the same second
    // (e.g. a quick end-and-restart) can't collide on the same store key.
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
        return this._state;
    }

    /** Record (or clear) the active staged-mode phase — see SessionState.modePhase. */
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
    }

    /**
     * Add an assistant (facilitator) message to the session.
     *
     * Pass `usage` (from the CompletionResult that produced this message) for
     * LLM turns; omit it for static or fallback messages (no LLM call). When
     * usage is given, it's recorded on the exchange AND folded into the
     * session-level tally, so callers don't double-count.
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
     * Fold one LLM completion into the session usage tally. Use directly for
     * off-transcript completions (summary, resume-intent, noting labels);
     * `addAssistantMessage` calls this for on-transcript turns so callers
     * don't double-count.
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
     * Accumulate STT audio seconds transcribed this session. Counts all
     * transcriptions (including speculative/command audio) since each consumes
     * STT compute.
     */
    recordStt(seconds: number): void {
        if (this._state !== null && seconds) {
            this._state.usage.sttSeconds += seconds;
        }
    }

    /**
     * Accumulate TTS characters synthesized server-side this session.
     * Browser-side speechSynthesis isn't counted (no server compute).
     */
    recordTts(chars: number): void {
        if (this._state !== null && chars) {
            this._state.usage.ttsChars += chars;
        }
    }

    /** Append previously-saved exchanges, used for session continuation. */
    loadExchanges(exchanges: ReadonlyArray<Partial<Exchange> & { role: Exchange['role']; content: string }>): void {
        const state = this.requireActive();
        for (const ex of exchanges) {
            state.exchanges.push({
                role: ex.role,
                content: ex.content,
                timestamp: ex.timestamp ?? 0,
                ...(ex.name !== undefined && { name: ex.name }),
            });
        }
    }

    /**
     * Conversation history shaped for an LLM provider — role/content only.
     *
     * With the 'rolling' strategy, returns at most `windowSize` MESSAGES
     * (not exchange pairs), trimmed forward to the nearest user-message
     * boundary so the window always opens with a user turn — a window that
     * opens mid-exchange with an assistant message breaks providers that
     * require user/assistant alternation starting from user. If the window
     * contains no user message at all (degenerate), it's returned as-is.
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
            if (ex && ex.role === 'user') return ex.content;
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
