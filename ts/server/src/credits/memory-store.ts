/**
 * In-memory CreditsStore for tests and local dev. NOT durable — restart loses
 * everything. Production swaps in a SQLite/Postgres implementation of the same
 * interface (see store.ts). Kept dead simple on purpose; it's the reference
 * implementation the real store must behave identically to.
 */

import type { Account, CreditsStore, LedgerEntry } from './store.js';
import type { UsageEvent } from './usage.js';

export class MemoryCreditsStore implements CreditsStore {
    private accounts = new Map<string, Account>();
    private bySub = new Map<string, string>();
    private entries = new Map<string, LedgerEntry[]>();
    private settings = new Map<string, string>();
    private usage: UsageEvent[] = [];

    async getAccountByGoogleSub(sub: string): Promise<Account | undefined> {
        const id = this.bySub.get(sub);
        return id ? this.accounts.get(id) : undefined;
    }

    async getAccountById(id: string): Promise<Account | undefined> {
        return this.accounts.get(id);
    }

    async createAccount(account: Account): Promise<void> {
        if (this.bySub.has(account.googleSub)) {
            throw new Error('account already exists for this Google identity');
        }
        this.accounts.set(account.id, account);
        this.bySub.set(account.googleSub, account.id);
        this.entries.set(account.id, []);
    }

    async appendEntry(entry: LedgerEntry): Promise<void> {
        const list = this.entries.get(entry.accountId);
        if (!list) throw new Error(`no such account: ${entry.accountId}`);
        list.push(entry);
    }

    async listEntries(accountId: string): Promise<LedgerEntry[]> {
        return [...(this.entries.get(accountId) ?? [])];
    }

    async allAccounts(): Promise<Account[]> {
        return [...this.accounts.values()];
    }

    async allEntries(): Promise<LedgerEntry[]> {
        return [...this.entries.values()].flat();
    }

    async appendUsage(event: UsageEvent): Promise<void> {
        this.usage.push(event);
    }

    async allUsage(): Promise<UsageEvent[]> {
        return [...this.usage];
    }

    async getSetting(key: string): Promise<string | undefined> {
        return this.settings.get(key);
    }

    async setSetting(key: string, value: string): Promise<void> {
        this.settings.set(key, value);
    }
}
