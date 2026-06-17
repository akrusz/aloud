/**
 * Dependency container — everything the routes need, assembled once at boot
 * and threaded through. Keeps routes pure (no module-level singletons) and
 * makes tests trivial: build a Deps with a MemoryCreditsStore and a fake key
 * set, no network.
 */

import type { Config } from './config.js';
import type { CreditsStore } from './credits/store.js';
import { MemoryCreditsStore } from './credits/memory-store.js';
import { SqliteCreditsStore } from './credits/sqlite-store.js';
import { Ledger } from './credits/ledger.js';
import { Forwarder } from './providers/forward.js';
import { FreeGrantBreaker, RateGuard } from './quota/freetier.js';

export interface Deps {
    config: Config;
    store: CreditsStore;
    ledger: Ledger;
    forwarder: Forwarder;
    rateGuard: RateGuard;
    grantBreaker: FreeGrantBreaker;
}

export interface BuildDepsOptions {
    store?: CreditsStore;
}

export function buildDeps(config: Config, options: BuildDepsOptions = {}): Deps {
    // Persistence selection: an explicit store wins (tests inject a
    // MemoryCreditsStore); otherwise a configured dbPath gives a durable
    // SQLite store (any real deploy), and with neither we fall back to
    // in-memory for zero-config local dev. The in-memory store loses the
    // ledger on restart — fine for dev, never for a deploy holding real
    // balances, which is why production (strict) requires a dbPath (config.ts).
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
    };
}
