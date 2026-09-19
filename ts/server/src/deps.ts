/**
 * Dependency container: everything the routes need, assembled once at boot and
 * threaded through. No module-level singletons, so tests build a Deps with a
 * MemoryCreditsStore and fake keys, no network.
 */

import type { Config } from './config.js';
import type { CreditsStore } from './credits/store.js';
import { MemoryCreditsStore } from './credits/memory-store.js';
import { SqliteCreditsStore } from './credits/sqlite-store.js';
import { Ledger } from './credits/ledger.js';
import { Forwarder } from './providers/forward.js';
import { DailyCap, FreeGrantBreaker, RateGuard } from './quota/freetier.js';
import { HttpModelProber, ModelLiveness } from './pricing/liveness.js';

/** A busy sit makes 2-4 judge calls a minute; this leaves room for prefetching
 *  on speculative transcripts while still capping a runaway client. */
const JUDGE_REQUESTS_PER_MINUTE = 90;

/** The judge is free to any account, so this is the cost ceiling on a scripted
 *  one: under $1 a day at the command check's ~$0.00018 a call. A heavy sit (short replies every 15s, each prefetched
 *  once or twice) runs ~600 calls an hour, so this clears a full retreat day;
 *  past it an account with no credits falls back to the LLM classifiers and
 *  loses commands (routes/judge.ts lets one with a balance through). */
const JUDGE_REQUESTS_PER_DAY = 5000;

export interface Deps {
    config: Config;
    store: CreditsStore;
    ledger: Ledger;
    forwarder: Forwarder;
    rateGuard: RateGuard;
    /** /cloud/v1/judge only. Separate from rateGuard on purpose: judge calls
     *  are cheap, frequent and optional, and must never be what gets an LLM
     *  turn refused - nor be starved by a turn's TTS sentences. */
    judgeGuard: RateGuard;
    judgeDailyCap: DailyCap;
    grantBreaker: FreeGrantBreaker;
    /** Which allowlisted models the providers still serve. Everything reads
     *  live until index.ts's hourly sweep proves otherwise; tests never sweep,
     *  so they see the full allowlist unless they stub this. */
    liveness: ModelLiveness;
}

export interface BuildDepsOptions {
    store?: CreditsStore;
}

export function buildDeps(config: Config, options: BuildDepsOptions = {}): Deps {
    // Store precedence: injected (tests) > dbPath SQLite (real deploys) >
    // in-memory (zero-config dev). In-memory loses the ledger on restart, so
    // production (strict) requires a dbPath - see config.ts.
    const store =
        options.store ??
        (config.dbPath ? new SqliteCreditsStore(config.dbPath) : new MemoryCreditsStore());
    return {
        config,
        store,
        ledger: new Ledger(store),
        forwarder: new Forwarder(config.providerKeys),
        rateGuard: new RateGuard(),
        judgeGuard: new RateGuard(JUDGE_REQUESTS_PER_MINUTE),
        judgeDailyCap: new DailyCap(JUDGE_REQUESTS_PER_DAY),
        grantBreaker: new FreeGrantBreaker(config.freeGrantBudgetPerHour),
        liveness: new ModelLiveness(new HttpModelProber(config.providerKeys)),
    };
}
