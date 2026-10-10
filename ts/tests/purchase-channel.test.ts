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
import { outOfCreditsNotice } from '../ui/src/billing-messages.js';
import { describeCloudError } from '../ui/src/stt-errors.js';

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

describe('what a store build says when the credits run out', () => {
    const SELLING = /add more|buy|purchase|top up|local/i;

    it('speaks and shows the plain notice, from the matching server clip', () => {
        setNative('ios');
        const notice = outOfCreditsNotice();
        expect(notice.reason).toBe('insufficient_credits_plain');
        expect(notice.text).not.toMatch(SELLING);
    });

    it('keeps the full notice where our own checkout is a button away', () => {
        setNative(null);
        expect(outOfCreditsNotice().reason).toBe('insufficient_credits');
    });

    it('words the cloud error without a purchase', () => {
        setNative('android');
        expect(describeCloudError('endpoint 402')).not.toMatch(SELLING);
        setNative(null);
        expect(describeCloudError('endpoint 402')).toMatch(/Purchase more/);
    });
});
