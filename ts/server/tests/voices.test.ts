import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import { resolveVoiceId, defaultVoice, CURATED_VOICES } from '../src/providers/voice-catalog.js';
import type { CloudVoice } from '../src/contract.js';

describe('voice catalog', () => {
    it('resolves a curated short name to its Google id', () => {
        expect(resolveVoiceId('Leda')).toBe('en-US-Chirp3-HD-Leda');
        expect(resolveVoiceId('Pulcherrima')).toBe('en-US-Chirp3-HD-Pulcherrima');
    });

    it('passes a raw Google id through and falls back to the default', () => {
        expect(resolveVoiceId('en-US-Chirp3-HD-Charon')).toBe('en-US-Chirp3-HD-Charon');
        expect(resolveVoiceId(undefined)).toBe(defaultVoice().googleId);
        expect(defaultVoice().default).toBe(true);
    });

    it('labels Pulcherrima androgynous (not Google\'s "female")', () => {
        expect(CURATED_VOICES.find((v) => v.name === 'Pulcherrima')!.gender).toBe('androgynous');
    });
});

describe('GET /cloud/v1/voices', () => {
    it('lists the curated voices when TTS is configured', async () => {
        const app = createApp(buildDeps(loadConfig({ GOOGLE_TTS_API_KEY: 'k' })));
        const res = await app.request('/cloud/v1/voices');
        expect(res.status).toBe(200);
        const voices = (await res.json()) as CloudVoice[];
        expect(voices.map((v) => v.name)).toEqual(['Pulcherrima', 'Sadachbia', 'Leda']);
        expect(voices.every((v) => 'gender' in v)).toBe(true);
    });

    it('is empty when TTS is not configured', async () => {
        const app = createApp(buildDeps(loadConfig({})));
        const res = await app.request('/cloud/v1/voices');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([]);
    });
});
