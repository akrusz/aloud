# Play Store video - script

Edit anything here: wording, order, timing, which beats exist at all. The
video is built from this file, so what you leave here is what gets made.

How it reads:
- Each spoken or captioned line has an **id** in brackets, like `[e1]`.
  Keep the ids stable so recordings stay matched to lines.
- **you** = your voice. Record it as `recordings/<id>.wav` (or .m4a/.mp3),
  one file per line. Leave a half second of room tone at each end;
  I'll trim. The `e` lines are not recorded: they are your real words, cut
  from a sit (see "Real excerpts" at the bottom).
- **aloud** = the facilitator, voiced by the app's own hosted TTS, in Harper.
- **caption** = on-screen text only, nobody speaks it.
- Times are targets. The edit follows the audio, so if a line runs
  long, that beat stretches.
- `> note:` lines are for me. Add your own the same way ("snappier here",
  "use the dark theme", "cut this beat").

Target: ~60s, landscape 1920x1080. As written it runs about 77s.

---

## 1. settle (0-3s)

> note: orb breathing, one bowl strike. No caption yet; the first line
> of speech is the hook.

## 2. the hook: caring for yourself (3-22s)

aloud [f0]: Taking a moment to settle in... what do you notice?
you   [e1]: There is a sense of caring for myself by allowing me to be here.
aloud [f1]: Just being fully present is an act of care. Do you feel it anywhere in the body?
caption [c1]: a meditation guide that listens, and follows what you notice.

> note: real app UI on a phone, big captions of the exchange. Cut away
> straight after f1's question; c1 lands over the cut. e1 is your real
> words from the sit. f0 is one of the app's own openers (COMMON_OPENERS
> in `ts/src/facilitation/prompts.ts`; keep them in sync). f1 is written
> for the video.

## 3. what else it helps with (22-27s)

caption [c2]: untangle a feeling
caption [c3]: work with your parts
caption [c4]: settle into deep meditation

> note: quick cards, one after another. Wording is a guess at the big
> wins; swap in whatever you hear from users.

## 4. felt sense (27-33s)

caption [c5]: felt sense
aloud   [f3]: When you're ready, just notice what in your body or mind is pulling your attention.

> note: f3 is a real opener from FELT_SENSE_OPENERS, without its opening
> "No rush." Shown on the felt sense screen with the orb speaking.

## 5. noting (33-35s)

caption [c6]: noting
you     [n1]: warmth.

> note: n1, then a bowl strike from the new sound set. That's the whole
> beat.

## 6. yours to tune (35-47s)

caption [c7]: body · emotions · parts
caption [c8]: playful · compassionate · spacious
caption [c9]: more guidance, or more space
caption [c10]: checks in as often as you like
you     [v1]: set a timer for ten minutes.

> note: fast montage of the real setup screen. v1 said as if eyes closed;
> the timer appears on screen when it lands.

## 7. how it's different (47-51s)

caption [c11]: most apps play the same recording to everyone.
caption [c12]: aloud is a live conversation, every time.

> note: from the site's FAQ.

## 8. why it exists (51-72s)

you [e3]: This is so good. It's so funny that already I'm feeling like this. It's usually so hard.
you [e4]: seriously, I thought I was just going to debug my meditation app for a few minutes before bed. And now I've found something that is... it is such a relief.

> note: over the orb, back to back (e3 8.4s, e4 11.7s). e4 is the last
> thing said in the video and replaces the scripted w1.
> note: as written the video runs about 77s against a 60s target.
> Dropping e3 lands at about 68s.

## 9. end card (72-77s)

caption [c13]: aloud.
caption [c14]: free and open source · bring your own AI, or use ours
caption [c15]: aloud.rest

> note: Google Play badge? Only once the listing is public.

---

## Real excerpts

Your side of the 2026-10-07 sit, from the "Save my speech clips" capture at
`<app-data>/stt-clips/aloud-stt-clips-2026-10-08-06-07-45/`. That audio is
16 kHz mono with every pause over 0.7s already squeezed to 0.4s. Cut points
are seconds into the source clip.

| id | source clip | in | out |
|----|-------------|----|-----|
| e1 | 0084-t028-spec | 0 | end |
| e3 | 0013-t004-spec | 2.05 | 10.45 |
| e4 | 0053-t018-spec | 6.70 | 18.40 |

The capture holds no facilitator audio. Facilitator lines are voiced fresh,
one request per sentence at the session rate, as the app does it.
