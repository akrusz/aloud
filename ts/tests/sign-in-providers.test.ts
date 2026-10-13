import { describe, it, expect, vi, beforeEach } from 'vitest';

const build = { capacitor: false, platform: 'web' as 'ios' | 'android' | 'web', desktop: false };
vi.mock('../ui/src/is-desktop.js', () => ({
    isCapacitor: () => build.capacitor,
    capacitorPlatform: () => build.platform,
    isDesktopSync: () => build.desktop,
}));

import {
    setRuntimeAppleClientId,
    setRuntimeGoogleClientId,
    setRuntimeGoogleDesktopClientId,
} from '../ui/src/cloud-auth.js';
import { offeredSignIns, signInAccount, signInNames } from '../ui/src/sign-in-providers.js';

/** What a server with every sign-in configured advertises at boot. */
function serverAdvertisesAll(): void {
    setRuntimeGoogleClientId('web-google');
    setRuntimeGoogleDesktopClientId('desktop-google');
    setRuntimeAppleClientId('apple-services-id');
}

beforeEach(() => {
    Object.assign(build, { capacitor: false, platform: 'web', desktop: false });
    setRuntimeGoogleClientId('');
    setRuntimeGoogleDesktopClientId('');
    setRuntimeAppleClientId('');
});

describe('copy that names the sign-ins', () => {
    it('names both on the web, where both buttons render', () => {
        serverAdvertisesAll();
        expect(offeredSignIns()).toEqual(['google', 'apple']);
        expect(signInNames()).toBe('Google or Apple');
        expect(signInAccount()).toBe('a Google or Apple account');
    });

    it('names Google alone on Android', () => {
        serverAdvertisesAll();
        Object.assign(build, { capacitor: true, platform: 'android' });
        expect(offeredSignIns()).toEqual(['google']);
        expect(signInNames()).toBe('Google');
        expect(signInAccount()).toBe('a Google account');
    });

    it('names Apple alone on iOS, which needs no client id for it', () => {
        Object.assign(build, { capacitor: true, platform: 'ios' });
        expect(offeredSignIns()).toEqual(['apple']);
        expect(signInNames()).toBe('Apple');
        expect(signInAccount()).toBe('an Apple account');
    });

    it('names Google alone in the desktop app, whose Apple flow is not wired', () => {
        serverAdvertisesAll();
        build.desktop = true;
        expect(offeredSignIns()).toEqual(['google']);
        expect(signInNames()).toBe('Google');
    });

    it('keeps naming both before the client ids have arrived', () => {
        expect(offeredSignIns()).toEqual([]);
        expect(signInNames()).toBe('Google or Apple');
        expect(signInAccount()).toBe('a Google or Apple account');
    });
});
