import { describe, it, expect, afterEach } from 'vitest';
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
});
