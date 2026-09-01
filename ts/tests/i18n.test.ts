import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, setUiLang, uiLang, uiLocale } from '../ui/src/i18n.js';
import { ZH } from '../ui/src/i18n/zh.js';

afterEach(() => setUiLang('en'));

describe('t()', () => {
    it('is the identity in English', () => {
        expect(t('Session')).toBe('Session');
        expect(t('{n} minutes', { n: 3 })).toBe('3 minutes');
    });

    it('looks up the zh catalog and falls back to English when missing', () => {
        setUiLang('zh');
        expect(uiLang()).toBe('zh');
        expect(uiLocale()).toBe('zh-CN');
        expect(t('string-that-will-never-be-in-the-catalog')).toBe(
            'string-that-will-never-be-in-the-catalog'
        );
        const [key, val] = Object.entries(ZH)[0] ?? [];
        if (key && !key.includes('{')) expect(t(key)).toBe(val);
    });

    it('substitutes placeholders after lookup', () => {
        setUiLang('zh');
        expect(t('{n} unknown-units', { n: 7 })).toBe('7 unknown-units');
    });

    it('treats unknown language codes as English', () => {
        setUiLang('fr');
        expect(uiLang()).toBe('en');
    });
});

describe('zh catalog hygiene', () => {
    it('every entry preserves the placeholders of its key', () => {
        for (const [key, val] of Object.entries(ZH)) {
            const placeholders = key.match(/\{[a-zA-Z0-9_]+\}/g) ?? [];
            for (const ph of placeholders) {
                expect(val, `zh for "${key}" must keep ${ph}`).toContain(ph);
            }
        }
    });

    it('no entry is empty or identical to its key unless deliberate', () => {
        for (const [key, val] of Object.entries(ZH)) {
            expect(typeof val, `zh for "${key}"`).toBe('string');
        }
    });

    /**
     * Orphan guard: t() falls back to English by design, so when an English
     * source string is edited its catalog entry doesn't break anything - it
     * just silently stops applying. This test makes that rot loud: every ZH
     * key must still appear somewhere in the source (ui, core, index.html).
     * On failure, either re-key the entry to the new English wording or
     * delete it. Matching tries the raw key plus its escaped-in-source forms
     * (\' \" \n), since keys are compared against file text, not parsed ASTs.
     */
    it('every catalog key still exists in the source (no orphans)', () => {
        const here = dirname(fileURLToPath(import.meta.url));
        const roots = [join(here, '../ui/src'), join(here, '../src')];
        const skip = join(here, '../ui/src/i18n');
        const files: string[] = [join(here, '../ui/index.html')];
        const walk = (dir: string): void => {
            for (const name of readdirSync(dir)) {
                const p = join(dir, name);
                if (p.startsWith(skip)) continue;
                if (statSync(p).isDirectory()) walk(p);
                else if (/\.(ts|html)$/.test(name)) files.push(p);
            }
        };
        roots.forEach(walk);
        const corpus = files.map((f) => readFileSync(f, 'utf8')).join('\n');

        const variants = (key: string): string[] => {
            const escaped = key.replaceAll('\n', '\\n');
            // Lowercased first letter: keys built via t(capitalize(name)),
            // e.g. the noting sound names ('bell' in source, 'Bell' as key).
            const decap = key.charAt(0).toLowerCase() + key.slice(1);
            return [
                key,
                escaped,
                key.replaceAll("'", "\\'"),
                escaped.replaceAll("'", "\\'"),
                key.replaceAll('"', '\\"'),
                escaped.replaceAll('"', '\\"'),
                decap,
            ];
        };
        // A multi-line key may be assembled from concatenated per-line
        // literals in source; accept it when every line is found on its own.
        const foundByLine = (key: string): boolean =>
            key
                .split('\n')
                .filter((line) => line.trim() !== '')
                .every((line) => variants(line).some((v) => corpus.includes(v)));
        const orphans = Object.keys(ZH).filter(
            (key) =>
                !variants(key).some((v) => corpus.includes(v)) && !foundByLine(key)
        );
        expect(orphans, 'orphaned zh.ts keys - re-key or delete them').toEqual([]);
    });
});
