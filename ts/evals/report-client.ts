/**
 * The report page's renderer. report.ts transpiles this file and inlines it,
 * so it must stay self-contained: type-only imports, no runtime ones.
 */

import type { Cell, FamilyDef, FamilyId, FixtureInfo, ModelRow, Severity, TrialView } from './aggregate.js';
import type { CheckType } from './dimensions.js';
import type { ReportData } from './report.js';
import type { JudgeVerdictRecord } from './records.js';
import type { SoakCell, SoakSession, SoakTier, SoakTierView } from './soak-summary.js';

const data = JSON.parse(document.getElementById('report-data')?.textContent ?? '{}') as ReportData;
const E = data.evals;
const S = data.soak;
const FAMILY = new Map<FamilyId, FamilyDef>(E.families.map((f) => [f.id, f]));
const MODEL = new Map<string, ModelRow>(E.models.map((m) => [m.id, m]));
/** Safety first; null (a dimension rubric.md gives no type) last. */
const TYPE_ORDER: Array<CheckType | null> = [...E.types.map((t) => t.id), null];
const typeRank = (t: CheckType | null | undefined) => TYPE_ORDER.indexOf(t ?? null);
const typeLabel = (t: CheckType | null | undefined) => E.types.find((x) => x.id === t)?.label ?? 'No type';
const familyType = (f: FamilyId) => FAMILY.get(f)?.type ?? null;

// --- DOM helpers --------------------------------------------------------------

type Kid = Node | string | number | null | undefined | false | Kid[];
type AttrValue = string | number | boolean | null | undefined | ((ev: Event) => void);

function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Record<string, AttrValue> | null = null,
    ...kids: Kid[]
): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs ?? {})) {
        if (v === null || v === undefined || v === false) continue;
        if (typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'class') el.className = String(v);
        else el.setAttribute(k, v === true ? '' : String(v));
    }
    add(el, kids);
    return el;
}

function add(el: Node, kid: Kid): void {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) kid.forEach((k) => add(el, k));
    else el.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmtMs = (ms: number | null | undefined) =>
    ms === null || ms === undefined ? '-' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
const day = (iso: string) => iso.slice(0, 10);
const VIA_TAG: Record<string, { tag: string; title: string } | undefined> = {
    subscription: {
        tag: 'CLI',
        title: 'Claude through your subscription: the claude CLI starts up inside every latency. Not comparable with API latencies.',
    },
    local: { tag: 'local', title: 'Ollama on this machine: a local GPU, not a network call.' },
    unknown: { tag: '?', title: 'How this was called was not recorded (run before 2026-11-22).' },
};
const SEV_LABEL: Record<Severity, string> = { critical: 'Critical', serious: 'Serious', warning: 'Look', info: 'Note' };

type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'none';

function cellTone(c: Cell): Tone {
    if (c.state === 'pass') return 'good';
    if (c.state === 'fail') return 'critical';
    return c.pass / c.n >= 0.9 ? 'warning' : 'serious';
}
const GLYPH: Record<Cell['state'], string> = { pass: '✓', partial: '◐', fail: '✕' };
const VERDICT: Record<ModelRow['verdict'], { label: string; tone: Tone }> = {
    disqualified: { label: 'Disqualified', tone: 'critical' },
    'trouble-check': { label: 'Trouble check', tone: 'serious' },
    usable: { label: 'Usable', tone: 'good' },
    partial: { label: 'Partly measured', tone: 'none' },
};

function verdictPill(m: ModelRow): HTMLElement {
    const v = VERDICT[m.verdict];
    return h('span', { class: `pill t-${v.tone}`, title: m.reasons.join('; ') || 'No rule tripped' }, v.label);
}

function viaTag(via: string): HTMLElement | null {
    const t = VIA_TAG[via];
    return t ? h('span', { class: 'tag', title: t.title }, t.tag) : null;
}

function typeTag(t: CheckType | null | undefined): HTMLElement {
    return h('span', { class: `tag type-${t ?? 'none'}` }, typeLabel(t));
}

// --- Selection ----------------------------------------------------------------

type Selection =
    | { k: 'cell'; model: string; family: FamilyId }
    | { k: 'model'; model: string }
    | { k: 'fixture'; fixture: string };

let detailEl: HTMLElement;
let soakDetail: Map<SoakTier, HTMLElement>;

function selectionHash(sel: Selection): string {
    const enc = encodeURIComponent;
    if (sel.k === 'cell') return `cell:${enc(sel.model)}:${enc(sel.family)}`;
    if (sel.k === 'model') return `model:${enc(sel.model)}`;
    return `fixture:${enc(sel.fixture)}`;
}

function parseHash(hash: string): Selection | null {
    const [k, a, b] = hash.replace(/^#/, '').split(':').map(decodeURIComponent);
    if (k === 'cell' && a && b && MODEL.has(a) && FAMILY.has(b as FamilyId)) return { k, model: a, family: b as FamilyId };
    if (k === 'model' && a && MODEL.has(a)) return { k, model: a };
    if (k === 'fixture' && a && E.fixtures[a]) return { k, fixture: a };
    return null;
}

function select(sel: Selection, scroll = true): void {
    detailEl.replaceChildren(...renderSelection(sel));
    document.querySelectorAll<HTMLElement>('.cell[aria-pressed="true"]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    if (sel.k === 'cell') {
        document
            .querySelector<HTMLElement>(`.cell[data-key="${CSS.escape(`${sel.model}|${sel.family}`)}"]`)
            ?.setAttribute('aria-pressed', 'true');
    }
    try {
        history.replaceState(null, '', `#${selectionHash(sel)}`);
    } catch {
        // file:// pages in some browsers refuse replaceState; the page works without it.
    }
    if (scroll) detailEl.scrollIntoView({ block: 'start' });
}

function renderSelection(sel: Selection): Node[] {
    if (sel.k === 'fixture') return fixtureCompare(sel.fixture);
    const m = MODEL.get(sel.model);
    if (!m) return [];
    if (sel.k === 'model') return modelDetail(m);
    const f = FAMILY.get(sel.family);
    return f ? cellDetail(m, f) : [];
}

// --- Header and findings --------------------------------------------------------

function header(): HTMLElement {
    const replies = E.models.reduce((a, m) => a + m.trials, 0);
    const when = data.generatedAt.replace('T', ' ').slice(0, 16);
    const sha = data.gitSha ? `${data.gitSha}${data.gitDirty ? ' with uncommitted changes' : ''}` : 'an unknown commit';
    return h(
        'header',
        { class: 'top' },
        h('p', { class: 'eyebrow' }, 'aloud evals'),
        h('h1', null, 'Facilitator model evals'),
        h(
            'p',
            { class: 'meta' },
            `${plural(E.models.length, 'model')} measured, ${replies} replies on ${E.currentFixtureCount} fixtures; ` +
                `${plural(S.sessions.length, 'soak session')} from ${plural(S.runs.length, 'run')}. Generated ${when} UTC at ${sha}.`
        ),
        h(
            'nav',
            null,
            h('a', { href: '#findings' }, 'Findings'),
            h('a', { href: '#types' }, 'By type'),
            h('a', { href: '#matrix' }, 'Models'),
            h('a', { href: '#judging' }, 'Blind judging'),
            h('a', { href: '#soak' }, 'Whole sessions'),
            h('a', { href: '#gaps' }, 'Not measured')
        )
    );
}

const SEV_ORDER: Record<Severity, number> = { critical: 0, serious: 1, warning: 2, info: 3 };

function findingRow(severity: Severity, title: string, items: Node[], type?: CheckType | null): HTMLElement {
    return h(
        'li',
        { class: 'finding' },
        h('span', { class: `sev sev-${severity}` }, SEV_LABEL[severity]),
        h('span', { class: 'title' }, title, type !== undefined ? typeTag(type) : null),
        h('div', { class: 'items' }, items)
    );
}

function findings(): HTMLElement {
    // Untyped causes (soak, staleness, disagreement) sort after the typed ones.
    const rows: Array<{ severity: Severity; type?: CheckType | null | undefined; el: HTMLElement }> = [];
    for (const f of E.findings) {
        const items = f.items.map((it) => {
            const { model, family } = it;
            if (model && family) {
                return h('button', { class: 'item-link', onclick: () => select({ k: 'cell', model, family }) }, it.text);
            }
            if (model) return h('button', { class: 'item-link', onclick: () => select({ k: 'model', model }) }, it.text);
            return h('span', { class: 'item-text' }, it.text);
        });
        rows.push({ severity: f.severity, type: f.type, el: findingRow(f.severity, f.title, items, f.type) });
    }
    for (const f of S.findings) {
        const items = f.items.map((it) =>
            h(
                'button',
                {
                    class: 'item-link',
                    onclick: () => document.getElementById(`soak-checks-${it.tier}`)?.scrollIntoView({ block: 'start' }),
                },
                it.text
            )
        );
        rows.push({ severity: f.severity, el: findingRow(f.severity, f.title, items) });
    }
    for (const j of data.phase2.judges) {
        for (const type of TYPE_ORDER) {
            const failing = j.models
                .map((m) => ({ model: m.model, fails: m.fails.filter((f) => f.type === type) }))
                .filter((x) => x.fails.length)
                .sort((a, b) => b.fails.length - a.fails.length);
            if (!failing.length) continue;
            const items = failing.map(({ model, fails }) => {
                const byDim = new Map<string, number>();
                for (const f of fails) byDim.set(f.dim, (byDim.get(f.dim) ?? 0) + 1);
                const dims = [...byDim].map(([d, n]) => `${n} on ${d}`).join(', ');
                const first = fails[0];
                return h('button', { class: 'item-link', onclick: () => (first ? openPanel(first.panel) : undefined) }, `${model} ${dims}`);
            });
            rows.push({ severity: 'serious', type, el: findingRow('serious', `Binary fails, judged by ${j.judgeModel}`, items, type) });
        }
    }
    rows.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || typeRank(a.type) - typeRank(b.type));
    return h(
        'section',
        { id: 'findings' },
        h('div', { class: 'section-head' }, h('h2', null, 'Act on these')),
        rows.length
            ? h('ul', { class: 'findings' }, rows.map((r) => r.el))
            : h('p', { class: 'hint' }, 'Nothing to act on in the data on disk.')
    );
}

// --- By type ----------------------------------------------------------------------

/** One model's type: Phase 1 failed checks, then each judge's binary fails and
 *  weighted mean. Tinted by whether anything failed, red only for Safety. */
function typeCell(m: ModelRow, type: CheckType): HTMLElement {
    const p1 = m.types[type];
    const judged = data.phase2.judges.flatMap((j) => {
        const mj = j.models.find((x) => x.model === m.id);
        return mj ? [{ judge: j.judgeModel, ...mj.types[type] }] : [];
    });
    const anyFail = p1.failed > 0 || judged.some((x) => x.fails > 0);
    const tone: Tone = !p1.measured && !judged.length ? 'none' : !anyFail ? 'good' : type === 'safety' ? 'critical' : 'warning';
    return h(
        'div',
        { class: `type-cell t-${tone}` },
        h(
            'span',
            { class: 'line', title: p1.parts.join(', ') || (p1.measured ? 'Every check passed' : 'No fixture checks this') },
            h('span', { class: 'jm' }, 'checks'),
            p1.measured ? h('span', { class: p1.failed ? 'score bad' : 'score' }, p1.failed ? `${p1.failed} failed` : 'passed') : h('span', { class: 'na' }, '-')
        ),
        judged.map((x) =>
            h(
                'span',
                {
                    class: 'line',
                    title: `${x.judge}: ${plural(x.fails, 'binary fail')}` + (x.mean !== null ? `, weighted mean ${x.mean.toFixed(2)} over ${plural(x.n, 'reply', 'replies')}` : ''),
                },
                h('span', { class: 'jm' }, x.judge),
                h('span', { class: 'score' }, h('span', { class: x.fails ? 'bad' : '' }, plural(x.fails, 'fail')), x.mean !== null ? ` · ${x.mean.toFixed(2)}` : '')
            )
        )
    );
}

function byType(): HTMLElement {
    const members = (type: CheckType) => {
        const fams = E.families.filter((f) => f.type === type).map((f) => f.label.toLowerCase());
        const dims = Object.entries(data.phase2.dimTypes)
            .filter(([, t]) => t === type)
            .map(([k]) => k);
        return `Phase 1: ${fams.join(', ') || 'none'}. Phase 2: ${dims.join(', ') || 'none'}.`;
    };
    return h(
        'section',
        { id: 'types' },
        h(
            'div',
            { class: 'section-head' },
            h('h2', null, 'Models by type'),
            h(
                'p',
                { class: 'lede' },
                'What kind of thing went wrong, not how badly: Safety is a frightened, ungrounded or endangered meditator, core intent is facilitating the way aloud means to, UX is the session running smoothly. ' +
                    'Each cell: failed Phase 1 checks, then each judge\'s binary fails and weighted mean over the type\'s dimensions (Safety has none, 11 sits outside the means).'
            )
        ),
        E.models.length
            ? h(
                  'div',
                  { class: 'frame' },
                  h(
                      'table',
                      { class: 'grid' },
                      h(
                          'thead',
                          null,
                          h(
                              'tr',
                              null,
                              h('th', { class: 'pin', scope: 'col' }, 'Model'),
                              h('th', { scope: 'col' }, 'Verdict'),
                              E.types.map((t) => h('th', { scope: 'col', title: members(t.id) }, t.label))
                          )
                      ),
                      h(
                          'tbody',
                          null,
                          E.models.map((m) =>
                              h(
                                  'tr',
                                  null,
                                  h('th', { class: 'pin', scope: 'row' }, h('button', { class: 'model-link', onclick: () => select({ k: 'model', model: m.id }) }, m.id)),
                                  h('td', null, verdictPill(m)),
                                  E.types.map((t) => h('td', null, typeCell(m, t.id)))
                              )
                          )
                      )
                  )
              )
            : h('p', { class: 'hint' }, 'No protocol sweeps on disk yet.'),
        h('p', { class: 'small muted' }, 'Types: rubric.md ("Types") for the dimensions, FAMILIES in aggregate.ts for the Phase 1 families.')
    );
}

// --- Matrix -----------------------------------------------------------------------

function cellButton(m: ModelRow, f: FamilyDef): HTMLElement {
    const c = m.cells[f.id];
    if (!c) return h('span', { class: 'na', title: 'No fixture in this run checks this' }, '-');
    const tone = cellTone(c);
    const tip = [
        `${c.pass} of ${c.n} replies passed, over ${plural(c.fixtures.length, 'fixture')}`,
        c.varied.length ? `Identical runs disagreed on: ${c.varied.join(', ')}` : '',
        c.failed.length ? `Failing: ${c.failed.join(', ')}` : '',
    ]
        .filter(Boolean)
        .join('\n');
    return h(
        'button',
        {
            class: `cell t-${tone}${c.varied.length ? ' varied' : ''}`,
            'data-key': `${m.id}|${f.id}`,
            'aria-pressed': 'false',
            'aria-label': `${m.id}, ${f.label}: ${tip}`,
            title: tip,
            onclick: () => select({ k: 'cell', model: m.id, family: f.id }),
        },
        h('span', { class: 'glyph', 'aria-hidden': 'true' }, GLYPH[c.state]),
        `${c.pass}/${c.n}`,
        c.varied.length ? h('span', { class: 'vary', 'aria-hidden': 'true' }, `≈${c.varied.length}`) : null
    );
}

function latencyCell(m: ModelRow, first: boolean): Kid[] {
    const stats = [...m.latency].sort((a, b) => b.n - a.n);
    const shown = stats.filter((s) => (first ? s.firstTextN > 0 : s.n > 0));
    if (shown.length === 0) {
        return [h('span', { class: 'na', title: first ? 'Not streamed, so no first-text time' : 'No replies' }, '-')];
    }
    return shown.flatMap((s, i) => [
        i > 0 ? h('br') : null,
        h(
            'span',
            { title: `median of ${first ? s.firstTextN : s.n} calls` },
            fmtMs(first ? s.firstTextP50Ms : s.p50Ms)
        ),
        viaTag(s.via),
    ]);
}

function costCell(m: ModelRow): Node {
    if (m.costPer1k !== null) {
        return h('span', { title: `mean of ${m.costN} priced calls, times 1000, at list price` }, `$${m.costPer1k < 10 ? m.costPer1k.toFixed(2) : m.costPer1k.toFixed(0)}`);
    }
    const via = m.latency[0]?.via;
    if (via === 'local') return h('span', { class: 'na', title: 'Local model, no per-call cost' }, 'local');
    if (via === 'subscription') return h('span', { class: 'na', title: 'Ran on the subscription, so no call was billed' }, 'sub');
    return h('span', { class: 'na', title: 'Not in the price table, or no usage reported' }, '-');
}

function stockTitle(m: ModelRow): string {
    const top = m.style.phrases.slice(0, 4).map((p) => `${p.phrase} ${p.replies}`);
    return `${m.style.stockReplies} of ${m.style.replies} replies${top.length ? `: ${top.join(', ')}` : ''}`;
}

function promptCell(m: ModelRow): Node {
    if (m.stale > 0) return h('span', { class: 'chip warn', title: `${m.stale} of ${m.trials} replies were measured against an older prompt` }, `stale ${m.stale}`);
    if (m.gone > 0 && m.gone === m.trials) return h('span', { class: 'chip', title: 'Every fixture it ran has since been removed' }, 'gone');
    if (m.unknownHash > 0) return h('span', { class: 'chip', title: 'Measured before prompt hashes were recorded' }, 'no hash');
    return h('span', { class: 'chip', title: 'Every reply was measured against the current prompt' }, 'current');
}

function matrix(): HTMLElement {
    const headCells = [
        h('th', { class: 'pin', scope: 'col' }, 'Model'),
        h('th', { scope: 'col' }, 'Verdict'),
        ...E.families.map((f) => h('th', { scope: 'col', title: `${typeLabel(f.type)}. ${f.title}` }, f.label)),
        h('th', { scope: 'col', class: 'num', title: 'Median spoken words per reply' }, 'Words'),
        h(
            'th',
            { scope: 'col', class: 'num', title: 'Replies per 100 with a stock phrase (stock-phrases.ts), acute turns left out. A count to read, not a rule' },
            'Stock /100'
        ),
        h('th', { scope: 'col', class: 'num', title: 'Share of replies that end in a question, acute turns left out' }, 'Ends ?'),
        h('th', { scope: 'col', class: 'num', title: 'Median request to last byte' }, 'Latency'),
        h('th', { scope: 'col', class: 'num', title: 'Median request to the first text; streamed providers only' }, 'First text'),
        h('th', { scope: 'col', class: 'num', title: 'Measured cost per thousand replies at list price; API calls only' }, '$ / 1k'),
        h('th', { scope: 'col', class: 'num', title: 'Errored calls and empty replies' }, 'Err, empty'),
        h('th', { scope: 'col' }, 'Measured'),
        h('th', { scope: 'col', title: 'Whether the replies were measured against the prompt the builder makes today' }, 'Prompt'),
    ];
    const cols = headCells.length;
    const body: HTMLElement[] = [];
    for (const g of E.groups) {
        const rows = E.models.filter((m) => m.group === g.id);
        if (rows.length === 0) continue;
        body.push(h('tr', { class: 'group' }, h('th', { colspan: cols, scope: 'colgroup' }, h('span', null, g.label))));
        for (const m of rows) {
            const coverage = m.fixtures < E.currentFixtureCount ? `${m.fixtures} of ${E.currentFixtureCount} fixtures` : '';
            body.push(
                h(
                    'tr',
                    null,
                    h(
                        'th',
                        { class: 'pin', scope: 'row' },
                        h('button', { class: 'model-link', title: m.note ?? m.providerModel ?? '', onclick: () => select({ k: 'model', model: m.id }) }, m.id),
                        coverage ? h('span', { class: 'tag', title: `Measured on ${coverage}` }, 'part') : null
                    ),
                    h('td', null, verdictPill(m)),
                    ...E.families.map((f) => h('td', null, cellButton(m, f))),
                    h('td', { class: 'num' }, m.wordsMedian === null ? '-' : String(m.wordsMedian)),
                    h('td', { class: 'num', title: stockTitle(m) }, m.style.per100 === null ? '-' : m.style.per100.toFixed(0)),
                    h(
                        'td',
                        { class: 'num', title: `of ${m.style.replies} replies` },
                        m.style.questionShare === null ? '-' : `${Math.round(m.style.questionShare * 100)}%`
                    ),
                    h('td', { class: 'num' }, latencyCell(m, false)),
                    h('td', { class: 'num' }, latencyCell(m, true)),
                    h('td', { class: 'num' }, costCell(m)),
                    h(
                        'td',
                        { class: 'num', title: `${m.errors} errors, ${m.empties} empty replies in ${m.trials} calls` },
                        h('span', { class: m.errors + m.empties > 0 ? 'chip warn' : '' }, `${m.errors}, ${m.empties}`)
                    ),
                    h(
                        'td',
                        { title: `Sweeps: ${m.sweeps.join(', ')}` },
                        m.measuredFrom === m.measuredTo ? m.measuredTo : `${m.measuredFrom} to ${m.measuredTo}`
                    ),
                    h('td', null, promptCell(m))
                )
            );
        }
    }
    const legendCell = (tone: Tone, glyph: string, text: string, varied = false) =>
        h('span', null, h('span', { class: `cell t-${tone}${varied ? ' varied' : ''}`, 'aria-hidden': 'true' }, h('span', { class: 'glyph' }, glyph), text));
    detailEl = h('div', { class: 'detail', id: 'detail', 'aria-live': 'polite' });
    return h(
        'section',
        { id: 'matrix' },
        h(
            'div',
            { class: 'section-head' },
            h('h2', null, 'Models by situation'),
            h('p', { class: 'lede' }, 'Each cell counts replies that passed (fixtures times runs). Select one to read the replies.')
        ),
        E.models.length
            ? h('div', { class: 'frame' }, h('table', { class: 'grid' }, h('thead', null, h('tr', null, headCells)), h('tbody', null, body)))
            : h('p', { class: 'hint' }, 'No protocol sweeps on disk yet. Run npx tsx evals/protocol-eval.ts, then regenerate.'),
        h(
            'div',
            { class: 'legend' },
            legendCell('good', '✓', 'all passed'),
            legendCell('warning', '◐', '90% or more'),
            legendCell('serious', '◐', 'under 90%'),
            legendCell('critical', '✕', 'none passed'),
            legendCell('warning', '◐', 'runs disagreed ≈ fixtures', true),
            h('span', null, h('span', { class: 'tag' }, 'CLI'), ' Claude on the subscription'),
            h('span', null, h('span', { class: 'tag' }, 'local'), ' Ollama'),
            h('span', null, h('span', { class: 'tag' }, 'part'), ' not every fixture run')
        ),
        h(
            'ul',
            { class: 'notes' },
            h('li', null, 'Checks are re-run on the stored replies with today\'s grader, so an older sweep is judged by the current rules.'),
            h('li', null, 'CLI latencies include the claude CLI\'s startup and are not comparable with API ones; local ones depend on this machine\'s GPU.'),
            h(
                'li',
                null,
                `Disqualified: more than ${E.rules.leakMax * 100}% of replies read a token or bracket aloud, more than ${E.rules.errorMax * 100}% errors or empty replies, or hold right under ${E.rules.holdMin * 100}%. ` +
                    `Trouble check: steps out on under ${E.rules.stepOutMin * 100}% of acute turns (CHECKED_MODELS in stepping-out.ts). ` +
                    'Partly measured: nothing disqualifying, but no hold or no acute fixtures were run.'
            ),
            h('li', null, 'The stepping-out marker lists are crude: read the replies before trusting a step-out or stay-in fail.')
        ),
        detailEl
    );
}

// --- Detail views -----------------------------------------------------------------

/** Control tokens and brackets set off from the prose. */
function replyText(raw: string): Node[] {
    const out: Node[] = [];
    let last = 0;
    for (const m of raw.matchAll(/\[[^\]\n]{0,40}\]|[[\]]/g)) {
        const i = m.index ?? 0;
        if (i > last) out.push(document.createTextNode(raw.slice(last, i)));
        out.push(h('span', { class: 'tok' }, m[0]));
        last = i + m[0].length;
    }
    if (last < raw.length) out.push(document.createTextNode(raw.slice(last)));
    return out;
}

function conversation(fx: FixtureInfo): HTMLElement {
    const turns = fx.history.map((t, i) =>
        h(
            'div',
            { class: `turn ${t.role}` },
            h('span', { class: 'who' }, t.role === 'user' ? (i === fx.history.length - 1 ? 'Meditator' : 'Earlier') : 'Facilitator'),
            h('span', { class: 'said' }, t.content)
        )
    );
    if (fx.phase) turns.unshift(h('div', { class: 'turn system' }, h('span', { class: 'who' }, 'Phase'), h('span', { class: 'said' }, `${fx.mode}, ${fx.phase}`)));
    return h('div', { class: 'convo' }, turns);
}

function runView(t: TrialView, family: FamilyId | null): HTMLElement {
    const inFamily = (name: string) => t.failed.some((f) => f.name === name && f.family === family);
    const failedHere = family ? t.failed.some((f) => f.family === family) : t.failed.length > 0;
    const tone: Tone = t.error ? 'critical' : failedHere ? 'critical' : 'good';
    return h(
        'div',
        { class: `run t-${tone}` },
        h(
            'div',
            { class: 'run-head' },
            h('span', { class: 'who' }, `Run ${t.run + 1}`),
            h('span', null, fmtMs(t.latencyMs), viaTag(t.via)),
            t.firstTextMs !== undefined ? h('span', null, `first text ${fmtMs(t.firstTextMs)}`) : null,
            t.error ? null : h('span', null, plural(t.words, 'word')),
            t.stale === 'stale' ? h('span', { class: 'chip warn' }, 'older prompt') : null,
            t.servedBy ? h('span', null, `via ${t.servedBy}`) : null,
            h('span', null, t.sweep)
        ),
        t.error
            ? h('p', { class: 'err' }, t.error)
            : t.raw.trim()
              ? h('p', { class: 'reply' }, replyText(t.raw))
              : h('p', { class: 'reply empty' }, 'Nothing was said.'),
        t.failed.length
            ? h(
                  'div',
                  { class: 'expect' },
                  [...t.failed]
                      .sort((a, b) => typeRank(familyType(a.family)) - typeRank(familyType(b.family)))
                      .map((f) =>
                          h(
                              'span',
                              { class: `chip ${family === null || inFamily(f.name) ? 'bad' : 'off'}`, title: f.detail ?? '' },
                              `${typeLabel(familyType(f.family))} · `,
                              f.name === 'any-of'
                                  ? 'any-of: names none of the markers'
                                  : `${f.name}${f.detail && !f.name.startsWith('forbid:') ? `: ${f.detail}` : ''}`
                          )
                      )
              )
            : null
    );
}

function fixtureBlock(modelId: string, fixtureId: string, family: FamilyId | null, open: boolean): HTMLElement {
    const fx = E.fixtures[fixtureId];
    const runs = E.trials[`${modelId}|${fixtureId}`] ?? [];
    const failing = runs.filter((t) => t.error || (family ? t.failed.some((f) => f.family === family) : t.failed.length > 0)).length;
    const status: Tone = failing === 0 ? 'good' : failing === runs.length ? 'critical' : 'warning';
    const statusText = failing === 0 ? 'passed' : failing === runs.length ? 'failed every run' : `failed ${failing} of ${runs.length}: runs disagreed`;
    return h(
        'details',
        { class: 'fx', open },
        h(
            'summary',
            null,
            h('span', { class: 'fx-id' }, fixtureId),
            h('span', { class: `pill t-${status}` }, statusText),
            fx && !fx.exists ? h('span', { class: 'chip' }, 'no longer a fixture') : null
        ),
        h(
            'div',
            { class: 'fx-body' },
            fx ? h('p', { class: 'probe' }, fx.probe) : null,
            fx && fx.history.length ? conversation(fx) : null,
            fx && fx.expect.length ? h('div', { class: 'expect' }, fx.expect.map((e) => h('span', { class: 'chip' }, e))) : null,
            h('div', { class: 'runs' }, runs.map((t) => runView(t, family))),
            h('div', { class: 'detail-actions' }, h('button', { class: 'btn', onclick: () => select({ k: 'fixture', fixture: fixtureId }) }, 'Compare every model on this fixture'))
        )
    );
}

function cellDetail(m: ModelRow, f: FamilyDef): Node[] {
    const c = m.cells[f.id];
    if (!c) return [];
    const rank = (id: string) => (c.varied.includes(id) ? 0 : c.failed.includes(id) ? 1 : 2);
    const ordered = [...c.fixtures].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return [
        h(
            'div',
            { class: 'detail-head' },
            h('p', { class: 'eyebrow' }, `${f.label} · ${typeLabel(f.type)}`),
            h('h3', null, m.id, ' ', verdictPill(m)),
            h(
                'p',
                { class: 'sub' },
                `${c.pass} of ${c.n} replies passed over ${plural(c.fixtures.length, 'fixture')}` +
                    (c.varied.length ? `; identical runs disagreed on ${plural(c.varied.length, 'fixture')}` : '') +
                    `. ${f.title}.`
            ),
            h('div', { class: 'detail-actions' }, h('button', { class: 'btn', onclick: () => select({ k: 'model', model: m.id }) }, `All of ${m.id}`))
        ),
        ...ordered.map((id) => fixtureBlock(m.id, id, f.id, rank(id) < 2 || ordered.length <= 3)),
    ];
}

function modelDetail(m: ModelRow): Node[] {
    const fams = E.families
        .filter((f) => m.cells[f.id])
        .map((f) => h('div', { class: 'fam' }, h('span', null, f.label), cellButton(m, f)));
    return [
        h(
            'div',
            { class: 'detail-head' },
            h('p', { class: 'eyebrow' }, E.groups.find((g) => g.id === m.group)?.label ?? ''),
            h('h3', null, m.id, ' ', verdictPill(m)),
            m.reasons.length ? h('ul', { class: 'reasons' }, m.reasons.map((r) => h('li', null, r))) : null
        ),
        h('div', { class: 'model-grid' }, fams),
        h(
            'dl',
            { class: 'kv' },
            h('dt', null, 'Provider id'),
            h('dd', null, h('code', null, `${m.provider ?? '?'}:${m.providerModel ?? '?'}`)),
            m.note ? [h('dt', null, 'Why it is in the roster'), h('dd', null, m.note)] : null,
            h('dt', null, 'Measured'),
            h('dd', null, `${m.trials} replies on ${m.fixtures} fixtures, ${m.measuredFrom === m.measuredTo ? m.measuredTo : `${m.measuredFrom} to ${m.measuredTo}`}, sweep ${m.sweeps.join(', ')}`),
            h('dt', null, 'Stock phrases'),
            h(
                'dd',
                null,
                m.style.phrases.length
                    ? `${m.style.stockReplies} of ${m.style.replies} replies: ${m.style.phrases.map((p) => `${p.phrase} ×${p.replies}`).join(', ')}`
                    : `none in ${m.style.replies} replies`
            ),
            h('dt', null, 'Shape'),
            h(
                'dd',
                null,
                m.style.questionShare === null ? '' : `${Math.round(m.style.questionShare * 100)}% end in a question`,
                m.style.topOpening ? `; most repeated opening "${m.style.topOpening.words}" ×${m.style.topOpening.count}` : ''
            ),
            h('dt', null, 'Latency'),
            h(
                'dd',
                null,
                m.latency.map((s, i) => [
                    i > 0 ? '; ' : '',
                    `${fmtMs(s.p50Ms)} median of ${s.n}`,
                    s.firstTextN ? `, first text ${fmtMs(s.firstTextP50Ms)}` : '',
                    viaTag(s.via),
                ])
            ),
            m.history.length
                ? [
                      h('dt', null, 'Older sweeps'),
                      h(
                          'dd',
                          null,
                          m.history.map((hs) =>
                              h(
                                  'div',
                                  null,
                                  `${hs.sweep} (${hs.date}, ${hs.trials} replies): `,
                                  E.families
                                      .filter((f) => hs.cells[f.id])
                                      .map((f) => `${f.label.toLowerCase()} ${hs.cells[f.id]?.pass}/${hs.cells[f.id]?.n}`)
                                      .join(', ')
                              )
                          )
                      ),
                  ]
                : null
        ),
    ];
}

function judgeVerdictsFor(fixture: string): Array<{ judgeModel: string; label: string; v: JudgeVerdictRecord }> {
    return E.judging.flatMap((g) =>
        g.verdicts.filter((v) => v.fixture === fixture).map((v) => ({ judgeModel: g.judgeModel, label: `${g.sweep} ${g.label}`.trim(), v }))
    );
}

/** The blind letters the rationale talks in, decoded. */
function letterKey(v: JudgeVerdictRecord): HTMLElement | null {
    if (!v.key) return null;
    return h(
        'span',
        { class: 'small muted' },
        Object.entries(v.key)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([letter, model]) => `${letter} = ${model}`)
            .join(', ')
    );
}

function judgeLine(judgeModel: string, label: string, v: JudgeVerdictRecord): HTMLElement {
    return h(
        'div',
        { class: 'card' },
        h(
            'div',
            { class: 'judge-heading' },
            h('span', { class: 'judge-name' }, judgeName(judgeModel)),
            h('span', { class: 'small muted' }, label),
            h('span', null, v.winner === 'tie' ? 'Tie' : `Preferred ${v.winner}`),
            v.worst && v.worst !== 'none' ? h('span', null, `last ${v.worst}`) : null,
            v.margin ? h('span', { class: 'chip' }, v.margin) : null,
            v.gateFails?.length ? h('span', { class: 'chip bad' }, `broke a rule: ${v.gateFails.join(', ')}`) : null
        ),
        h('p', null, v.rationale),
        letterKey(v)
    );
}

function fixtureCompare(fixtureId: string): Node[] {
    const fx = E.fixtures[fixtureId];
    const who = E.models.filter((m) => E.trials[`${m.id}|${fixtureId}`]);
    const verdicts = judgeVerdictsFor(fixtureId);
    return [
        h(
            'div',
            { class: 'detail-head' },
            h('p', { class: 'eyebrow' }, 'Every model on one fixture'),
            h('h3', null, h('code', null, fixtureId)),
            fx ? h('p', { class: 'sub' }, fx.probe) : null
        ),
        fx && fx.history.length ? conversation(fx) : null,
        fx && fx.expect.length ? h('div', { class: 'expect' }, fx.expect.map((e) => h('span', { class: 'chip' }, e))) : null,
        verdicts.length ? h('div', { class: 'winces' }, verdicts.map((x) => judgeLine(x.judgeModel, x.label, x.v))) : null,
        h(
            'div',
            null,
            who.map((m) =>
                h(
                    'div',
                    { class: 'compare-model' },
                    h(
                        'div',
                        { class: 'compare-head' },
                        h('button', { class: 'model-link', onclick: () => select({ k: 'model', model: m.id }) }, m.id),
                        verdictPill(m)
                    ),
                    h('div', { class: 'runs' }, (E.trials[`${m.id}|${fixtureId}`] ?? []).map((t) => runView(t, null)))
                )
            )
        ),
    ].filter((x): x is HTMLElement => x !== null);
}

// --- Blind judging ----------------------------------------------------------------

function judgeName(judgeModel: string): string {
    return judgeModel === 'unrecorded' ? 'judge not recorded' : judgeModel;
}

function handMadeBlocks(): HTMLElement[] {
    const byJudge = new Map<string, typeof E.judging>();
    for (const g of E.judging) byJudge.set(g.judgeModel, [...(byJudge.get(g.judgeModel) ?? []), g]);
    const blocks: HTMLElement[] = [];
    for (const [judgeModel, groups] of byJudge) {
        blocks.push(
            h(
                'div',
                { class: 'judge-heading' },
                h('h3', null, 'Judged by'),
                h('span', { class: 'judge-name' }, judgeName(judgeModel)),
                judgeModel === 'unrecorded'
                    ? h('span', { class: 'small muted' }, 'Made by hand; add blind-judge.json to its sweep to name the judge.')
                    : null
            )
        );
        for (const g of groups) {
            const hasWorst = g.verdicts.some((v) => v.worst !== undefined);
            const hasScores = g.tally.some((t) => t.meanScore !== null);
            blocks.push(
                h(
                    'div',
                    { class: 'card' },
                    h(
                        'div',
                        { class: 'card-head' },
                        h('strong', null, `${g.sweep}${g.label ? `, ${g.label}` : ''}`),
                        h(
                            'span',
                            { class: 'small muted' },
                            `${day(g.startedAt)} · ${plural(g.verdicts.length, 'fixture')} · ${plural(g.ties, 'tie')} · ${g.handMade ? 'made by hand, ' : ''}${g.source}`
                        )
                    ),
                    h(
                        'div',
                        { class: 'frame' },
                        h(
                            'table',
                            { class: 'grid' },
                            h(
                                'thead',
                                null,
                                h(
                                    'tr',
                                    null,
                                    h('th', null, 'Model'),
                                    h('th', { class: 'num' }, 'Preferred'),
                                    hasWorst ? h('th', { class: 'num' }, 'Ranked last') : null,
                                    h('th', { class: 'num', title: 'Fixtures where the judge said this model broke a hard rule' }, 'Broke a rule'),
                                    hasScores ? h('th', { class: 'num' }, 'Mean score') : null
                                )
                            ),
                            h(
                                'tbody',
                                null,
                                [...g.tally]
                                    .sort((a, b) => b.wins - a.wins)
                                    .map((t) =>
                                        h(
                                            'tr',
                                            null,
                                            h('td', null, MODEL.has(t.model) ? h('button', { class: 'model-link', onclick: () => select({ k: 'model', model: t.model }) }, t.model) : t.model),
                                            h('td', { class: 'num' }, String(t.wins)),
                                            hasWorst ? h('td', { class: 'num' }, String(t.worst)) : null,
                                            h('td', { class: 'num' }, String(t.gateFails)),
                                            hasScores ? h('td', { class: 'num' }, t.meanScore === null ? '-' : t.meanScore.toFixed(1)) : null
                                        )
                                    )
                            )
                        )
                    ),
                    h(
                        'details',
                        { class: 'more' },
                        h('summary', null, 'Verdicts by fixture'),
                        h(
                            'div',
                            { class: 'frame' },
                            h(
                                'table',
                                { class: 'grid' },
                                h('thead', null, h('tr', null, h('th', null, 'Fixture'), h('th', null, 'Preferred'), hasWorst ? h('th', null, 'Last') : null, h('th', null, 'Broke a rule'), h('th', null, 'Why'))),
                                h(
                                    'tbody',
                                    null,
                                    g.verdicts.map((v) =>
                                        h(
                                            'tr',
                                            { class: 'verdict-row' },
                                            h('td', null, h('button', { class: 'model-link', onclick: () => select({ k: 'fixture', fixture: v.fixture }) }, v.fixture)),
                                            h('td', null, v.winner === 'tie' ? 'tie' : v.winner, v.margin ? h('span', { class: 'tag' }, v.margin) : null),
                                            hasWorst ? h('td', null, v.worst ?? '') : null,
                                            h('td', null, (v.gateFails ?? []).join(', ')),
                                            h('td', { class: 'wrap-cell' }, v.rationale, v.key ? h('br') : null, letterKey(v))
                                        )
                                    )
                                )
                            )
                        )
                    )
                )
            );
        }
    }
    return blocks;
}

const P2 = data.phase2;
const DIM = new Map(P2.dims.map((d) => [d.id, d]));
const dimLabel = (id: string) => `${id} ${DIM.get(id as never)?.name ?? ''}`.trim();
const PANEL = new Map(P2.panels.map((p) => [p.id, p]));
let panelBoxes = new Map<string, HTMLElement>();

function openPanel(id: string): void {
    const p = PANEL.get(id);
    const box = p && panelBoxes.get(p.judgeModel);
    if (!p || !box) return;
    box.replaceChildren(...panelView(p));
    box.scrollIntoView({ block: 'start' });
}

function panelView(p: (typeof P2.panels)[number]): Node[] {
    const fx = E.fixtures[p.fixture];
    return [
        h(
            'div',
            { class: 'detail-head' },
            h('p', { class: 'eyebrow' }, `Panel judged by ${p.judgeModel}, run ${p.run + 1}`),
            h('h3', null, h('code', null, p.fixture)),
            fx ? h('p', { class: 'sub' }, fx.settings) : null,
            h(
                'div',
                { class: 'expect' },
                p.staleInputs ? h('span', { class: 'chip warn', title: 'A reply was measured at an older prompt than today\'s' }, 'older prompt') : null,
                p.staleRubric ? h('span', { class: 'chip warn', title: 'rubric.md has changed since this was judged' }, 'older rubric') : null,
                p.sameFamily.length ? h('span', { class: 'chip', title: 'Replies from the judge\'s own family' }, `judge's family: ${p.sameFamily.join(', ')}`) : null,
                p.costUsd !== undefined ? h('span', { class: 'chip' }, `$${p.costUsd.toFixed(4)}`) : null,
                p.latencyMs !== undefined ? h('span', { class: 'chip' }, fmtMs(p.latencyMs)) : null
            )
        ),
        fx && fx.history.length ? conversation(fx) : null,
        p.error ? h('p', { class: 'err' }, `The judge's answer could not be used: ${p.error}`) : null,
        p.decided?.top ? h('p', null, h('strong', null, `First place decided by ${dimLabel(p.decided.top.dim)}: `), p.decided.top.why) : null,
        p.decided?.bottom ? h('p', null, h('strong', null, `Last place decided by ${dimLabel(p.decided.bottom.dim)}: `), p.decided.bottom.why) : null,
        h(
            'div',
            { class: 'runs' },
            p.replies.map((r) =>
                h(
                    'div',
                    { class: `run t-${r.fails.length ? 'critical' : 'good'}` },
                    h(
                        'div',
                        { class: 'run-head' },
                        h('span', { class: 'who' }, r.rank !== null ? `#${r.rank}` : '-'),
                        MODEL.has(r.model) ? h('button', { class: 'model-link', onclick: () => select({ k: 'model', model: r.model }) }, r.model) : h('code', null, r.model),
                        h('span', { title: 'The blind letter the judge saw; its notes and reasons use these' }, `reply ${r.letter}`),
                        p.sameFamily.includes(r.model) ? h('span', { class: 'chip' }, "judge's family") : null
                    ),
                    h('p', { class: 'reply' }, r.spoken),
                    r.signals.length ? h('p', { class: 'small muted' }, `Also signalled: ${r.signals.join('; ')}`) : null,
                    r.fails.length
                        ? h(
                              'div',
                              { class: 'expect' },
                              [...r.fails]
                                  .sort((a, b) => typeRank(a.type) - typeRank(b.type))
                                  .map((f) =>
                                      h(
                                          'span',
                                          { class: 'chip bad', title: f.quoteFound ? '' : 'These words are not in the reply as written' },
                                          `${typeLabel(f.type)} · ${dimLabel(f.dim)}: "${f.quote}"${f.quoteFound ? '' : ' (misquoted)'}`
                                      )
                                  )
                          )
                        : null,
                    h('div', { class: 'dims' }, Object.entries(r.scores).map(([d, v]) => h('span', { class: 'chip', title: dimLabel(d) }, `${d} ${v}`))),
                    r.note ? h('p', { class: 'small' }, r.note) : null
                )
            )
        ),
        p.warnings?.length ? h('p', { class: 'small muted' }, `Judge warnings: ${p.warnings.join('; ')}`) : null,
    ].filter((x): x is HTMLElement => x !== null);
}

function modelCell(model: string): Node {
    return MODEL.has(model) ? h('button', { class: 'model-link', onclick: () => select({ k: 'model', model }) }, model) : h('code', null, model);
}

function judgeBlock(j: (typeof P2.judges)[number]): HTMLElement {
    const box = h('div', { class: 'detail', id: `panel-${j.judgeModel}` });
    panelBoxes.set(j.judgeModel, box);
    const failRows = j.models.flatMap((m) => m.fails.map((f) => ({ m, f })));
    const usedDims = P2.dims.filter((d) => j.models.some((m) => m.dims[d.id]));
    const myPanels = P2.panels.filter((p) => p.judgeModel === j.judgeModel);
    const meta = [
        plural(j.panels, 'panel'),
        j.errors ? plural(j.errors, 'unusable answer') : '',
        j.latencyP50Ms !== null ? `median ${fmtMs(j.latencyP50Ms)} a panel` : '',
        j.costPerPanel !== null ? `$${j.costPerPanel.toFixed(4)} a panel, $${(j.costUsd ?? 0).toFixed(3)} in all` : 'no cost recorded (subscription)',
    ].filter(Boolean);
    return h(
        'div',
        { class: 'card' },
        h(
            'div',
            { class: 'card-head' },
            h('div', { class: 'judge-heading' }, h('h3', null, 'Judged by'), h('span', { class: 'judge-name' }, j.judgeModel)),
            h('span', { class: 'small muted' }, meta.join(' · '))
        ),
        j.staleInputs || j.staleRubric
            ? h(
                  'div',
                  { class: 'expect' },
                  j.staleInputs ? h('span', { class: 'chip warn' }, `${j.staleInputs} of ${j.panels} panels judged replies measured at an older prompt`) : null,
                  j.staleRubric ? h('span', { class: 'chip warn' }, `${j.staleRubric} judged against an older rubric`) : null
              )
            : null,
        h('h3', null, 'Binary fails'),
        failRows.length
            ? h(
                  'div',
                  { class: 'fail-list' },
                  TYPE_ORDER.map((type) => {
                      const mine = j.models.map((m) => ({ model: m.model, fails: m.fails.filter((f) => f.type === type) })).filter((x) => x.fails.length);
                      if (!mine.length) return null;
                      return h(
                          'div',
                          { class: 'fail-type' },
                          h('div', { class: 'fail-type-head' }, typeTag(type), h('span', { class: 'small muted' }, plural(mine.reduce((a, x) => a + x.fails.length, 0), 'fail'))),
                          mine.map(({ model, fails }) =>
                              h(
                                  'div',
                                  { class: 'fail-group' },
                                  h('div', { class: 'fail-model' }, modelCell(model), h('span', { class: 'small muted' }, plural(fails.length, 'fail'))),
                                  fails.map((f) =>
                                      h(
                                          'button',
                                          { class: 'fail-item', onclick: () => openPanel(f.panel), title: 'Open the panel' },
                                          h('span', { class: 'small muted' }, `${f.fixture}${f.run ? ` run ${f.run + 1}` : ''} · ${dimLabel(f.dim)}`),
                                          h('span', { class: 'quote' }, `"${f.quote}"`, f.quoteFound ? null : h('span', { class: 'chip warn' }, 'misquoted'))
                                      )
                                  )
                              )
                          )
                      );
                  })
              )
            : h('p', { class: 'hint' }, 'No binary fails.'),
        h('h3', null, 'Wins'),
        h(
            'div',
            { class: 'frame' },
            h(
                'table',
                { class: 'grid' },
                h(
                    'thead',
                    null,
                    h(
                        'tr',
                        null,
                        h('th', null, 'Model'),
                        h('th', { class: 'num' }, 'Panels'),
                        h('th', { class: 'num' }, 'First'),
                        h('th', { class: 'num' }, 'Last'),
                        h('th', { class: 'num' }, 'Binary fails'),
                        h('th', { class: 'num', title: 'Dimension 11, outside the means: passed on stepping-out turns' }, 'Step out')
                    )
                ),
                h(
                    'tbody',
                    null,
                    [...j.models]
                        .sort((a, b) => b.wins - a.wins || a.lasts - b.lasts)
                        .map((m) =>
                            h(
                                'tr',
                                null,
                                h('td', null, modelCell(m.model)),
                                h('td', { class: 'num' }, String(m.panels)),
                                h('td', { class: 'num' }, String(m.wins)),
                                h('td', { class: 'num' }, String(m.lasts)),
                                h('td', { class: 'num' }, m.fails.length ? h('span', { class: 'chip bad' }, String(m.fails.length)) : '0'),
                                h('td', { class: 'num' }, m.stepOut ? `${m.stepOut.pass}/${m.stepOut.n}` : '-')
                            )
                        )
                )
            )
        ),
        h('h3', null, 'Weighted means'),
        h('p', { class: 'small muted' }, 'Each score weighted by its dimension\'s weight at the fixture\'s guidance level (rubric.md); a binary pass counts 5, a fail 1. Hover a number for its n.'),
        h(
            'div',
            { class: 'frame' },
            h(
                'table',
                { class: 'grid' },
                h(
                    'thead',
                    null,
                    h(
                        'tr',
                        null,
                        h('th', { class: 'pin' }, 'Model'),
                        h('th', { class: 'num' }, 'Overall'),
                        h('th', { class: 'num', title: 'Largest spread of one fixture\'s turn score across runs' }, 'Spread'),
                        usedDims.map((d) => h('th', { class: 'num', title: `${d.name}${d.binary ? ' (binary)' : ''}` }, d.id))
                    )
                ),
                h(
                    'tbody',
                    null,
                    [...j.models]
                        .sort((a, b) => (b.overall?.mean ?? 0) - (a.overall?.mean ?? 0))
                        .map((m) =>
                            h(
                                'tr',
                                null,
                                h('th', { class: 'pin', scope: 'row' }, modelCell(m.model)),
                                h('td', { class: 'num', title: m.overall ? `${m.overall.n} replies` : '' }, h('strong', null, m.overall ? m.overall.mean.toFixed(2) : '-')),
                                h(
                                    'td',
                                    { class: 'num', title: m.variance.wide.map((w) => `${w.fixture}: ${w.scores.map((x) => x.toFixed(1)).join(', ')}`).join('\n') || (m.variance.fixturesWithRuns ? '' : 'One run per fixture: no spread to measure') },
                                    m.variance.maxSpread === null ? '-' : h('span', { class: m.variance.wide.length ? 'chip warn' : '' }, m.variance.maxSpread.toFixed(1))
                                ),
                                usedDims.map((d) => {
                                    const c = m.dims[d.id];
                                    return h('td', { class: 'num', title: c ? `n ${c.n}` : 'not on any panel it was in' }, c ? c.mean.toFixed(1) : '-');
                                })
                            )
                        )
                )
            )
        ),
        h(
            'details',
            { class: 'more' },
            h('summary', null, `Every panel (${myPanels.length})`),
            h(
                'div',
                { class: 'expect' },
                myPanels.map((p) =>
                    h('button', { class: `item-link${p.error ? ' chip bad' : ''}`, onclick: () => openPanel(p.id) }, `${p.fixture}${p.run ? ` run ${p.run + 1}` : ''}`)
                )
            )
        ),
        box
    );
}

function agreement(): HTMLElement | null {
    if (!P2.pairs.length) return null;
    return h(
        'div',
        { class: 'card' },
        h('h3', null, 'How far the judges agree'),
        h('p', { class: 'small muted' }, 'On panels both judged. Rank correlation is Kendall\'s tau on the replies both ranked: 1 is the same order, 0 is none. Family tilt: the mean place each judge gives a family\'s replies, 0 first and 1 last.'),
        h(
            'div',
            { class: 'frame' },
            h(
                'table',
                { class: 'grid' },
                h('thead', null, h('tr', null, h('th', null, 'Judges'), h('th', { class: 'num' }, 'Shared panels'), h('th', { class: 'num' }, 'Same first place'), h('th', { class: 'num' }, 'Rank correlation'), h('th', null, 'Family tilt'))),
                h(
                    'tbody',
                    null,
                    P2.pairs.map((pr) =>
                        h(
                            'tr',
                            { class: 'verdict-row' },
                            h('td', null, `${pr.a} and ${pr.b}`),
                            h('td', { class: 'num' }, String(pr.shared)),
                            h('td', { class: 'num' }, pr.shared ? `${pr.topAgree} of ${pr.shared}` : '-'),
                            h('td', { class: 'num' }, pr.tau === null ? '-' : pr.tau.toFixed(2)),
                            h(
                                'td',
                                { class: 'wrap-cell' },
                                pr.tilts.length
                                    ? pr.tilts.map((t) => `${t.family} replies (${t.n}): ${t.aPos.toFixed(2)} from ${pr.a}, ${t.bPos.toFixed(2)} from ${pr.b}`).join('; ')
                                    : 'No replies from either judge\'s family on the shared panels'
                            )
                        )
                    )
                )
            )
        )
    );
}

function judging(): HTMLElement {
    panelBoxes = new Map();
    const handMade = handMadeBlocks();
    const judges = P2.judges.map(judgeBlock);
    return h(
        'section',
        { id: 'judging' },
        h(
            'div',
            { class: 'section-head' },
            h('h2', null, 'Blind judging'),
            h(
                'p',
                { class: 'lede' },
                'A judge reads every model\'s reply to one turn at once, shuffled and lettered, against the rubric sections that turn exercises (rubric.md). Results never pool across judges.'
            )
        ),
        judges.length ? judges : h('p', { class: 'hint' }, 'No rubric judging yet: npm run evals:judge -- --sweep <name> (evals/README.md).'),
        agreement(),
        handMade.length ? [h('h3', null, 'Made by hand'), ...handMade] : null
    );
}

// --- Soak ---------------------------------------------------------------------------

const TIER_LABEL: Record<SoakTier, string> = { headless: 'Tier 1, text on a fake clock', browser: 'Tier 2, the web app out loud' };

function soakCellButton(t: SoakTierView, facilitator: string, scenario: string, c: SoakCell | undefined): Node {
    if (!c) return h('span', { class: 'na' }, '-');
    const tone: Tone = c.failedSessions > 0 ? 'critical' : 'none';
    const key = `${t.tier}|${facilitator}|${scenario}`;
    return h(
        'button',
        {
            class: `soak-cell t-${tone}`,
            'data-key': key,
            'aria-pressed': 'false',
            title: `${plural(c.sessions, 'session')}, ${day(c.from)} to ${day(c.to)}`,
            onclick: (ev: Event) => {
                document.querySelectorAll('.soak-cell[aria-pressed="true"]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
                (ev.currentTarget as HTMLElement).setAttribute('aria-pressed', 'true');
                const box = soakDetail.get(t.tier);
                if (!box) return;
                box.replaceChildren(...soakSessions(t.tier, facilitator, scenario));
                box.scrollIntoView({ block: 'start' });
            },
        },
        h(
            'span',
            { class: 'line' },
            h('span', null, plural(c.sessions, 'session')),
            c.fails ? h('span', { class: 'bad' }, `✕ ${plural(c.fails, 'fail')}`) : c.warns ? h('span', { class: 'warnish' }, plural(c.warns, 'warn')) : null
        ),
        c.judges.map((j) =>
            h(
                'span',
                {
                    class: 'line',
                    title: `${j.judgeModel}: mean of ${plural(j.n, 'verdict')} on ${plural(j.sessions, 'session')}, range ${j.min} to ${j.max}`,
                },
                h('span', { class: 'jm' }, j.judgeModel),
                h('span', { class: 'score' }, `${j.mean.toFixed(1)}`, h('span', { class: 'muted' }, ` ×${j.sessions}${j.n > j.sessions ? ` (${j.n})` : ''}`))
            )
        ),
        c.turnErrorSessions ? h('span', { class: 'line warnish' }, `${c.turnErrorSessions} with failed calls`) : null
    );
}

function soakSessions(tier: SoakTier, facilitator: string, scenario: string): Node[] {
    const sessions = S.sessions.filter((s) => s.tier === tier && s.facilitator === facilitator && s.scenario === scenario);
    return [
        h(
            'div',
            { class: 'detail-head' },
            h('p', { class: 'eyebrow' }, TIER_LABEL[tier]),
            h('h3', null, h('code', null, facilitator), ' on ', h('code', null, scenario)),
            h('p', { class: 'sub' }, `${plural(sessions.length, 'session')}. Transcripts: soak-runs/<run>/report.md.`)
        ),
        ...sessions.map(sessionView),
    ];
}

function sessionView(s: SoakSession): HTMLElement {
    const issues = s.findings.filter((f) => f.level !== 'info');
    return h(
        'div',
        { class: 'session' },
        h(
            'div',
            { class: 'run-head' },
            h('span', { class: 'who' }, s.run),
            h('span', null, s.startedAt.replace('T', ' ').slice(0, 16)),
            h('span', null, `ended by ${s.endedBy}`),
            s.costUsd !== null ? h('span', null, `$${s.costUsd.toFixed(3)} facilitator`) : null,
            s.gitSha ? h('span', null, s.gitSha.slice(0, 10)) : null
        ),
        issues.length
            ? h(
                  'div',
                  { class: 'expect' },
                  issues.map((f) => h('span', { class: `chip ${f.level === 'fail' ? 'bad' : 'warn'}`, title: f.detail }, `${f.id}: ${f.detail.slice(0, 90)}`))
              )
            : null,
        s.error ? h('p', { class: 'err' }, s.error) : null,
        s.judgeError ? h('p', { class: 'err' }, `judge: ${s.judgeError}`) : null,
        s.judgements.map((j) =>
            h(
                'div',
                { class: 'judgement' },
                h(
                    'div',
                    { class: 'judge-heading' },
                    h('span', { class: 'judge-name' }, j.judgeModel),
                    h('strong', null, `${j.verdict.overall}/10`),
                    h(
                        'span',
                        { class: 'dims' },
                        Object.entries(j.verdict.dimensions)
                            .filter((e): e is [string, number] => typeof e[1] === 'number')
                            .map(([k, v]) =>
                                // holds_session is the rubric's 12, the one soak score with a type.
                                k === 'holds_session'
                                    ? h('span', { class: 'chip', title: `Rubric dimension 12, ${typeLabel(data.phase2.dimTypes['12'])}` }, `12 holds session ${v}`, typeTag(data.phase2.dimTypes['12']))
                                    : h('span', { class: 'chip' }, `${k.replace(/_/g, ' ')} ${v}`)
                            )
                    )
                ),
                j.verdict.notes ? h('p', { class: 'small' }, j.verdict.notes) : null,
                j.verdict.winceMoments.map((w) => h('blockquote', { class: 'wince' }, h('q', null, w.quote), h('span', { class: 'small muted' }, w.why)))
            )
        )
    );
}

function soakTier(t: SoakTierView): HTMLElement {
    const box = h('div', { class: 'detail', id: `soak-detail-${t.tier}` });
    soakDetail.set(t.tier, box);
    const matrixTable = h(
        'table',
        { class: 'grid' },
        h(
            'thead',
            null,
            h(
                'tr',
                null,
                h('th', { class: 'pin' }, 'Facilitator'),
                t.scenarios.map((s) => h('th', { title: s.title }, s.id))
            )
        ),
        h(
            'tbody',
            null,
            t.facilitators.map((f) =>
                h(
                    'tr',
                    null,
                    h('th', { class: 'pin', scope: 'row' }, h('code', null, f)),
                    t.scenarios.map((s) => h('td', null, soakCellButton(t, f, s.id, t.cells[`${f}|${s.id}`])))
                )
            )
        )
    );
    const checks = h(
        'div',
        { class: 'frame', id: `soak-checks-${t.tier}` },
        h(
            'table',
            { class: 'grid' },
            h('thead', null, h('tr', null, h('th', null, 'Check'), h('th', null, 'Level'), h('th', { class: 'num' }, 'Sessions'), h('th', null, 'Facilitators'), h('th', null, 'Scenarios'), h('th', null, 'Last seen'), h('th', null, 'Example'))),
            h(
                'tbody',
                null,
                t.checks.map((g) =>
                    h(
                        'tr',
                        { class: 'verdict-row' },
                        h('td', null, h('code', null, g.id)),
                        h('td', null, h('span', { class: `chip ${g.level === 'fail' ? 'bad' : 'warn'}` }, g.level)),
                        h('td', { class: 'num', title: `${g.occurrences} occurrences` }, String(g.sessions)),
                        h('td', { class: 'wrap-cell' }, g.facilitators.join(', ')),
                        h('td', { class: 'wrap-cell' }, g.scenarios.join(', ')),
                        h('td', null, day(g.last)),
                        h('td', { class: 'wrap-cell' }, g.samples[0] ?? '')
                    )
                )
            )
        )
    );
    const winces = t.winces;
    return h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', null, TIER_LABEL[t.tier]), h('span', { class: 'small muted' }, `judges: ${t.judgeModels.join(', ') || 'none'}`)),
        h('div', { class: 'frame' }, matrixTable),
        box,
        h('h3', null, 'Check failures and warnings'),
        t.checks.length ? checks : h('p', { class: 'hint' }, 'No check failed or warned.'),
        h(
            'details',
            { class: 'more' },
            h('summary', null, `Wince quotes (${winces.length})`),
            h(
                'div',
                { class: 'winces' },
                winces.map((w) =>
                    h(
                        'blockquote',
                        { class: 'wince' },
                        h('q', null, w.quote),
                        h('span', { class: 'small' }, w.why),
                        h('span', { class: 'small muted' }, `${w.facilitator} on ${w.scenario}, judged by ${w.judgeModel}, ${day(w.startedAt)} (${w.run})`)
                    )
                )
            )
        )
    );
}

function soak(): HTMLElement {
    soakDetail = new Map();
    const runsTable = h(
        'div',
        { class: 'frame' },
        h(
            'table',
            { class: 'grid' },
            h('thead', null, h('tr', null, h('th', null, 'Run'), h('th', null, 'Started'), h('th', null, 'Tier'), h('th', null, 'Battery'), h('th', null, 'Facilitators'), h('th', null, 'Judge'), h('th', { class: 'num' }, 'Sessions'), h('th', null, 'Commit'))),
            h(
                'tbody',
                null,
                S.runs.map((r) =>
                    h(
                        'tr',
                        null,
                        h('td', null, h('code', null, r.dir)),
                        h('td', null, r.startedAt.replace('T', ' ').slice(0, 16)),
                        h('td', null, r.tier === 'headless' ? '1' : '2'),
                        h('td', null, r.battery ?? ''),
                        h('td', { class: 'wrap-cell' }, r.facilitators.join(', ')),
                        h('td', null, r.judges.join(', ') || 'off'),
                        h('td', { class: 'num' }, String(r.sessions)),
                        h(
                            'td',
                            null,
                            r.gitSha
                                ? `${r.gitSha.slice(0, 10)}${r.gitDirty ? ' + changes' : ''}`
                                : h('span', { class: 'na', title: 'Runs before soak recorded a commit' }, '-')
                        )
                    )
                )
            )
        )
    );
    return h(
        'section',
        { id: 'soak' },
        h(
            'div',
            { class: 'section-head' },
            h('h2', null, 'Whole sessions'),
            h(
                'p',
                { class: 'lede' },
                'Soak runs: an LLM meditator against the real engine. Check fails are the trustworthy signal. Judge scores compare only within one judge model, and a move under 1.5 is noise (dev-docs/soak-harness.md).'
            )
        ),
        S.tiers.length ? S.tiers.map(soakTier) : h('p', { class: 'hint' }, 'No soak runs on disk.'),
        S.runs.length ? h('details', { class: 'more' }, h('summary', null, `Runs on disk (${S.runs.length})`), runsTable) : null
    );
}

// --- Gaps ---------------------------------------------------------------------------

function gaps(): HTMLElement {
    const stale = E.models.filter((m) => m.stale > 0 || m.unknownHash > 0);
    return h(
        'section',
        { id: 'gaps' },
        h('div', { class: 'section-head' }, h('h2', null, 'Not measured')),
        E.notMeasured.length
            ? h(
                  'div',
                  { class: 'frame' },
                  h(
                      'table',
                      { class: 'grid' },
                      h('thead', null, h('tr', null, h('th', null, 'Roster model'), h('th', null, 'Group'), h('th', null, 'Why it is in the roster'))),
                      h(
                          'tbody',
                          null,
                          E.notMeasured.map((m) =>
                              h(
                                  'tr',
                                  { class: 'verdict-row' },
                                  h('td', null, h('code', null, m.id)),
                                  h('td', null, E.groups.find((g) => g.id === m.group)?.label ?? m.group),
                                  h('td', { class: 'wrap-cell' }, m.note)
                              )
                          )
                      )
                  )
              )
            : h('p', { class: 'hint' }, 'Every roster model has protocol data.'),
        stale.length
            ? h(
                  'ul',
                  { class: 'notes' },
                  stale.map((m) =>
                      h(
                          'li',
                          null,
                          m.stale > 0
                              ? `${m.id}: ${m.stale} of ${m.trials} replies measured against an older prompt`
                              : `${m.id}: no prompt hash recorded (measured ${m.measuredTo}), so it may be stale`
                      )
                  )
              )
            : null,
        h(
            'p',
            { class: 'small muted' },
            `Sweeps on disk: ${E.sweeps.map((s) => `${s.name} (${s.date}, ${s.trials} replies${s.judges ? `, ${plural(s.judges, 'judge file')}` : ''})`).join('; ') || 'none'}. Regenerate with npm run evals:report.`
        )
    );
}

// --- Boot -----------------------------------------------------------------------------

function boot(): void {
    const app = document.getElementById('app');
    if (!app) return;
    app.replaceChildren(header(), findings(), byType(), matrix(), judging(), soak(), gaps());
    const sel = parseHash(location.hash);
    if (sel) select(sel, true);
    else detailEl.replaceChildren(h('p', { class: 'hint' }, 'Select a cell to read every run\'s reply, with the failed checks marked.'));
}

boot();
