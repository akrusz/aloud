import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const OLLAMA_URL = process.env['OLLAMA_URL'] ?? 'http://localhost:11434';
// Hosted aloud server (@aloud/server, Hono). Serves BOTH the app's own backend
// (/app/v1/*) and the hosted cloud service (/cloud/v1/*) in dev, so browser
// preview needs only this one server running — no Python/Flask. Defaults to the
// dev port in ts/server/.env.example; override with ALOUD_SERVER_URL.
const SERVER_URL = process.env['ALOUD_SERVER_URL'] ?? 'http://localhost:8787';

// Hosted-subpath build (ALOUD_HOSTED=1, via `npm run ui:build:hosted`): served
// at aloud.rest/app/ off the existing GitHub Pages site (docs/ on main). base
// '/app/' rebases asset URLs and feeds the router's deploy-base logic
// (route-base.ts → import.meta.env.BASE_URL); outDir is the repo-root docs/app
// so the build lands straight in the Pages tree. Dev/desktop builds keep base
// '/' → ui/dist. The cross-origin API base is separate (VITE_ALOUD_SERVER_URL).
const HOSTED = process.env['ALOUD_HOSTED'] === '1';

export default defineConfig({
    root: __dirname,
    base: HOSTED ? '/app/' : '/',
    server: {
        // Allow Vite to read CSS / TS sources from outside ui/ — we
        // import the existing app's CSS verbatim from src/web/static/.
        // Repo root is two levels up (../..).
        fs: {
            allow: [resolve(__dirname, '../..')],
        },
        // aloud's dev port. Reuses 4649 (the retired Flask port) now that the
        // browser preview no longer depends on Python — one memorable port for
        // "the app" in dev, matching `tauri dev` (tauri.conf.json devUrl).
        port: 4649,
        strictPort: false,
        proxy: {
            // Hosted aloud cloud service: auth, account, billing, and the
            // metered LLM/STT/TTS forwarding (/cloud/v1/*). The Hono server
            // speaks /cloud/v1 directly — no rewrite needed.
            '/cloud': SERVER_URL,
            // The app's own backend (/app/v1/*). Now served by the same Hono
            // server (routes/app.ts) — Flask is gone from the dev/browser-preview
            // path. No rewrite: Hono speaks /app/v1 natively. Desktop builds
            // don't use this proxy; they hit the Tauri Rust backend.
            // (meditation-pal-5d9)
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
    resolve: {
        alias: {
            '@core': resolve(__dirname, '../src'),
        },
    },
    build: {
        // Hosted build commits into the repo, so write to docs/app (repo root,
        // two levels up from ui/) and skip sourcemaps to keep the tree lean.
        outDir: HOSTED ? resolve(__dirname, '../../docs/app') : resolve(__dirname, 'dist'),
        emptyOutDir: true,
        sourcemap: !HOSTED,
    },
});
