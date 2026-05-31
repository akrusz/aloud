/**
 * Locks the deploy-base prefix math (route-base.ts). The hosted demo serves the
 * SPA under '/app/' off GitHub Pages; the kickoff flagged this as the part that
 * silently breaks in-app navigation if done blind (pushState/refresh resolve to
 * the wrong path). routePathFor/appPathFor are inverses, so assert the round
 * trip at both bases — root (dev/desktop) and '/app' (hosted).
 */
import { describe, it, expect } from 'vitest';
import { normalizePrefix, routePathFor, appPathFor } from '../ui/src/route-base.js';

describe('normalizePrefix', () => {
    it('reduces a Vite base to a join-ready prefix', () => {
        expect(normalizePrefix('/')).toBe('');
        expect(normalizePrefix('/app/')).toBe('/app');
        expect(normalizePrefix('')).toBe(''); // empty falls back to root
    });
});

describe('root base (dev / desktop) — prefix ""', () => {
    const P = normalizePrefix('/');
    it('routePathFor is the identity on in-app routes', () => {
        expect(routePathFor(P, '/')).toBe('/');
        expect(routePathFor(P, '/history')).toBe('/history');
        expect(routePathFor(P, '/session')).toBe('/session');
    });
    it('appPathFor leaves the pathname untouched', () => {
        expect(appPathFor(P, '/')).toBe('/');
        expect(appPathFor(P, '/settings')).toBe('/settings');
    });
});

describe('hosted subpath — prefix "/app"', () => {
    const P = normalizePrefix('/app/');
    it('routePathFor prefixes the base, keeping a single trailing slash at root', () => {
        expect(routePathFor(P, '/')).toBe('/app/');
        expect(routePathFor(P, '/history')).toBe('/app/history');
        expect(routePathFor(P, '/session')).toBe('/app/session');
    });
    it('appPathFor strips the base back to the in-app path', () => {
        expect(appPathFor(P, '/app/')).toBe('/');
        expect(appPathFor(P, '/app')).toBe('/'); // bare base, no trailing slash
        expect(appPathFor(P, '/app/history')).toBe('/history');
        expect(appPathFor(P, '/app/settings')).toBe('/settings');
    });
    it('does not mis-strip a sibling path that merely starts with the letters', () => {
        // '/application' must NOT be treated as base + '/lication'
        expect(appPathFor(P, '/application')).toBe('/application');
    });
    it('round-trips every route (appPathFor ∘ routePathFor = identity)', () => {
        for (const rel of ['/', '/history', '/settings', '/session']) {
            expect(appPathFor(P, routePathFor(P, rel))).toBe(rel);
        }
    });
});
