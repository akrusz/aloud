/**
 * `npm run smoke`: the smoke suite (smoke.mjs) against this tree, before a
 * release. Builds the hosted UI the way deploy-web.yml does, but with aloud
 * cloud baked in as a Hono server started here, serves the build at /app/,
 * runs the suite, and stops everything it started.
 *
 * Its own ports, never the dev servers on 4649 and 8787: a dev server reloads
 * the page under the suite whenever a file is saved. The server reads
 * ts/server/.env like `npm run server:dev`, so the catalogs list what the
 * developer's keys unlock; the overrides below keep it off the dev ledger and
 * spend nothing.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';

const TS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(TS, 'server/.env'))) {
    console.log('smoke: no ts/server/.env, so the server has no keys: expect the catalog and sign-in checks to fail');
}

function sparePort() {
    return new Promise((done, fail) => {
        const s = createServer();
        s.once('error', fail);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => done(port));
        });
    });
}

const serverPort = await sparePort();
const uiPort = await sparePort();
const cloud = `http://127.0.0.1:${serverPort}`;
const app = `http://127.0.0.1:${uiPort}/app/`;
const outDir = await mkdtemp(join(tmpdir(), 'aloud-smoke-'));

let server = null;
let ui = null;
let serverLog = '';
const serverTail = () => `\naloud cloud server log:\n${serverLog.trim().split('\n').slice(-30).join('\n')}`;
async function stop() {
    await ui?.close().catch(() => {});
    if (server && server.exitCode === null) {
        const exited = new Promise((done) => server.once('exit', done));
        server.kill('SIGTERM');
        // It exits on its own within 4 s (index.ts shutdown); this is the backstop.
        const backstop = setTimeout(() => server.kill('SIGKILL'), 6000);
        await exited;
        clearTimeout(backstop);
    }
    await rm(outDir, { recursive: true, force: true });
}
process.once('SIGINT', () => void stop().then(() => process.exit(130)));

let code = 1;
try {
    server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: join(TS, 'server'),
        env: {
            ...process.env,
            PORT: String(serverPort),
            ALOUD_CORS_ORIGINS: new URL(app).origin,
            // In-memory ledger, not the dev's SQLite file.
            ALOUD_DB_PATH: '',
            // Boot warms the command judge with a paid call.
            TYPESAFE_API_KEY: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', (d) => (serverLog += d));
    server.stderr.on('data', (d) => (serverLog += d));

    console.log(`smoke: building the hosted UI with aloud cloud at ${cloud}`);
    process.env.ALOUD_HOSTED = '1';
    process.env.VITE_ALOUD_CLOUD_URL = cloud;
    await build({
        configFile: join(TS, 'ui/vite.config.ts'),
        build: { outDir, emptyOutDir: true },
        logLevel: 'error',
    });
    ui = await preview({
        configFile: false,
        base: '/app/',
        build: { outDir },
        preview: { host: '127.0.0.1', port: uiPort, strictPort: true },
        logLevel: 'error',
    });

    const t0 = Date.now();
    for (;;) {
        if (server.exitCode !== null) throw new Error(`the aloud cloud server exited (${server.exitCode})`);
        const up = await fetch(`${cloud}/health`).then((r) => r.ok, () => false);
        if (up) break;
        if (Date.now() - t0 > 30_000) throw new Error('the aloud cloud server did not answer /health within 30s');
        await new Promise((r) => setTimeout(r, 250));
    }

    const suite = spawn(process.execPath, [join(TS, 'smoke/smoke.mjs'), '--url', app, '--cloud', cloud], { stdio: 'inherit' });
    code = await new Promise((done) => suite.once('exit', (c) => done(c ?? 1)));
    if (code !== 0) console.log(serverTail());
} catch (e) {
    console.error(`smoke: ${e.message}`);
    if (serverLog) console.error(serverTail());
} finally {
    await stop();
}
process.exit(code);
