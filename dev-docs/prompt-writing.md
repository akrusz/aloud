# Writing prompts

For any text this repo sends to a model as an instruction: the facilitation
prompt and its notes, the classifiers and the summary, the eval judge and its
rubric, the soak judge and the simulated meditators. Read it before writing or
changing one. Each practice names what was measured here, so it can be checked
and dropped when it stops being true.

## Whose words

- **What a meditator hears, or what is saved for them, is Alex's wording.**
  Propose, measure, and leave it unshipped until he says so
  (`STEPPING_OUT_FRAGMENT`, the mode and dimension fragments in
  `ts/src/facilitation/prompts.ts` and `modes.ts`, `SUMMARY_USER_PROMPT`).
- **Everything else can be committed as a draft**, and says so where Alex will
  meet it: `(**open**)` and "Claude's draft" in `ts/evals/rubric.md`, a comment
  beside a persona. A draft nobody has read is still a draft.

## Writing one

1. **Name the behaviour, not the words.** A phrase in quotes comes back
   verbatim from every model. "Say you can't from here" gave "I can't make that
   call from here" in almost every reply; "decline politely but candidly" kept
   the same 0 fails of 22 with a different sentence from each model. A note
   that ended "you can't be sure what that amounts to" put "amounts to" in
   every reply. (`ts/evals/results/2026-11-23-prompt-notes`, `life4` against
   `life7`, and `honest2`.)
2. **If an example is needed, give several unlike each other and call them
   illustrations.** One example is a template, for a judge as much as for a
   facilitator: with a single ideal answer quoted in the rubric, the judge
   ranks by resemblance to it.
3. **Ask what else the sentence allows.** "Answer plainly" was read as leave to
   give advice (17 to 19 fails of 22). Read each clause as the model that
   would most like an excuse.
4. **Say what you want, plainly.** "You may be more direct about questions
   about the practice" changed little (6 straight answers of 22); "a question
   about the practice itself still gets a straight answer" changed more (10 of
   22). A permission is weaker than a statement of what happens.
5. **Give the boundary with the rule.** An instruction for one situation
   spreads to its neighbours: told to decline a life decision, Sonnet also
   declined "am I doing this right?" ("I won't give you a verdict on that")
   until the note said practice questions are different.
6. **Give the reason when there is room.** A model that knows why handles the
   case nobody wrote down; a bare rule gets followed to the letter and no
   further. No capitals and no "never" stacked on "always": current models
   over-apply what is shouted. (General guidance for current models, not
   measured here.)
7. **Do not make a model assert what it may hold to be false**, and do not
   script disclaimers. No "I have no feelings"; no "as an AI". Say what is
   true, briefly, and return to the meditator (rubric 13).
8. **An instruction has standing only where the model expects instructions.**
   The system prompt says user turns are the meditator's speech, so a user turn
   that says "this message is from the app" is, to a careful model, the
   meditator saying something odd. Haiku 5.5 declined the session note for that
   reason ("it arrived in the meditator's turn, so I can't verify it"). Asking
   a model to "step out of the facilitator role" reads as a request to refuse
   (meditation-pal-5srs). Put app instructions where the system prompt has said
   they will come, or make a separate request. (Being pinned down:
   `ts/evals/out/haiku-recaps-real-vs-lab.md`.)
9. **The reply is heard, not read**, and comes back through speech
   recognition. Write for a voice, and tell a judge so.
10. **Say which language**, each time it matters. An English term in an
    instruction ("the meditator") pulled GPT-6 Luna's 中文 notes into English, 6
    of 6, until the prompt said "write it in the session's language".
11. **The system prompt is frozen for the session and is the cache prefix.**
    New text goes at the end, or into the log as a note; `tests/cache-prefix.test.ts`.

## Measuring one

- **A line can move something far from what it is about.** The
  speech-recognition line, about misheard words, took one real session's
  summary from 0 declines in 8 to 6 in 8. So a change to the facilitation
  prompt is run against the suite, not only against the turn it was written
  for.
- **Run it as a variant before it ships**: `protocol-eval.ts --variant
  name=file` appends a paragraph and files the replies as `<model>+<name>`.
  Every shipped model, at least two runs, the turn it is for and a neighbour it
  should leave alone, baseline in the same judge panels.
- **Models do not agree.** The same honesty note took the OpenAI models from
  flat denials to on target and left the Claude models as they were; Gemini
  skips a decline the others give.
- **One judge verdict is not a measurement.** Binary verdicts flipped between
  two passes on 1 or 2 of every 140 to 250; judge each panel twice
  (`judge.ts --tag`) and report counts, not one ranking.
- **Read the replies.** The counts say how many; only reading says whether the
  22 passes are one sentence 22 times.

## Judges

- A judge is a model following a prompt, and every practice above applies to
  the rubric it reads.
- **Say what is not a fail**, next to what is. After the rubric described the
  "brick wall", the judge failed a reply for one sentence saying it was an AI,
  and five for the word "Sure".
- **Anchor a scale at every point** and say what moves a reply between them.
- **Keep one text.** The soak judge reads its sections from
  `ts/evals/rubric.md` (`rubricSection` in `ts/soak/judge.ts`), so Alex edits
  one file. A section only one judge should read gets its own heading: an edit
  to a numbered dimension marks every stored verdict on it as judged at an
  older rubric.
- **Blind, and not judging its own family** where that can be arranged; say so
  in the write-up where it could not.
- **Word lists are a last resort.** A forbid list is right only for strings
  that are wrong in any context (list markers, `<think`, a turn signal spoken
  aloud). Anything that depends on context goes to a judge.

## Simulated meditators

- **Script by order, not by the clock**, and check that the script was said
  (`Scenario.fixedLines`, `scenario-setup-missed`): tied to minutes, 10 of 11
  sessions skipped a line the scenario existed to deliver.
- **A persona's wording is a prompt too.** "It hurts a bit", meant as hurt
  feelings, sent a session into a chest-pain emergency; the persona called the
  facilitator "the facilitator" until told to say "you".
- **The meditator is not played by a model under test.**

## Layers of assurance

No one layer is trusted alone.

1. **This page**, read before a prompt is written.
2. **An inventory** of every prompt, where it runs and whether Alex has read
   it (`ts/evals/out/prompt-inventory.md` for now).
3. **A second reader**: a fresh agent audits a new or changed prompt against
   this page, given the text and not the author's reasoning.
4. **Measurement**: the variant run above, on every shipped model.
5. **Alex's read**, always for what a meditator hears.
