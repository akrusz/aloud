/**
 * The setup-clip manifest (ui/src/voice-clips.json) and what a render run
 * has to do to it: which clips are current, missing or stale, what to prune,
 * and which files on disk nothing references. Pure, so the re-run rules
 * (only changed lines re-render) are testable without a provider.
 */

import { createHash } from 'node:crypto';

export type HouseLanguage = 'en' | 'zh';

export interface ClipEntry {
    /** Relative to ui/public/voice-clips/. */
    file: string;
    /** Exactly what was synthesized; the UI refuses a clip whose text no
     *  longer matches the line. */
    text: string;
    /** Failed the quality gate on every attempt: a human should listen. */
    suspect?: true;
    suspectReason?: string;
}

export interface VoiceEntry {
    language: HouseLanguage;
    gender: string;
    /** The voice ignores the speed setting (it carries a style). */
    fixedPace: boolean;
    clips: Record<string, ClipEntry>;
}

export interface ClipManifest {
    voices: Record<string, VoiceEntry>;
}

/** What the script needs of a curated house voice. */
export interface HouseVoice {
    name: string;
    language: HouseLanguage;
    gender: string;
    providerVoiceId: string;
    style?: string;
}

export function emptyManifest(): ClipManifest {
    return { voices: {} };
}

export function voiceSlug(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

/** The clip's revision: anything that changes the audio changes the file
 *  name, so a re-rendered line is a new URL and no cache serves the old one. */
export function clipHash(text: string, providerVoiceId: string, style: string | undefined): string {
    return createHash('sha256')
        .update(JSON.stringify([text, providerVoiceId, style ?? '']))
        .digest('hex')
        .slice(0, 8);
}

export function clipFile(voice: HouseVoice, lineId: string, text: string): string {
    return `${voiceSlug(voice.name)}/${voice.language}/${lineId}.${clipHash(text, voice.providerVoiceId, voice.style)}.mp3`;
}

export type ClipStatus = 'current' | 'missing' | 'stale';

export interface ClipTarget {
    voice: HouseVoice;
    lineId: string;
    text: string;
    /** Where the clip for this text, voice and style belongs. */
    file: string;
    status: ClipStatus;
    /** Why it is missing or stale. */
    why?: string;
}

export function planClips(
    voices: readonly HouseVoice[],
    lineIds: readonly string[],
    textFor: (voice: HouseVoice, lineId: string) => string,
    manifest: ClipManifest,
    exists: (file: string) => boolean
): ClipTarget[] {
    const targets: ClipTarget[] = [];
    for (const voice of voices) {
        const clips = manifest.voices[voice.name]?.clips ?? {};
        for (const lineId of lineIds) {
            const text = textFor(voice, lineId);
            const file = clipFile(voice, lineId, text);
            const entry = clips[lineId];
            const target = { voice, lineId, text, file };
            if (!entry) targets.push({ ...target, status: 'missing', why: 'not rendered' });
            else if (entry.text !== text) targets.push({ ...target, status: 'stale', why: 'text changed' });
            else if (entry.file !== file) targets.push({ ...target, status: 'stale', why: 'voice id or style changed' });
            else if (!exists(entry.file)) targets.push({ ...target, status: 'missing', why: 'file missing' });
            else targets.push({ ...target, status: 'current' });
        }
    }
    return targets;
}

/**
 * The manifest without voices that are no longer house voices and lines
 * that no longer exist, with each voice's details refreshed from the catalog.
 * `voices` and `lineIds` are the full sets, never a run's --voice/--only
 * filter, or a filtered run would prune everything it didn't touch.
 */
export function pruneManifest(
    manifest: ClipManifest,
    voices: readonly HouseVoice[],
    lineIds: readonly string[]
): { manifest: ClipManifest; removed: string[] } {
    const removed: string[] = [];
    const lines = new Set(lineIds);
    const out = emptyManifest();
    for (const [name, entry] of Object.entries(manifest.voices)) {
        const voice = voices.find((v) => v.name === name);
        if (!voice) {
            removed.push(`${name} (no longer a house voice)`);
            continue;
        }
        const clips: Record<string, ClipEntry> = {};
        for (const [lineId, clip] of Object.entries(entry.clips)) {
            if (lines.has(lineId)) clips[lineId] = clip;
            else removed.push(`${name}/${lineId} (line removed)`);
        }
        out.voices[name] = { ...voiceDetails(voice), clips };
    }
    return { manifest: out, removed };
}

export function voiceDetails(voice: HouseVoice): Omit<VoiceEntry, 'clips'> {
    return { language: voice.language, gender: voice.gender, fixedPace: Boolean(voice.style) };
}

/** Clip files on disk (relative to voice-clips/) the manifest doesn't name. */
export function orphanFiles(manifest: ClipManifest, onDisk: readonly string[]): string[] {
    const referenced = new Set(Object.values(manifest.voices).flatMap((v) => Object.values(v.clips).map((c) => c.file)));
    return onDisk.filter((f) => !referenced.has(f));
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])])
        );
    }
    return value;
}

/** Keys sorted all the way down, so a re-run's diff shows only what changed. */
export function serializeManifest(manifest: ClipManifest): string {
    return `${JSON.stringify(sortKeys(manifest), null, 4)}\n`;
}
