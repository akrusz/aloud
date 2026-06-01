/**
 * Deploy-base-aware route helpers.
 *
 * The app is served either at the site root (dev / desktop, Vite `base '/'`) or
 * under a subpath (the hosted demo at aloud.rest/app/, `base '/app/'`). Vite
 * inlines the build base as `import.meta.env.BASE_URL` — always trailing-
 * slashed: `'/'` or `'/app/'`.
 *
 * The router (app.ts) thinks in *relative* in-app paths (`'/'`, `'/history'`,
 * `'/session'`); these helpers translate to/from the real `location.pathname`
 * so pushState/replaceState, popstate, and the initial deep-link resolve under
 * either base. API URLs are NOT affected — those are absolute, cross-origin to
 * the server via VITE_ALOUD_CLOUD_URL (see app-base.ts / cloud-base.ts).
 *
 * The `*For(prefix, …)` functions are pure (prefix passed in) so the prefix
 * math is unit-testable at both bases; the bound `routePath`/`appPath` exports
 * close over the build's actual base.
 */

/** Normalize a Vite base ('/', '/app/') to a join-ready prefix: '' at root,
 *  '/app' under a subpath (leading slash kept, trailing slash dropped). */
export function normalizePrefix(baseUrl: string): string {
    return (baseUrl || '/').replace(/\/+$/, '');
}

/** Translate an in-app route (`'/'`, `'/history'`) to the absolute path to push
 *  into history, given a normalized prefix. */
export function routePathFor(prefix: string, rel: string): string {
    if (rel === '/') return prefix === '' ? '/' : `${prefix}/`;
    return `${prefix}${rel}`;
}

/** Strip a normalized prefix from a `location.pathname`, returning the in-app
 *  path (leading slash; `'/'` at the app root). Inverse of routePathFor; leaves
 *  an unprefixed path untouched so dev (prefix '') is a no-op. */
export function appPathFor(prefix: string, pathname: string): string {
    if (prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`))) {
        const rest = pathname.slice(prefix.length);
        return rest === '' ? '/' : rest;
    }
    return pathname || '/';
}

// '' at root (dev), '/app' under the hosted base — bound to this build's base.
const PREFIX = normalizePrefix(import.meta.env.BASE_URL);

/** Absolute history path for an in-app route, prefixed with the deploy base. */
export function routePath(rel: string): string {
    return routePathFor(PREFIX, rel);
}

/** In-app path for the current `location.pathname`, with the deploy base
 *  stripped. */
export function appPath(pathname: string): string {
    return appPathFor(PREFIX, pathname);
}
