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
    /** Absolute origin of the aloud cloud for a deployed static build,
     *  e.g. https://api.aloud.example. Unset in dev — paths stay relative and
     *  the Vite proxy forwards them. */
    readonly VITE_ALOUD_CLOUD_URL?: string;
    /** Google OAuth *web* client id for the hosted sign-in (meditation-pal-rfb).
     *  When set, the UI offers real Google sign-in (google-signin.ts); unset, it
     *  falls back to the server's local dev sign-in. Must match one of the
     *  server's GOOGLE_CLIENT_IDS. Safe to ship in the bundle — a client id is
     *  public; the server verifies the resulting ID token against Google. */
    readonly VITE_GOOGLE_CLIENT_ID?: string;
    /** Sign in with Apple *Services ID* (meditation-pal-s75). Usually discovered
     *  at runtime from the server's /config, so this build-time bake is optional;
     *  when present it lets the Apple button paint before the probe resolves. */
    readonly VITE_APPLE_CLIENT_ID?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

/** Vite `?url` asset imports (the Silero model + ort WASM binary in
 *  silero-vad.ts): the module resolves to the asset's served URL. Declared
 *  here because the UI tsconfig deliberately omits `vite/client`. */
declare module '*?url' {
    const src: string;
    export default src;
}
