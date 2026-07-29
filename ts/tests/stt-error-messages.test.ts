import { describe, it, expect } from 'vitest';
import { describeSttError } from '../ui/src/stt-errors.js';

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
