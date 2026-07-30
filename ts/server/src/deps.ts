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
import { FreeGrantBreaker, RateGuard } from './quota/freetier.js';
import { HttpModelProber, ModelLiveness } from './pricing/liveness.js';

export interface Deps {
    config: Config;
    store: CreditsStore;
    ledger: Ledger;
    forwarder: Forwarder;
    rateGuard: RateGuard;
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
        grantBreaker: new FreeGrantBreaker(config.freeGrantBudgetPerHour),
        liveness: new ModelLiveness(new HttpModelProber(config.providerKeys)),
    };
}
