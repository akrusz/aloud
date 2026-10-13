/**
 * In-memory CreditsStore for tests and local dev. NOT durable: restart loses
 * everything. Production uses sqlite-store.ts behind the same interface. Kept
 * dead simple; it's the reference implementation the real store must match.
 */

import type {
    Account,
    CreditsStore,
    Gift,
    GiftStatus,
    Identity,
    IdentityProvider,
    LedgerEntry,
    RetreatInvite,
    RetreatMembership,
    RetreatPass,
} from './store.js';
import type { UsageEvent } from './usage.js';
import type { Incident } from './incidents.js';
import { normalizeEmail } from '../auth/email-key.js';

const idKey = (provider: IdentityProvider, sub: string): string => `${provider}\0${sub}`;

export class MemoryCreditsStore implements CreditsStore {
    private accounts = new Map<string, Account>();
    private identities = new Map<string, Identity>(); // keyed by idKey
    private gifts = new Map<string, Gift>(); // keyed by id
    private entries = new Map<string, LedgerEntry[]>();
    private settings = new Map<string, string>();
    private usage: UsageEvent[] = [];
    private incidents: Incident[] = [];
    private grantKeys = new Set<string>(); // email grant keys ever granted
    private retreatPasses = new Map<string, RetreatPass>(); // keyed by id
    private retreatMembers: RetreatMembership[] = [];
    private retreatInvites: RetreatInvite[] = [];

    async getAccountById(id: string): Promise<Account | undefined> {
        return this.accounts.get(id);
    }

    async createAccount(account: Account): Promise<void> {
        this.accounts.set(account.id, account);
        this.entries.set(account.id, []);
    }

    async findLiveAccountByEmail(email: string): Promise<Account | undefined> {
        const target = normalizeEmail(email);
        // Oldest first, so a stable "primary" wins if duplicates ever coexist.
        return [...this.accounts.values()]
            .filter((a) => a.deletedAt == null && normalizeEmail(a.email) === target)
            .sort((a, b) => a.createdAt - b.createdAt)[0];
    }

    async setAccountEmailUpdates(accountId: string, optIn: boolean): Promise<void> {
        const account = this.accounts.get(accountId);
        if (!account) return;
        if (optIn) account.emailUpdates = true;
        else delete account.emailUpdates;
    }

    async getIdentity(provider: IdentityProvider, sub: string): Promise<Identity | undefined> {
        return this.identities.get(idKey(provider, sub));
    }

    async createIdentity(identity: Identity): Promise<void> {
        const k = idKey(identity.provider, identity.sub);
        if (this.identities.has(k)) {
            throw new Error('identity already linked to an account');
        }
        this.identities.set(k, { ...identity });
    }

    async getIdentitiesForAccount(accountId: string): Promise<Identity[]> {
        return [...this.identities.values()].filter((i) => i.accountId === accountId);
    }

    async markIdentityGranted(provider: IdentityProvider, sub: string): Promise<void> {
        const i = this.identities.get(idKey(provider, sub));
        if (i) i.grantedCredits = true;
    }

    async setIdentitySecret(
        provider: IdentityProvider,
        sub: string,
        secretHash: string
    ): Promise<void> {
        const i = this.identities.get(idKey(provider, sub));
        if (i) i.secretHash = secretHash;
    }

    async deleteIdentitiesForAccount(accountId: string): Promise<void> {
        for (const [k, i] of this.identities) {
            if (i.accountId === accountId) this.identities.delete(k);
        }
    }

    async markAccountDeleted(
        accountId: string,
        deletedAt: number,
        anonymizedEmail: string
    ): Promise<void> {
        const a = this.accounts.get(accountId);
        if (!a) return;
        a.deletedAt = deletedAt;
        a.email = anonymizedEmail;
        a.emailVerified = false;
        delete a.signupIp;
    }

    async clearSignupIpsBefore(cutoff: number): Promise<number> {
        let cleared = 0;
        for (const a of this.accounts.values()) {
            if (a.signupIp != null && a.createdAt <= cutoff) {
                delete a.signupIp;
                cleared++;
            }
        }
        return cleared;
    }

    async hasGrantKey(keyHash: string): Promise<boolean> {
        return this.grantKeys.has(keyHash);
    }

    async recordGrantKey(keyHash: string): Promise<boolean> {
        if (this.grantKeys.has(keyHash)) return false;
        this.grantKeys.add(keyHash);
        return true;
    }

    async createGift(gift: Gift): Promise<void> {
        for (const g of this.gifts.values()) {
            if (g.stripeSessionId === gift.stripeSessionId) return; // idempotent on payment
        }
        this.gifts.set(gift.id, { ...gift });
    }

    async getGiftById(id: string): Promise<Gift | undefined> {
        return this.gifts.get(id);
    }

    async getGiftByStripeSession(stripeSessionId: string): Promise<Gift | undefined> {
        return [...this.gifts.values()].find((g) => g.stripeSessionId === stripeSessionId);
    }

    async getPendingGiftsForEmail(email: string): Promise<Gift[]> {
        return [...this.gifts.values()].filter(
            (g) => g.status === 'pending' && g.recipientEmail === email
        );
    }

    async getReturnedGiftsForBuyer(buyerAccountId: string): Promise<Gift[]> {
        return [...this.gifts.values()].filter(
            (g) => g.status === 'returned' && g.buyerAccountId === buyerAccountId
        );
    }

    async pendingGiftsCreatedBefore(cutoff: number): Promise<Gift[]> {
        return [...this.gifts.values()].filter(
            (g) => g.status === 'pending' && g.createdAt <= cutoff
        );
    }

    async resolveGift(
        id: string,
        status: Exclude<GiftStatus, 'pending'>,
        resolvedAt: number
    ): Promise<boolean> {
        const g = this.gifts.get(id);
        if (!g || g.status !== 'pending') return false; // already resolved → no double-spend
        g.status = status;
        g.resolvedAt = resolvedAt;
        return true;
    }

    async transitionGift(
        id: string,
        from: GiftStatus,
        to: GiftStatus,
        resolvedAt: number
    ): Promise<boolean> {
        const g = this.gifts.get(id);
        if (!g || g.status !== from) return false; // lost the race / wrong state
        g.status = to;
        g.resolvedAt = resolvedAt;
        return true;
    }

    async appendEntry(entry: LedgerEntry): Promise<void> {
        const list = this.entries.get(entry.accountId);
        if (!list) throw new Error(`no such account: ${entry.accountId}`);
        // Mirror the sqlite idempotency guards (idx_ledger_purchase_ref /
        // idx_ledger_refund_ref): a duplicate (kind, reason) on an external-ref
        // kind is a replayed payment proof or re-delivered reversal, applied
        // exactly once. Reason embeds the globally-unique ref, hence the scan
        // across all accounts.
        if (entry.kind === 'purchase' || entry.kind === 'refund') {
            for (const existing of this.entries.values()) {
                if (existing.some((e) => e.kind === entry.kind && e.reason === entry.reason)) {
                    return;
                }
            }
        }
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

    async appendIncident(incident: Incident): Promise<void> {
        this.incidents.push(incident);
    }

    async incidentsSince(sinceTs: number): Promise<Incident[]> {
        return this.incidents.filter((i) => i.ts >= sinceTs).sort((a, b) => b.ts - a.ts);
    }

    async getSetting(key: string): Promise<string | undefined> {
        return this.settings.get(key);
    }

    async setSetting(key: string, value: string): Promise<void> {
        this.settings.set(key, value);
    }

    async createRetreatPass(pass: RetreatPass): Promise<void> {
        this.retreatPasses.set(pass.id, { ...pass });
    }

    async getRetreatPass(id: string): Promise<RetreatPass | undefined> {
        return this.retreatPasses.get(id);
    }

    async listRetreatPasses(): Promise<RetreatPass[]> {
        return [...this.retreatPasses.values()].sort((a, b) => b.createdAt - a.createdAt);
    }

    async revokeRetreatPass(id: string): Promise<void> {
        const p = this.retreatPasses.get(id);
        if (p) p.status = 'revoked';
    }

    async deleteRetreatPass(id: string): Promise<void> {
        this.retreatPasses.delete(id);
        this.retreatMembers = this.retreatMembers.filter((m) => m.passId !== id);
        this.retreatInvites = this.retreatInvites.filter((i) => i.passId !== id);
    }

    async addRetreatMember(membership: RetreatMembership): Promise<void> {
        const exists = this.retreatMembers.some(
            (m) => m.passId === membership.passId && m.accountId === membership.accountId
        );
        if (!exists) this.retreatMembers.push({ ...membership });
    }

    async listRetreatMembers(passId: string): Promise<RetreatMembership[]> {
        return this.retreatMembers
            .filter((m) => m.passId === passId)
            .sort((a, b) => a.joinedAt - b.joinedAt);
    }

    async activeRetreatPassForAccount(
        accountId: string,
        now: number
    ): Promise<RetreatPass | undefined> {
        const passIds = this.retreatMembers
            .filter((m) => m.accountId === accountId)
            .map((m) => m.passId);
        const active = passIds
            .map((id) => this.retreatPasses.get(id))
            .filter(
                (p): p is RetreatPass =>
                    p != null && p.status === 'active' && p.startsAt <= now && p.endsAt >= now
            )
            .sort((a, b) => b.endsAt - a.endsAt);
        return active[0];
    }

    async usageCreditsSince(accountId: string, sinceTs: number): Promise<number> {
        return this.usage
            .filter((e) => e.accountId === accountId && e.ts >= sinceTs)
            .reduce((sum, e) => sum + e.credits, 0);
    }

    async addRetreatInvite(invite: RetreatInvite): Promise<void> {
        const exists = this.retreatInvites.some(
            (i) => i.passId === invite.passId && i.email === invite.email
        );
        if (!exists) this.retreatInvites.push({ ...invite });
    }

    async listRetreatInvites(passId: string): Promise<RetreatInvite[]> {
        return this.retreatInvites
            .filter((i) => i.passId === passId)
            .sort((a, b) => a.invitedAt - b.invitedAt);
    }

    async invitesForEmail(email: string): Promise<RetreatInvite[]> {
        return this.retreatInvites
            .filter((i) => i.email === email)
            .sort((a, b) => a.invitedAt - b.invitedAt);
    }

    async removeRetreatInvite(passId: string, email: string): Promise<void> {
        this.retreatInvites = this.retreatInvites.filter(
            (i) => !(i.passId === passId && i.email === email)
        );
    }
}
