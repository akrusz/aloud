/**
 * rubric.md, read as data: the judge's rules, each dimension's text, whether
 * it is binary, and its weight. Alex edits the markdown and nothing else; the
 * judge's instructions (judge-core.ts) and the weights in aggregation
 * (judge-aggregate.ts) both come from here.
 *
 * What the parser expects of the file:
 *   ## How it's judged      paragraphs opening "**Title.**" are the rules
 *   ## Every mode           "### N. Name [binary] - weight 6L, 3H", or a "### N."
 *                           section split into "**Na. Name** - weight ..." parts
 *   ## By mode and focus    "Weight N each" for the section, then one bullet per
 *                           dimension, "- **F1. Name [binary].** text"
 * "[binary]" anywhere in a dimension's text marks it binary. A dimension whose
 * heading says it "outweighs everything else" (11) carries no number: it sits
 * outside the weighted means and is reported on its own.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isDimensionId, type DimensionId } from './dimensions.js';

export const RUBRIC_PATH = fileURLToPath(new URL('./rubric.md', import.meta.url));

/** The "How it's judged" rules a judge needs. The rest of that section (hard
 *  fails, weights, who judges) is for the people reading the results. */
export const JUDGE_RULES = ['By comparison', 'Only where the turn calls for it', 'Binary and scales'] as const;

export type Weight = { kind: 'fixed'; low: number; high: number } | { kind: 'overriding' };

export interface RubricDimension {
    id: DimensionId;
    name: string;
    binary: boolean;
    weight: Weight | null;
    /** The dimension's own markdown, verbatim. */
    text: string;
    /** "Felt sense", "Parts"...: the group a mode dimension sits under. */
    group?: string;
    /** Credited when present, never faulted when absent (E2, E3). */
    upwardOnly: boolean;
}

export interface Rubric {
    rules: Record<string, string>;
    dimensions: Map<DimensionId, RubricDimension>;
    /** 12 hex characters of sha256 over the whole file. */
    fileHash: string;
}

export function parseWeight(s: string): Weight | null {
    const split = /\bweight\s+(\d+(?:\.\d+)?)L,\s*(\d+(?:\.\d+)?)H/i.exec(s);
    if (split) return { kind: 'fixed', low: Number(split[1]), high: Number(split[2]) };
    const one = /\bweight\s+(\d+(?:\.\d+)?)/i.exec(s);
    if (one) return { kind: 'fixed', low: Number(one[1]), high: Number(one[1]) };
    if (/outweighs everything else/i.test(s)) return { kind: 'overriding' };
    return null;
}

/** The rubric's formula: L + (H - L) x (g - 1) / 4, guidance g from 1 to 5. */
export function weightAt(w: Weight, guidance: number): number | null {
    if (w.kind === 'overriding') return null;
    const g = Math.min(5, Math.max(1, guidance));
    return w.low + ((w.high - w.low) * (g - 1)) / 4;
}

function sections(lines: string[], marker: RegExp): Array<{ heading: string; body: string[] }> {
    const out: Array<{ heading: string; body: string[] }> = [];
    for (const line of lines) {
        if (marker.test(line)) out.push({ heading: line, body: [] });
        else out[out.length - 1]?.body.push(line);
    }
    return out;
}

const cleanName = (s: string) =>
    s
        .replace(/\[binary\]/i, '')
        .replace(/[.,:\s]+$/, '')
        .trim();

function everyMode(body: string[], add: (d: RubricDimension) => void): void {
    for (const sec of sections(body, /^###\s/)) {
        const head = /^###\s+(\d+)\.\s+(.*)$/.exec(sec.heading);
        if (!head) continue;
        const parts: Array<{ lead: string; lines: string[] }> = [];
        for (const line of sec.body) {
            if (/^\*\*\d+[a-z]\.\s/.test(line)) parts.push({ lead: line, lines: [line] });
            else parts[parts.length - 1]?.lines.push(line);
        }
        if (parts.length) {
            for (const p of parts) {
                const m = /^\*\*(\d+[a-z])\.\s+([^*]+)\*\*/.exec(p.lead);
                if (!m || !isDimensionId(m[1] as string)) continue;
                const text = p.lines.join('\n').trim();
                add({
                    id: m[1] as DimensionId,
                    name: cleanName(m[2] as string),
                    binary: /\[binary\]/i.test(text),
                    weight: parseWeight(p.lead),
                    text,
                    upwardOnly: /only\s+upward/i.test(text),
                });
            }
            continue;
        }
        const id = head[1] as string;
        if (!isDimensionId(id)) continue;
        const title = (head[2] as string).split(/\s+-\s+/)[0] ?? '';
        const text = [sec.heading, ...sec.body].join('\n').trim();
        add({
            id,
            name: cleanName(title),
            binary: /\[binary\]/i.test(text),
            weight: parseWeight(sec.heading),
            text,
            upwardOnly: /only\s+upward/i.test(text),
        });
    }
}

function byMode(body: string[], add: (d: RubricDimension) => void): void {
    const firstGroup = body.findIndex((l) => /^###\s/.test(l));
    const intro = body.slice(0, firstGroup === -1 ? body.length : firstGroup).join('\n');
    const each = /\bweight\s+(\d+(?:\.\d+)?)\s+each\b/i.exec(intro);
    const sectionWeight: Weight | null = each ? { kind: 'fixed', low: Number(each[1]), high: Number(each[1]) } : null;
    for (const sec of sections(body, /^###\s/)) {
        const group = sec.heading.replace(/^###\s+/, '').trim();
        const bullets: string[][] = [];
        for (const line of sec.body) {
            if (/^-\s/.test(line)) bullets.push([line]);
            else if (/^\s+\S/.test(line)) bullets[bullets.length - 1]?.push(line);
        }
        for (const b of bullets) {
            const text = b.join('\n').trim();
            for (const m of text.matchAll(/\*\*([A-Z]\d)\.\s+([^*]+?)\*\*/g)) {
                const id = m[1] as string;
                if (!isDimensionId(id)) continue;
                add({
                    id,
                    name: cleanName(m[2] as string),
                    binary: /\[binary\]/i.test(text),
                    weight: parseWeight(b[0] as string) ?? sectionWeight,
                    text,
                    group,
                    upwardOnly: /only\s+upward/i.test(text),
                });
            }
        }
    }
}

export function parseRubric(md: string): Rubric {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    const rules: Record<string, string> = {};
    const dimensions = new Map<DimensionId, RubricDimension>();
    const add = (d: RubricDimension) => dimensions.set(d.id, d);
    for (const sec of sections(lines, /^##\s/)) {
        const title = sec.heading.replace(/^##\s+/, '').trim().toLowerCase();
        if (title.startsWith("how it's judged")) {
            const paras = sec.body.join('\n').split(/\n\s*\n/);
            for (const p of paras) {
                const m = /^\*\*([^*]+?)\.\*\*\s*([\s\S]*)$/.exec(p.trim());
                if (m) rules[(m[1] as string).trim()] = p.trim().replace(/\s*\n\s*/g, ' ');
            }
        } else if (title === 'every mode') {
            everyMode(sec.body, add);
        } else if (title.startsWith('by mode')) {
            byMode(sec.body, add);
        }
    }
    return {
        rules,
        dimensions,
        fileHash: createHash('sha256').update(md).digest('hex').slice(0, 12),
    };
}

export function loadRubric(path: string = RUBRIC_PATH): Rubric {
    return parseRubric(readFileSync(path, 'utf8'));
}
