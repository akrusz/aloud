import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Running app version, baked into the bundle as __APP_VERSION__ (update-check.ts
// compares it to the latest GitHub release). Source is ts/package.json (one
// level up — the UI has no package.json of its own), kept in lockstep with
// src-tauri/tauri.conf.json at release.
const APP_VERSION = JSON.parse(
    readFileSync(resolve(__dirname, '../package.json'), 'utf8')
).version as string;

// The commit the bundle was built from, baked in as __APP_COMMIT__ for the run
// record a saved session carries (session-run-record.ts): the short hash, with
// '-dirty' when tracked files have uncommitted changes, and '' wherever git
// can't answer (a CI tarball), so a build never fails on it. Read once at
// config load: a dev server keeps the commit it started on.
function gitCommit(): string {
    const git = (args: string[]): string =>
        execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    try {
        const hash = git(['rev-parse', '--short', 'HEAD']);
        if (!hash) return '';
        return git(['status', '--porcelain', '--untracked-files=no']) ? `${hash}-dirty` : hash;
    } catch {
        return '';
    }
}
const APP_COMMIT = gitCommit();

const OLLAMA_URL = process.env['OLLAMA_URL'] ?? 'http://localhost:11434';
// aloud cloud (@aloud/server, Hono). Serves BOTH the app's own backend
// (/app/v1/*) and the cloud service (/cloud/v1/*) in dev, so browser
// preview needs only this one server running. Defaults to the
// dev port in ts/server/.env.example; override with ALOUD_CLOUD_URL.
const SERVER_URL = process.env['ALOUD_CLOUD_URL'] ?? 'http://localhost:8787';

// Hosted-subpath build (ALOUD_HOSTED=1, via `npm run ui:build:hosted`): served
// at aloud.rest/app/ off the existing GitHub Pages site (docs/ on main). base
// '/app/' rebases asset URLs and feeds the router's deploy-base logic
// (route-base.ts → import.meta.env.BASE_URL); outDir is the repo-root docs/app
// so the build lands straight in the Pages tree. Dev/desktop builds keep base
// '/' → ui/dist. The cross-origin API base is separate (VITE_ALOUD_CLOUD_URL).
const HOSTED = process.env['ALOUD_HOSTED'] === '1';

// The dev app's audio and timing lines (ui/src/diag.ts), appended to a dated
// file under the repo's ignored .probe-data/, so a test pass in the desktop
// shell can be read afterwards without the Web Inspector.
const DIAG_DIR = resolve(__dirname, '../../.probe-data/dev-diag');
const diagFile: Plugin = {
    name: 'diag-file',
    apply: 'serve',
    configureServer(server) {
        server.middlewares.use('/__diag', (req, res) => {
            let body = '';
            req.on('data', (chunk: Buffer) => {
                if (body.length < 200_000) body += chunk;
            });
            req.on('end', () => {
                if (req.method === 'POST' && body) {
                    const now = new Date();
                    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
                    mkdirSync(DIAG_DIR, { recursive: true });
                    appendFileSync(resolve(DIAG_DIR, `${day}.log`), `${body}\n`);
                }
                res.statusCode = 204;
                res.end();
            });
        });
    },
};

export default defineConfig({
    root: __dirname,
    plugins: [diagFile],
    base: HOSTED ? '/app/' : '/',
    server: {
        // Allow Vite to read TS sources from outside ui/ — the UI imports the
        // shared engine from ts/src (@core). Repo root is two levels up (../..).
        fs: {
            allow: [resolve(__dirname, '../..')],
        },
        // aloud's dev port: one memorable port for "the app" in dev, matching
        // `tauri dev` (tauri.conf.json devUrl).
        port: 4649,
        strictPort: false,
        proxy: {
            // Hosted aloud cloud service: auth, account, billing, and the
            // metered LLM/STT/TTS forwarding (/cloud/v1/*). The Hono server
            // speaks /cloud/v1 directly — no rewrite needed.
            '/cloud': SERVER_URL,
            // The app's own backend (/app/v1/*), served by the same Hono
            // server (routes/app.ts). No rewrite: Hono speaks /app/v1
            // natively. Desktop builds don't use this proxy; they hit the
            // Tauri Rust backend. (meditation-pal-5d9)
            '/app': SERVER_URL,
            // Ollama is direct-to-local but we route through Vite so the
            // browser sees same-origin (no need to widen OLLAMA_ORIGINS).
            '/ollama': {
                target: OLLAMA_URL,
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/ollama/, ''),
            },
        },
    },
    define: {
        // Statically replaced everywhere __APP_VERSION__ appears (a bare global,
        // declared in vite-env.d.ts). JSON.stringify so it lands as a quoted
        // string literal in the output.
        __APP_VERSION__: JSON.stringify(APP_VERSION),
        __APP_COMMIT__: JSON.stringify(APP_COMMIT),
    },
    resolve: {
        alias: {
            '@core': resolve(__dirname, '../src'),
        },
    },
    build: {
        // Hosted build writes to docs/app (repo root, two levels up from ui/)
        // where deploy-web.yml picks it up and publishes docs/ to Pages as an
        // artifact — the output is gitignored, not committed. Skip sourcemaps.
        outDir: HOSTED ? resolve(__dirname, '../../docs/app') : resolve(__dirname, 'dist'),
        emptyOutDir: true,
        sourcemap: !HOSTED,
        // The ☁ glyph font (app-base.css) is in most views' first paint, and
        // is past Vite's 4kB inline limit. As its own request the
        // clouds would pop in after the text, so keep it inline in the CSS.
        assetsInlineLimit: (file) => (file.endsWith('aloud-cloud.woff2') ? true : undefined),
    },
});
