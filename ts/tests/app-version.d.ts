/** The UI's vite define (ui/src/vite-env.d.ts), for the UI modules these tests
 *  import. Vitest defines no such global: at run time it is undefined, which
 *  client-version.ts runningVersion() allows for. */
declare const __APP_VERSION__: string;
