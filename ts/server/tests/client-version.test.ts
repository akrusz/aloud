/**
 * The minimum client version on GET /cloud/v1/config, and the build a client
 * names on GET /cloud/v1/me, stored on the account and listed for the admin.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import { MemoryCreditsStore } from '../src/credits/memory-store.js';
import { SqliteCreditsStore } from '../src/credits/sqlite-store.js';
import { issueSessionToken } from '../src/auth/session.js';
import { MIN_CLIENT_VERSION, parseClientReport } from '../src/min-client-version.js';
import type { CreditsStore } from '../src/credits/store.js';

const ADMIN_TOKEN = 'admin-token-for-client-version';
// loadConfig's dev fallback secret, which the test app signs sessions with.
const SECRET = 'dev-insecure-secret';

function makeApp(store: CreditsStore = new MemoryCreditsStore()) {
    const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-test', ALOUD_ADMIN_TOKEN: ADMIN_TOKEN });
    return { app: createApp(buildDeps(config, { store })), store };
}

async function signedIn(store: CreditsStore, id = 'acct-1'): Promise<string> {
    await store.createAccount({ id, email: `${id}@example.com`, emailVerified: true, createdAt: 1000 });
    return issueSessionToken(id, SECRET);
}

describe('GET /cloud/v1/config minClientVersion', () => {
    it('serves the checked-in minimum for every platform with a store build', async () => {
        const res = await makeApp().app.request('/cloud/v1/config');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { minClientVersion: Record<string, string> };
        expect(body.minClientVersion).toEqual(MIN_CLIENT_VERSION);
        expect(Object.keys(body.minClientVersion).sort()).toEqual(['android', 'desktop', 'ios']);
    });

    it('checks in only plain versions, which release.sh writes and compares', () => {
        for (const version of Object.values(MIN_CLIENT_VERSION)) {
            expect(version).toMatch(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
        }
    });

    it('shows the same minimums read-only in the admin config', async () => {
        const res = await makeApp().app.request('/cloud/v1/admin/config', {
            headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { minClientVersion: unknown }).minClientVersion).toEqual(MIN_CLIENT_VERSION);
    });
});

describe('parseClientReport', () => {
    it('takes a release or pre-release version on a known platform', () => {
        expect(parseClientReport('2.20.1', 'desktop')).toEqual({ version: '2.20.1', platform: 'desktop' });
        expect(parseClientReport('2.21.0-rc.1', 'ios')).toEqual({ version: '2.21.0-rc.1', platform: 'ios' });
        expect(parseClientReport('2.20.1', 'web')).toEqual({ version: '2.20.1', platform: 'web' });
    });

    it('refuses anything else, so nothing but a version and a platform is stored', () => {
        expect(parseClientReport(undefined, 'desktop')).toBeNull();
        expect(parseClientReport('2.20.1', undefined)).toBeNull();
        expect(parseClientReport('2.20.1', 'windows')).toBeNull();
        expect(parseClientReport('2.20', 'android')).toBeNull();
        expect(parseClientReport('v2.20.1', 'android')).toBeNull();
        expect(parseClientReport('2.20.1<script>', 'android')).toBeNull();
        expect(parseClientReport(`2.20.1-${'x'.repeat(17)}`, 'android')).toBeNull();
        expect(parseClientReport('12345.0.0', 'android')).toBeNull();
    });
});

describe('GET /cloud/v1/me records the build it was called from', () => {
    it('stores a named build with when it was seen, and lists it for the admin', async () => {
        const { app, store } = makeApp();
        const jwt = await signedIn(store);
        const before = Date.now() / 1000;
        const res = await app.request('/cloud/v1/me?v=2.19.0&platform=desktop', {
            headers: { authorization: `Bearer ${jwt}` },
        });
        expect(res.status).toBe(200);
        const seen = (await store.getAccountById('acct-1'))?.lastClient;
        expect(seen).toMatchObject({ version: '2.19.0', platform: 'desktop' });
        expect(seen!.seenAt).toBeGreaterThanOrEqual(before);

        const list = await app.request('/cloud/v1/admin/accounts', {
            headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        });
        const rows = (await list.json()) as Array<{ id: string; lastClient: unknown }>;
        expect(rows.find((r) => r.id === 'acct-1')?.lastClient).toEqual(seen);
    });

    it('leaves the stored build alone on a plain call or a malformed one, and still answers', async () => {
        const { app, store } = makeApp();
        const jwt = await signedIn(store);
        const headers = { authorization: `Bearer ${jwt}` };
        await app.request('/cloud/v1/me?v=2.20.1&platform=android', { headers });
        const first = (await store.getAccountById('acct-1'))?.lastClient;

        for (const path of ['/cloud/v1/me', '/cloud/v1/me?v=nope&platform=android', '/cloud/v1/me?v=2.21.0&platform=tv']) {
            const res = await app.request(path, { headers });
            expect(res.status).toBe(200);
        }
        expect((await store.getAccountById('acct-1'))?.lastClient).toEqual(first);
    });

    it('lists null for an account never seen since recording began', async () => {
        const { app, store } = makeApp();
        await signedIn(store);
        const list = await app.request('/cloud/v1/admin/accounts', {
            headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        });
        const rows = (await list.json()) as Array<{ id: string; lastClient: unknown }>;
        expect(rows.find((r) => r.id === 'acct-1')?.lastClient).toBeNull();
    });
});

describe.each([
    ['MemoryCreditsStore', () => new MemoryCreditsStore()],
    ['SqliteCreditsStore(:memory:)', () => new SqliteCreditsStore(':memory:')],
] as Array<[string, () => CreditsStore]>)('last-seen build in %s', (_name, make) => {
    it('round-trips, replaces, and is scrubbed by deletion', async () => {
        const store = make();
        await store.createAccount({ id: 'acct-1', email: 'a@example.com', emailVerified: true, createdAt: 100 });
        expect((await store.getAccountById('acct-1'))?.lastClient).toBeUndefined();
        await store.setAccountLastClient('acct-1', { version: '2.19.0', platform: 'desktop', seenAt: 150 });
        await store.setAccountLastClient('acct-1', { version: '2.20.1', platform: 'ios', seenAt: 160 });
        expect((await store.getAccountById('acct-1'))?.lastClient).toEqual({ version: '2.20.1', platform: 'ios', seenAt: 160 });
        await store.markAccountDeleted('acct-1', 200, 'deleted+acct-1@deleted.invalid');
        expect((await store.getAccountById('acct-1'))?.lastClient).toBeUndefined();
    });
});

describe('SqliteCreditsStore last-client columns', () => {
    it('adds them to a DB that predates them, old rows reading as never seen', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'aloud-last-client-'));
        const path = join(dir, 'db.sqlite');
        try {
            const old = new DatabaseSync(path);
            old.exec(`
                CREATE TABLE accounts (
                    id TEXT PRIMARY KEY, email TEXT NOT NULL, email_verified INTEGER NOT NULL,
                    created_at REAL NOT NULL, signup_ip TEXT
                );
                INSERT INTO accounts VALUES ('acct-1','a@example.com',1,100,NULL);
            `);
            old.close();

            const store = new SqliteCreditsStore(path);
            expect((await store.getAccountById('acct-1'))?.lastClient).toBeUndefined();
            await store.setAccountLastClient('acct-1', { version: '2.20.1', platform: 'android', seenAt: 150 });
            store.close();

            // And it survives a reopen, where the columns already exist.
            const reopened = new SqliteCreditsStore(path);
            expect((await reopened.getAccountById('acct-1'))?.lastClient).toEqual({
                version: '2.20.1',
                platform: 'android',
                seenAt: 150,
            });
            reopened.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
