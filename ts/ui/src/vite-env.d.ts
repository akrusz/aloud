/**
 * Build-time environment for the UI. We don't pull in `vite/client` wholesale
 * (the UI tsconfig runs with `types: []` to keep the typecheck hermetic), so
 * declare just the env vars we read. Vite statically replaces
 * `import.meta.env.VITE_*` with literals at build time.
 */
interface ImportMetaEnv {
    /** Vite's build-mode flags. DEV is true under `vite dev`, false in any
     *  `vite build` output — we use it to hard-disable dev-only affordances
     *  (the `?mode=` override in app-mode.ts) in deployed builds. */
    readonly DEV: boolean;
    readonly PROD: boolean;
    /** The build's public base path, trailing-slashed: '/' for dev/desktop,
     *  '/app/' for the hosted-subpath build (vite.config.ts `base`). Drives the
     *  router's deploy-base logic (route-base.ts). */
    readonly BASE_URL: string;
    /** Absolute origin of the hosted aloud server for a deployed static build,
     *  e.g. https://api.aloud.example. Unset in dev — paths stay relative and
     *  the Vite proxy forwards them. */
    readonly VITE_ALOUD_SERVER_URL?: string;
    /** Google OAuth *web* client id for the hosted sign-in (meditation-pal-rfb).
     *  When set, the UI offers real Google sign-in (google-signin.ts); unset, it
     *  falls back to the server's local dev sign-in. Must match one of the
     *  server's GOOGLE_CLIENT_IDS. Safe to ship in the bundle — a client id is
     *  public; the server verifies the resulting ID token against Google. */
    readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
