# Language (English / 中文)

Language is one setting, `AppSettings.language`, in Settings only (no
per-session pick): English or `中文` (beta). It drives three layers at once.

## Facilitation (`ts/src/facilitation/language.ts`)

- Appends a respond-in-Chinese fragment to the system prompt. The fragment
  keeps the control tokens (`[HOLD]`, `[NEXT]`, `[BACK]`, `[WAIT:Nm]`,
  `[PASS]`) verbatim in English so `parseTurnSignals` still works.
- Swaps every canned pool for its zh twin. Pool owners register their own
  pairing (`registerZhPool`) rather than this module importing them, which would
  close an import cycle. Pairing is positional (`localizePool` pairs by array
  identity, `pickTimerFallback` indexes by position), so a new or reworded
  English entry needs its zh counterpart in the same position.
- Exception: `COMMAND_LINES` (`voice-command.ts`) carry their zh inline
  (`zhOr`), because most of them take a number.

## Speech recognition

Every STT path gets the locale: browser `SpeechRecognition.lang`, Whisper
`language`, the native recognizer, the hosted hint.

## UI (`ui/src/i18n.ts`, catalog `ui/src/i18n/zh.ts`)

- `t()` is a lookup keyed on the English string (with `{name}` placeholders),
  so a missing entry degrades to English, never to a bare key.
- Static `index.html` chrome uses `data-i18n`, handled by `localizeChrome()`.
- Views remount on `LANGUAGE_CHANGED_EVENT`.
- Rewording an English string orphans its zh entry. The guard in
  `tests/i18n.test.ts` fails until it's re-keyed (or deleted). It matches file
  text, not parsed strings, so a key assembled in an unusual new way can
  false-positive; the fix is a better variant in the test, not skipping.

Voices declare whether they can speak the session language, and the picker dims
the ones that can't.

## Translation review

`npm run zh:review-doc` (`ts/scripts/zh-review.ts`) regenerates
[zh-translation-review.md](zh-translation-review.md): every zh string paired
with its English source, for a native reviewer to edit and send back. It is
generated, so regenerate after merging edits rather than editing it by hand.
