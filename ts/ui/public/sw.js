/* Service worker — offline shell for PWA install.
   This file ships from /public/ and is served as-is (no build-time
   templating), so the VERSION constant below — which keys the cache
   names — must change on each release for the activate handler to roll
   old caches over. scripts/release.sh bumps it in lockstep with
   tauri.conf.json / package.json, so it tracks the app version
   automatically; only edit it by hand for an out-of-band SW change.

   Served from the origin root at /sw.js (root scope required so it
   controls every page on the origin, not just /static/).

   Strategy:
   - Navigation requests (HTML): network-first, fall back to cached
     copy of the same URL, then to '/'. Keeps the in-app updater
     working — fresh HTML is always preferred.
   - Static assets (/static/*, /favicon.svg): stale-while-revalidate.
     Cached entries are versioned by URL query string from the
     templates, so a new release rolls them over naturally.
   - Live traffic (/api/*, /socket.io/*, non-GET, range requests):
     never touched — straight to the network.
*/

// Bumped by scripts/release.sh on each release (see header).
const VERSION = "1.0.5";
const SHELL_CACHE = 'aloud-shell-v' + VERSION;
const RUNTIME_CACHE = 'aloud-runtime-v' + VERSION;

// Bare-minimum precache so the app can render something while offline.
// Page-specific JS is picked up on first visit via the runtime cache.
const PRECACHE_URLS = [
    '/',
    '/favicon.svg',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            .then((cache) => cache.addAll(PRECACHE_URLS))
            .then(() => self.skipWaiting())
            .catch(() => self.skipWaiting())  // partial precache is fine
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys
                    .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
                    .map((k) => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

function shouldBypass(request, url) {
    if (request.method !== 'GET') return true;
    if (request.headers.get('range')) return true;
    if (url.pathname.startsWith('/api/')) return true;
    if (url.pathname.startsWith('/socket.io/')) return true;
    // Server-Sent Events / streaming endpoints aren't useful to cache.
    const accept = request.headers.get('accept') || '';
    if (accept.includes('text/event-stream')) return true;
    return false;
}

self.addEventListener('fetch', (event) => {
    const request = event.request;
    let url;
    try {
        url = new URL(request.url);
    } catch (_e) {
        return;
    }

    // Only handle same-origin requests. Cross-origin (fonts CDN, etc.)
    // goes straight to the network — caching opaque responses adds
    // complexity without clear win for an offline shell.
    if (url.origin !== self.location.origin) return;
    if (shouldBypass(request, url)) return;

    // Navigation requests: prefer fresh HTML, fall back to cache.
    if (request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html')) {
        event.respondWith(networkFirst(request));
        return;
    }

    // Everything else (CSS, JS, images, audio): stale-while-revalidate.
    event.respondWith(staleWhileRevalidate(event, request));
});

async function networkFirst(request) {
    try {
        const fresh = await fetch(request);
        if (fresh && fresh.ok && fresh.type === 'basic') {
            const cache = await caches.open(RUNTIME_CACHE);
            cache.put(request, fresh.clone()).catch(() => {});
        }
        return fresh;
    } catch (_e) {
        const cached = await caches.match(request);
        if (cached) return cached;
        const root = await caches.match('/');
        if (root) return root;
        return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
}

async function staleWhileRevalidate(event, request) {
    const cache = await caches.open(RUNTIME_CACHE);
    const cached = await cache.match(request);
    const networkFetch = fetch(request).then((response) => {
        if (response && response.ok && response.type === 'basic') {
            cache.put(request, response.clone()).catch(() => {});
        }
        return response;
    }).catch(() => null);

    if (cached) {
        // Keep the SW alive long enough to finish the background refresh.
        event.waitUntil(networkFetch);
        return cached;
    }
    const fresh = await networkFetch;
    if (fresh) return fresh;
    return new Response('', { status: 504, statusText: 'Gateway Timeout' });
}
