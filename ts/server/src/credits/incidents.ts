/**
 * Incident log: things that went wrong on a metered call, kept where the
 * operator can see them (meditation-pal-xtgh).
 *
 * The app handles cloud failures quietly on purpose - a blank turn gets a
 * retry and a canned line, a 402 gets a spoken apology - because aloud cloud
 * is the convenience path and a meditator should never be shown a stack of
 * toasts. Quiet handling must not mean invisible, so every such event lands
 * here: server-observed ones straight from the routes, client-observed ones
 * via POST /cloud/v1/incidents. The admin panel's Incidents section reads
 * them back, grouped by kind.
 *
 * Same privacy line as the logger: a row carries WHAT happened (kind, finish
 * reason, token counts, HTTP status, an upstream error's first line), never
 * the meditation content it happened to.
 *
 * Writes are best-effort, like usage.ts: a telemetry failure never breaks a
 * request.
 */

import { randomUUID } from 'node:crypto';
import { log } from '../logger.js';
import type { CreditsStore } from './store.js';

/** Server-observed kinds, written by the routes. */
export const SERVER_INCIDENT_KINDS = [
    /** A completion returned no text at all (usually reasoning ate the budget). */
    'llm_empty',
    /** The upstream LLM call failed (stream or non-stream). */
    'llm_error',
    'stt_error',
    'tts_error',
    /** A metered call was refused for lack of credits. */
    'insufficient_credits',
] as const;

/** Client-observed kinds, accepted from the app. Prefixed so a row's origin
 *  reads at a glance and a client can't spoof a server-side kind. */
export const CLIENT_INCIDENT_KINDS = [
    /** The turn came back blank and the app retried it. */
    'client_llm_empty_retry',
    /** Blank twice; the app spoke a canned line instead. */
    'client_llm_empty_fallback',
    /** A cloud turn failed in the app (network, timeout, upstream). */
    'client_llm_error',
    /** Cloud TTS failed to synthesize or play. */
    'client_tts_error',
    /** Hosted STT failed. */
    'client_stt_error',
    /** The browser refused audio playback, so the voice went unheard. */
    'client_playback_blocked',
] as const;

export type ServerIncidentKind = (typeof SERVER_INCIDENT_KINDS)[number];
export type ClientIncidentKind = (typeof CLIENT_INCIDENT_KINDS)[number];
export type IncidentKind = ServerIncidentKind | ClientIncidentKind;

export function isClientIncidentKind(kind: unknown): kind is ClientIncidentKind {
    return typeof kind === 'string' && (CLIENT_INCIDENT_KINDS as readonly string[]).includes(kind);
}

export interface Incident {
    id: string;
    /** Seconds since epoch. */
    ts: number;
    accountId: string;
    /** Client-supplied meditation-session id, when the call carried one. */
    sessionId: string | null;
    kind: IncidentKind;
    /** 'server' for route-observed rows, 'client' for app-reported ones. */
    source: 'server' | 'client';
    /** Provider id, or '' when not applicable. */
    provider: string;
    /** Model / voice / STT model, or '' when not applicable. */
    model: string;
    /** Short, content-free description: finish reason, counts, an error's
     *  first line. Capped at MAX_DETAIL_CHARS. */
    detail: string;
}

export const MAX_DETAIL_CHARS = 240;

export type IncidentInput = Omit<Incident, 'id' | 'ts' | 'sessionId' | 'provider' | 'model' | 'detail'> &
    Partial<Pick<Incident, 'ts' | 'sessionId' | 'provider' | 'model' | 'detail'>>;

/** One line, capped, so an upstream stack trace can't bloat a row. */
export function clipDetail(detail: string): string {
    const line = detail.split('\n')[0]!.trim();
    return line.length > MAX_DETAIL_CHARS ? `${line.slice(0, MAX_DETAIL_CHARS - 1)}…` : line;
}

/** Record one incident. Never throws into the request path. */
export async function recordIncident(
    store: Pick<CreditsStore, 'appendIncident'>,
    input: IncidentInput
): Promise<void> {
    const incident: Incident = {
        id: randomUUID(),
        ts: input.ts ?? Date.now() / 1000,
        accountId: input.accountId,
        sessionId: input.sessionId ?? null,
        kind: input.kind,
        source: input.source,
        provider: input.provider ?? '',
        model: input.model ?? '',
        detail: clipDetail(input.detail ?? ''),
    };
    try {
        await store.appendIncident(incident);
    } catch (err) {
        log.warn('incident write failed (ignored)', { err: String(err), kind: input.kind });
    }
}

export interface IncidentKindSummary {
    kind: IncidentKind;
    source: 'server' | 'client';
    count: number;
    /** Distinct accounts affected. */
    accounts: number;
    /** Distinct sessions affected (rows without a session id count as none). */
    sessions: number;
}

export interface IncidentReport {
    sinceTs: number;
    total: number;
    byKind: IncidentKindSummary[];
    /** Newest first, capped by the caller. */
    recent: Incident[];
}

/** Pure aggregation over rows already filtered to the window. */
export function buildIncidentReport(rows: Incident[], sinceTs: number, recentLimit = 100): IncidentReport {
    const inWindow = rows.filter((r) => r.ts >= sinceTs);
    const groups = new Map<string, { rows: Incident[]; accounts: Set<string>; sessions: Set<string> }>();
    for (const r of inWindow) {
        let g = groups.get(r.kind);
        if (!g) {
            g = { rows: [], accounts: new Set(), sessions: new Set() };
            groups.set(r.kind, g);
        }
        g.rows.push(r);
        g.accounts.add(r.accountId);
        if (r.sessionId) g.sessions.add(r.sessionId);
    }
    const byKind: IncidentKindSummary[] = [...groups.entries()]
        .map(([kind, g]) => ({
            kind: kind as IncidentKind,
            source: g.rows[0]!.source,
            count: g.rows.length,
            accounts: g.accounts.size,
            sessions: g.sessions.size,
        }))
        .sort((a, b) => b.count - a.count);
    const recent = [...inWindow].sort((a, b) => b.ts - a.ts).slice(0, recentLimit);
    return { sinceTs, total: inWindow.length, byKind, recent };
}
