/**
 * UI localization. English is the source language and the catalog key: `t()`
 * takes the English string verbatim and returns the active language's version,
 * falling back to English when the catalog has no entry - so an untranslated
 * string degrades to readable English, never to a bare key.
 *
 * The UI language is the app's one language setting (AppSettings.language,
 * seeded from detectLocale() on first run): the language you meditate in is
 * the language the app speaks to you in. Views read `t()` at render time and
 * are remounted on a language change (app.ts listens for LANGUAGE_CHANGED_EVENT);
 * the static index.html chrome is re-translated in place by localizeChrome().
 */

import { ZH } from './i18n/zh.js';

export type UiLang = 'en' | 'zh';

/** Fired on window after the language setting changes and the new locale is
 *  active; app.ts re-localizes chrome and remounts the current view. */
export const LANGUAGE_CHANGED_EVENT = 'aloud:language-changed';

let current: UiLang = 'en';

export function uiLang(): UiLang {
    return current;
}

/** BCP-47 form for Intl (date/number formatting) and <html lang>. */
export function uiLocale(): string {
    return current === 'zh' ? 'zh-CN' : 'en';
}

/** Accepts any stored language code; anything but 'zh' renders English. */
export function setUiLang(lang: string): void {
    current = lang === 'zh' ? 'zh' : 'en';
    if (typeof document !== 'undefined') {
        document.documentElement.lang = uiLocale();
    }
}

/**
 * Translate an English UI string. `{name}` placeholders are substituted from
 * `params` after lookup, so catalog entries carry the same placeholders.
 */
export function t(text: string, params?: Record<string, string | number>): string {
    let out = current === 'zh' ? (ZH[text] ?? text) : text;
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            out = out.replaceAll(`{${k}}`, String(v));
        }
    }
    return out;
}

/**
 * Translate the static shell (index.html): every `[data-i18n]` element gets
 * its text content translated, and `data-i18n-attrs="title,aria-label"` lists
 * attributes to translate on that element. The original English is stashed in
 * data attributes on first pass so repeat calls (language flips) re-key from
 * the source, not from a previous translation.
 */
export function localizeChrome(rootEl: ParentNode = document): void {
    for (const el of rootEl.querySelectorAll<HTMLElement>('[data-i18n]')) {
        const key = el.dataset['i18nKey'] ?? el.textContent?.trim() ?? '';
        if (!key) continue;
        el.dataset['i18nKey'] = key;
        el.textContent = t(key);
    }
    for (const el of rootEl.querySelectorAll<HTMLElement>('[data-i18n-attrs]')) {
        const attrs = (el.dataset['i18nAttrs'] ?? '').split(',');
        for (const raw of attrs) {
            const attr = raw.trim();
            if (!attr) continue;
            const stash = `data-i18n-src-${attr}`;
            const key = el.getAttribute(stash) ?? el.getAttribute(attr) ?? '';
            if (!key) continue;
            el.setAttribute(stash, key);
            el.setAttribute(attr, t(key));
        }
    }
}
