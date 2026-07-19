/**
 * Deploy-base-aware route helpers.
 *
 * The app is served at the site root (dev / desktop, Vite `base '/'`) or under a
 * subpath (aloud.rest/app/, `base '/app/'`). Vite inlines the base as
 * `import.meta.env.BASE_URL`, always trailing-slashed.
 *
 * The router (app.ts) thinks in relative in-app paths (`'/'`, `'/history'`);
 * these translate to/from `location.pathname` so pushState, popstate, and
 * initial deep links resolve under either base. API URLs are unaffected: those
 * are absolute cross-origin via VITE_ALOUD_CLOUD_URL (app-base/cloud-base.ts).
 *
 * The `*For(prefix, …)` functions take the prefix so the math is unit-testable
 * at both bases; `routePath`/`appPath` close over the build's actual base.
 */

/** Normalize a Vite base ('/', '/app/') to a join-ready prefix: '' at root,
 *  '/app' under a subpath (leading slash kept, trailing slash dropped). */
export function normalizePrefix(baseUrl: string): string {
    return (baseUrl || '/').replace(/\/+$/, '');
}

/** In-app route → absolute path to push into history. */
export function routePathFor(prefix: string, rel: string): string {
    if (rel === '/') return prefix === '' ? '/' : `${prefix}/`;
    return `${prefix}${rel}`;
}

/** Inverse of routePathFor. Leaves an unprefixed path untouched, so dev
 *  (prefix '') is a no-op. */
export function appPathFor(prefix: string, pathname: string): string {
    if (prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`))) {
        const rest = pathname.slice(prefix.length);
        return rest === '' ? '/' : rest;
    }
    return pathname || '/';
}

// '' at root (dev), '/app' under the hosted base.
const PREFIX = normalizePrefix(import.meta.env.BASE_URL);

/** Absolute history path for an in-app route. */
export function routePath(rel: string): string {
    return routePathFor(PREFIX, rel);
}

/** In-app path for a `location.pathname`, deploy base stripped. */
export function appPath(pathname: string): string {
    return appPathFor(PREFIX, pathname);
}

/** URL for a static public/ asset (e.g. '/audio/bell.mp3'). A bare absolute
 *  path 404s under the hosted '/app/' base. */
export function assetPath(rel: string): string {
    return `${PREFIX}${rel.startsWith('/') ? rel : `/${rel}`}`;
}
