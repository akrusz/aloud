/**
 * purchaseChannel() / topUpHint() - whether this build may sell ☁ itself.
 *
 * The store builds must not: an in-app button or link to our own checkout
 * breaks both stores' payment rules. The native app is simulated the way
 * is-desktop-capacitor.test.ts does it, by planting `window.Capacitor`.
 */
import { describe, it, expect, afterEach } from 'vitest';

import { purchaseChannel, topUpHint } from '../ui/src/purchase-channel.js';
import { showBuyCreditsModal } from '../ui/src/buy-credits-modal.js';

function setNative(platform: 'ios' | 'android' | null): void {
    (globalThis as unknown as { window: unknown }).window = platform
        ? { Capacitor: { isNativePlatform: () => true, getPlatform: () => platform } }
        : {};
}

afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
});

describe('purchaseChannel', () => {
    it('is our own checkout in a browser or the desktop app', () => {
        setNative(null);
        expect(purchaseChannel()).toBe('web');
        expect(topUpHint()).toBeNull();
    });

    it('is none in both store builds', () => {
        setNative('android');
        expect(purchaseChannel()).toBe('none');
        setNative('ios');
        expect(purchaseChannel()).toBe('none');
    });
});

describe('topUpHint', () => {
    it('names the website on Android as plain text, never a link', () => {
        setNative('android');
        const hint = topUpHint();
        expect(hint).toContain('aloud.rest/account');
        expect(hint).not.toMatch(/https?:|<a\b|href/);
    });

    it('says nothing on iOS, where any call to action is out', () => {
        setNative('ios');
        expect(topUpHint()).toBeNull();
    });
});

describe('showBuyCreditsModal in a store build', () => {
    it('resolves false before touching the page', async () => {
        // Node has no `document`: reaching the modal body would throw.
        setNative('android');
        await expect(showBuyCreditsModal()).resolves.toBe(false);
    });
});
