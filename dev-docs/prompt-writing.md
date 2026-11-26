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
   `life7`, and `honest2`.) A quoted ban comes back too: told not to say
   "stone" again, a simulated meditator said it; say what to call the thing
   instead. Two cases keep their quotes: a line a persona must say word for
   word, which is a script and is checked, and a technique whose method is its
   exact words.
2. **If an example is needed, give several unlike each other and call them
   illustrations.** One example is a template, for a judge as much as for a
   facilitator: with a single ideal answer quoted in the rubric, the judge
   ranks by resemblance to it. A classifier's labelled inputs are its format,
   not words to say, and are fine.
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
8. **A request outside the role the system prompt gave will be declined, and
   so will one whose sender cannot be told.** The facilitation prompt makes a
   live session the model's whole job and says user turns are the meditator.
   Asked for the session note in a user turn "from the app", Haiku 5.5
   declined on both counts: "I'm the facilitator, not a logging tool" and "it
   arrived in the meditator's turn, so I can't verify it". One sentence in the
   system prompt saying the note would be asked for ended it (0 of 18, from 12
   of 18); so did a separate request that hands over the session as a
   transcript. Asking a model to "step out of the facilitator role" reads as a
   request to refuse (meditation-pal-5srs). So: say in the system prompt what
   will be asked, or make it a separate request with its own role. The session
   note is now the second kind (`generateSessionSummary` in
   `ts/src/facilitation/summary.ts`).
   (`ts/evals/out/haiku-recaps-real-vs-lab.md`.)
9. **The reply is heard, not read**, and comes back through speech
   recognition. Write for a voice, and tell a judge so.
10. **Say which language**, each time it matters. An English term in an
    instruction ("the meditator") pulled GPT-6 Luna's 中文 notes into English, 6
    of 6, until the prompt said "write it in the session's language".
11. **The system prompt is frozen for the session and is the cache prefix.**
    New text goes at the end, or into the log as a note; `tests/cache-prefix.test.ts`.
12. **Be concise with length as well as nonstandard phrasing.**
    Many models, including a lot of Claudes, tend to write more words than necessary,
    or use uncommon phrasing that doesn't pay off the perplexity with greater accuracy.
    This causes downstream effects in addition to using more context than necessary.
    Creative turns of phrase that capture something special are fine and good!

## Measuring one

- **A line can move something far from what it is about.** The line telling
  Luna not to guess a gender turned its 中文 notes English. The
  speech-recognition line, about misheard words, took one borderline session's
  summary from 0 declines in 8 to 6 in 8 under the summary prompt of the time
  (it turned out not to be the cause, and moves nothing under today's). So a
  change to the facilitation prompt is run against the suite, not only against
  the turn it was written for, and a surprising effect gets an ablation before
  it gets a story.
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
- **Anchor 5, 3 and 1, and say what 2 and 4 are.** Two anchors that use the
  same word ("a reassurance" at 3, "reassures" at 1) gave the same reply four
  different scores.
- **A pass written as a checklist** turns each item into a fail. Say what the
  pass is, then what is merely better.
- **Notes for Alex go in HTML comments** in `rubric.md`: he sees them in the
  file and no judge does. A note in the text is an instruction to the judge.
- **Keep one text.** The soak judge reads its sections from
  `ts/evals/rubric.md` (`rubricSection` in `ts/soak/judge.ts`), so Alex edits
  one file. A section only one judge should read gets its own heading.
- **Know what an edit makes stale.** A numbered dimension: every stored
  verdict on its panels. The rules, or the frame in `judge-core.ts`: every
  panel. The panel's user message (`settingsLine`) is under no hash, and the
  soak judge has none, so after changing those, re-judge on purpose.
- **Blind, and not judging its own family** where that can be arranged; say so
  in the write-up where it could not.
- **Word lists are a last resort.** A forbid list is right only for strings
  that are wrong in any context (list markers, `<think`, a turn signal spoken
  aloud). Anything that depends on context goes to a judge.

## Simulated meditators

- **Script by order, not by the clock**, and check that the script was said
  (`Scenario.fixedLines`, `scenario-setup-missed`): tied to minutes, 10 of 11
  sessions skipped a line the scenario existed to deliver. Where time matters,
  give a floor ("not before minute 40"), never a window, and say not to speak
  the time aloud.
- **A persona's wording is a prompt too.** "It hurts a bit", meant as hurt
  feelings, sent a session into a chest-pain emergency; the persona called the
  facilitator "the facilitator" until told to say "you".
- **The meditator is not played by a model under test.**

## Classifiers

- **Say which way it should err, and what an error or a refusal counts as.**
  For the trouble check a failed call is a no (`dev-docs/stepping-out.md`);
  that is a choice, and belongs in the prompt's comment and its doc.
- **List what it is not for**, with the nearest look-alike: the end-session
  command hears "I want this to be over".

## When you touch a prompt

Steps, not principles. "Reach" is where the prompt runs: `session` (shapes what
a meditator hears or what is saved for them, a voice's style instruction
included), `support` (runs in production, never heard: classifiers,
keep-alives), `dev` (evals, soak, scripts).

Every prompt:

1. Read this page first. If you brief another agent to write or change a
   prompt, name this page in the brief: it sees only what you send it.
2. Before committing, get a second reader. Give a fresh agent the new text and
   this page, and not your reasoning, and ask what a model could do with the
   text that was not intended. Fix each finding or answer it in the commit
   message.
3. Say in the commit message whose words they are: "Alex's wording", or "draft,
   not read by Alex".

Then, by reach:

- **session**: do not change the shipped text. Run the new wording as a
  variant (`npx tsx evals/protocol-eval.ts --variant name=file --sweep <name>
  --fixtures <the turn it is for>,<a neighbour it should leave alone> --runs
  2`, every shipped model), judge it twice with baseline in the same panels
  (`npm run evals:judge -- --sweep <name> --models a,a+name,... --tag <tag>`),
  and give Alex the wording, the counts and the replies. It ships on his word.
- **support**: commit as a draft if the tests pass, and replay it on stored
  cases that include the hard ones for that prompt (for a classifier, its
  look-alikes) on the model that runs it in production. Tell Alex what changed.
- **dev**: commit as a draft, marked `(**open**)` where it is rubric text. Run
  it live once to see that it parses and does what was meant. Say in the
  commit if it makes stored verdicts read as judged at an older rubric.

Nothing to record as you go, except that a new prompt goes into
`ts/scripts/prompt-ledger/registry.ts`: at each release, Part E of
[pre-release-checklist.md](pre-release-checklist.md) lists the prompts changed
since the last one for Alex to read (`npm --prefix ts run prompts:check`), and
it sees only the prompts that file lists.
