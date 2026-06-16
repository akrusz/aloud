/**
 * Curated session presets mirroring the existing app's "Suggested Presets".
 * When the user picks a preset card, focuses, qualities, and dirStep snap to
 * the preset's recipe — but they can still tweak afterward and the preset
 * stays selected for clarity.
 */

import type { Focus, Quality } from '../../src/facilitation/index.js';

export interface Preset {
    id: string;
    name: string;
    description: string;
    focuses: Focus[];
    qualities: Quality[];
    /** UI slider step 0-4. */
    dirStep: number;
}

export const PRESETS: readonly Preset[] = [
    {
        id: 'pleasant_play',
        name: 'Pleasant Play',
        description: 'Playfully exploring emotions, body sensations, jhana factors',
        focuses: ['body_sensations', 'emotions'],
        qualities: ['playful', 'feeling_good'],
        dirStep: 1,
    },
    {
        id: 'warmth_goodwill',
        name: 'Warmth & Goodwill',
        description: 'Orienting toward kind and loving feelings for yourself and others',
        focuses: ['emotions'],
        qualities: ['loving', 'feeling_good'],
        dirStep: 2,
    },
    {
        id: 'parts_work',
        name: 'Parts Work',
        description: 'Explore inner parts, speak to them, let them speak back',
        focuses: ['inner_parts'],
        qualities: ['compassionate'],
        dirStep: 1,
    },
];

export function findPreset(id: string | null): Preset | null {
    if (!id) return null;
    return PRESETS.find((p) => p.id === id) ?? null;
}
