import { describe, it, expect } from 'vitest';
import { describeSttError, isConnectionFailure } from '../ui/src/stt-errors.js';

describe('describeSttError', () => {
    it('surfaces the 503 body detail (loading)', () => {
        expect(
            describeSttError(
                new Error(
                    'Whisper endpoint 503: {"error":"Whisper model still loading - try again in a moment."}'
                )
            )
        ).toBe('Whisper model still loading - try again in a moment.');
    });

    it('surfaces the 503 body detail (failed download, retrying)', () => {
        const msg = describeSttError(
            new Error(
                'Whisper endpoint 503: {"error":"Local speech recognition isn\'t ready (download failed). It keeps retrying - check your connection, or switch to aloud cloud in Settings."}'
            )
        );
        expect(msg).toContain('keeps retrying');
    });

    it('falls back to the generic loading line on an unstructured 503 body', () => {
        expect(describeSttError(new Error('Whisper endpoint 503: <html>busy</html>'))).toBe(
            'Whisper model still loading. Try again in a moment.'
        );
    });

    it('still maps other 5xx to backend-unreachable', () => {
        expect(describeSttError(new Error('Whisper endpoint 500: boom'))).toBe(
            'Speech-recognition backend unreachable. Check your connection.'
        );
    });

    it('keeps the hosted-credit mapping ahead of the whisper matches', () => {
        expect(describeSttError(new Error('Whisper endpoint 402: {"error":"out of credits"}'))).toContain(
            'credits'
        );
    });
});

const DID_NOT_GET_THROUGH = "Your words didn't get through - the connection dropped. Try saying that again.";

describe('describeSttError on a dropped connection', () => {
    it.each([
        'Failed to fetch', // Chrome
        'Load failed', // Safari
        'The network connection was lost.', // Safari
        'NetworkError when attempting to fetch resource.', // Firefox
        'aloud cloud transcription timed out.',
    ])('says the words were lost, not "Mic error", for %s', (raw) => {
        const err = raw.includes('timed out') ? new Error(raw) : new TypeError(raw);
        expect(describeSttError(err)).toBe(DID_NOT_GET_THROUGH);
    });

    it("maps Web Speech's network-lost (a recognizer that had been working) the same way", () => {
        expect(describeSttError('network-lost')).toBe(DID_NOT_GET_THROUGH);
    });

    it('keeps a never-working network recognizer on the blocked-browser line', () => {
        expect(describeSttError('network')).toContain('blocked');
    });
});

describe('isConnectionFailure', () => {
    it('matches the cloud adapters\' own deadlines, not every timeout', () => {
        expect(isConnectionFailure('aloud cloud did not respond in time.')).toBe(true);
        expect(isConnectionFailure('aloud cloud stopped responding.')).toBe(true);
        expect(isConnectionFailure('aloud cloud TTS timed out.')).toBe(true);
        expect(isConnectionFailure('judge timed out')).toBe(false);
        expect(isConnectionFailure('out of credits')).toBe(false);
    });
});

