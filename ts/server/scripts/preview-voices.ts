/**
 * Audition TTS voices and build a local comparison page.
 *
 * Synthesizes the same meditation sample through every requested source
 * (scripts/audition/sources.ts), MEASURES the resulting audio, and writes
 * voice-previews/index.html - a sortable, filterable, shortlist-able page with
 * one player per voice.
 *
 * Run it from ANYWHERE in the repo via the npm delegate - note the `--`, which
 * passes the rest through:
 *
 *   npm run voices                    # what we ship, as a session hears it (the default)
 *   npm run voices -- google          # ~130 Google voices, all English locales
 *   npm run voices -- openai gemini   # several sources at once
 *   npm run voices -- all             # every source with a key
 *   npm run voices -- google --locales=en-US,en-GB,en-AU
 *   npm run voices -- google --filter=Chirp3-HD --limit=12
 *   npm run voices -- inworld --only=Serena,Luna,Gareth   # exact voice ids
 *   npm run voices -- all --rate=0.85          # audition at session pace
 *   npm run voices -- google --prosody --limit=4   # every prosody treatment
 *                                                  # per voice, side by side
 *   npm run voices -- curated --treatments=plain,ssml-spacious
 *   npm run voices -- curated --only=Harper,Wren   # re-render two shipped voices
 *   npm run voices -- --rebuild       # rewrite the page from the clips on disk
 *                                     # (after a catalog edit), synthesizing nothing
 *
 * AS SHIPPED. A curated run renders each catalog voice through the server's own
 * synth dispatch (routes/tts.ts synthFor): its style, its pace bias, the lead
 * silence, at the default session speed. Those are the page's "as shipped"
 * rows, and "shipped, as shipped" in the page's filter (index.html#shipped)
 * shows them alone - the list to listen down when deciding what stays in the
 * catalog. A source's own treatments are NOT that: Harper ships in softvoice,
 * and her "plain text" row is a voice no session has ever heard.
 *
 * Sources with no key are skipped and listed on the page with a signup link, so
 * a partial run still produces a usable page. Output is gitignored; a full run
 * costs a few cents.
 *
 * PROSODY. Each source declares the prosody treatments it can express
 * (audition/sources.ts): SSML rate/pitch/breaks for Google, a natural-language
 * style instruction for OpenAI/Gemini/Inworld, a speed knob for Cartesia, and
 * nothing at all for Deepgram Aura-2. A default run uses whatever each source
 * ships today; `--prosody` renders every treatment so the variants sit adjacent
 * on the page. SSML bills its own tags, so a treatment can move the cost column
 * as well as the sound - which is the point of pricing per SPOKEN character.
 *
 * WHY IT MEASURES. Half these engines bill by audio DURATION, not characters,
 * and every "$/1M chars" figure they publish assumes conversational pace. aloud
 * speaks slowly, so a duration-priced engine costs materially more than its
 * sticker (Gemini 2.5 Flash TTS: ~$43/1M chars measured at our pace, against a
 * $30/1M Chirp3-HD we can actually beat on quality). The page's "$/1M chars"
 * column is therefore always pace-adjusted from the real clip, and is the only
 * cross-source comparison worth making. See audition/sources.ts.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig } from '../src/config.js';
import { CURATED_VOICES, resolveVoice, type CuratedVoice, type VoiceTier } from '../src/providers/voice-catalog.js';
import { billedCharsFor, synthFor } from '../src/routes/tts.js';
import { TTS_CHAR_PROFILES, TYPICAL_SESSION_MINUTES } from '../src/pricing/estimate.js';
import { usdToCredits } from '../src/pricing/meter.js';
import {
    SOURCES,
    curatedFor,
    keyFor,
    sourceById,
    sourceForCurated,
    type AuditionSource,
    type AuditionVoice,
    type SynthResult,
    type Treatment,
} from './audition/sources.js';

/** Long enough to hear pacing and breath, short enough to stay cheap. */
const SAMPLE =
    "Let's begin. Find a comfortable position, and when you're ready, gently " +
    'let your eyes close. Take a slow breath in... and let it go. ' +
    "There's nothing to get right here. Just noticing what's already present.";

const M = 1_000_000;
/** Chars/hr at the mid talk profile - the basis for the ☁/hr column. */
const CHARS_PER_HOUR = TTS_CHAR_PROFILES.typical * (60 / TYPICAL_SESSION_MINUTES);

/** The speed a session sends unless the meditator moves the slider: 140 wpm
 *  against the engines' neutral 160 (ui/src/app-settings.ts defaultTtsRate,
 *  adapters/cloud-tts.ts wpmToMultiplier). */
const SESSION_RATE = 140 / 160;

const AS_SHIPPED: Treatment = {
    id: 'shipped',
    label: 'as shipped',
    note:
        'what a session hears: the curated voice through the server\u2019s own synth path, ' +
        'with its style and pace, at the default speed',
};

const TIER_LABEL: Record<VoiceTier, string> = { premium: 'Best', value: 'Very Good' };

/** Everything about a curated voice that changes how it sounds. An "as
 *  shipped" clip carries the config it was rendered from, so one whose config
 *  has left the catalog can be dropped instead of passing for current. */
function shippedConfig(v: CuratedVoice): string {
    return [v.provider, v.providerVoiceId, v.style ?? '', v.paceBias ?? 1].join('|');
}

/** What an "as shipped" clip did, for the row. */
function shippedDetail(v: CuratedVoice, rate: number): string {
    // routes/tts.ts effectiveRate: a style pins the rate at 1.
    if (v.style) return `${v.style} style, which fixes the pace`;
    return [
        `speed ${rate}`,
        v.paceBias ? `pace \u00d7${v.paceBias}` : '',
        v.provider === 'inworld' ? 'style instruction' : '',
    ]
        .filter(Boolean)
        .join(' \u00b7 ');
}

interface Row {
    sourceId: string;
    sourceLabel: string;
    /** Display name (short where the provider gives one). */
    name: string;
    voiceId: string;
    note: string;
    file: string;
    /** Measured clip length in seconds. */
    seconds: number;
    /** Prosody treatment label, and what it does. */
    treatment: string;
    treatmentNote: string;
    /** What this one clip did, where the treatment varies by voice. */
    detail?: string;
    /** Speed this clip was synthesized at; a merged page can mix runs. */
    rate: number;
    /** On an "as shipped" clip: the shippedConfig it was rendered from. */
    shipped?: string;
    /** Pace-adjusted USD per 1M chars. */
    usdPerMillionChars: number;
    /** The source's unit rate when this clip was priced. A carried per-char row
     *  is re-priced from it when the rate table moves (see the merge below). */
    usdPerUnit?: number;
    creditsPerHour: number;
    billing: string;
}

/** What the page needs about a source, kept in the manifest so a merged page
 *  can still render chips and rate notes for a source this run didn't touch. */
interface SourceMeta {
    id: string;
    label: string;
    rateNote: string;
}

/** Accumulated audition state, saved beside index.html. Runs MERGE into this
 *  rather than replacing it: auditioning openai should not silently destroy the
 *  130-voice google page you already had open. `--fresh` starts over. */
interface Manifest {
    rows: Row[];
    sources: SourceMeta[];
}

interface Skipped {
    label: string;
    envKeys: readonly string[];
    signupUrl: string;
    reason: string;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** Clip length in seconds. ffprobe first, macOS afinfo as the fallback; 0 when
 *  neither is present, which makes the duration-priced columns read "-" rather
 *  than silently inventing a rate. */
function durationSeconds(path: string): number {
    try {
        const out = execFileSync(
            'ffprobe',
            ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
            { encoding: 'utf8' }
        );
        return Number.parseFloat(out.trim()) || 0;
    } catch {
        /* fall through */
    }
    try {
        const out = execFileSync('afinfo', [path], { encoding: 'utf8' });
        return Number.parseFloat(/estimated duration: ([\d.]+)/.exec(out)?.[1] ?? '') || 0;
    } catch {
        return 0;
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function esc(s: string): string {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function money(n: number): string {
    return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(1)}`;
}

/**
 * Legend for the prosody column. One entry per (source, treatment) actually
 * present, so the rows can carry the option NAME alone instead of repeating a
 * sentence of explanation on all of them.
 */
/** A row's source label, from the source as it is named today: the label a row
 *  was rendered under goes stale when a source is renamed. */
function sourceLabel(r: Row): string {
    return sourceById(r.sourceId)?.label ?? r.sourceLabel;
}

function prosodyKey(rows: Row[]): string {
    // Rank orders a source's entries: as shipped, then its default, then the rest.
    const bySource = new Map<string, { label: string; note: string; rank: number }[]>();
    for (const r of rows) {
        const list = bySource.get(sourceLabel(r)) ?? [];
        if (!list.some((e) => e.label === r.treatment)) {
            const isDefault = sourceById(r.sourceId)?.treatments[0]?.label === r.treatment;
            list.push({ label: r.treatment, note: r.treatmentNote, rank: r.shipped ? 0 : isDefault ? 1 : 2 });
        }
        bySource.set(sourceLabel(r), list);
    }
    for (const list of bySource.values()) list.sort((a, b) => a.rank - b.rank);
    // Nothing to explain when every source was auditioned in one treatment.
    if (![...bySource.values()].some((l) => l.length > 1)) return '';
    const blocks = [...bySource.entries()]
        .map(
            ([src, list]) =>
                `<div class="keysrc"><b>${esc(src)}</b><ul>${list
                    .map(
                        (e) =>
                            `<li><span class="kname">${esc(e.label)}</span>${
                                e.rank === 1 ? '<span class="flag cur">default</span>' : ''
                            } - ${esc(e.note)}</li>`
                    )
                    .join('')}</ul></div>`
        )
        .join('');
    return `<details class="key" open><summary>What the prosody options mean</summary>${blocks}</details>`;
}

function html(rows: Row[], skipped: Skipped[], sources: SourceMeta[]): string {
    const cheapest = rows.length ? Math.min(...rows.map((r) => r.usdPerMillionChars)) : 0;
    const rowHtml = rows
        .map((r, i) => {
            const curated = curatedFor(r.sourceId, r.voiceId);
            // An as-shipped row is the catalog entry itself, so it takes the
            // catalog's name and says which bucket the picker puts it in.
            const name = r.shipped && curated ? curated.name : r.name;
            const flags =
                r.shipped && curated
                    ? `<span class="flag tier">${TIER_LABEL[curated.tier]}</span>` +
                      (curated.default ? '<span class="flag def">default</span>' : '')
                    : curated
                      ? `<span class="flag cur">shipping as ${esc(curated.name)}</span>`
                      : '';
            return `<tr data-i="${i}" data-src="${esc(r.sourceId)}" data-cost="${r.usdPerMillionChars.toFixed(3)}"
   data-name="${esc((name + ' ' + r.note + ' ' + r.voiceId + ' ' + r.treatment).toLowerCase())}"
   data-shipping="${curated ? 1 : 0}" data-shipped="${r.shipped ? 1 : 0}" data-voice="${esc(r.sourceId + ':' + r.voiceId)}">
 <td class="star"><button class="starbtn" data-vid="${esc(r.sourceId)}:${esc(r.voiceId)}" title="shortlist">☆</button></td>
 <td class="play"><button class="playbtn" data-file="${esc(r.file)}">▶</button></td>
 <td class="who"><span class="nm">${esc(name)}</span>${flags}<div class="sub">${esc(r.note)}</div></td>
 <td class="src">${esc(sourceLabel(r))}<div class="sub">${esc(r.voiceId)}</div></td>
 <td class="tr8">${esc(r.treatment)}${r.detail ? `<div class="sub">${esc(r.detail)}</div>` : ''}</td>
 <td class="num">${r.seconds ? r.seconds.toFixed(1) + 's' : '-'}</td>
 <td class="num cost${r.usdPerMillionChars <= cheapest * 1.05 ? ' best' : ''}">${money(r.usdPerMillionChars)}<div class="sub">${esc(r.billing)}</div></td>
 <td class="num">${r.creditsPerHour.toFixed(1)}☁</td>
</tr>`;
        })
        .join('\n');

    const srcChips = sources
        .map((s) => `<button class="chip on" data-src="${esc(s.id)}">${esc(s.label)}</button>`)
        .join('');

    const rateNotes = sources
        .map((s) => `<li><b>${esc(s.label)}</b> - ${esc(s.rateNote)}</li>`)
        .join('');

    const rendered = new Set(rows.map((r) => r.shipped));
    const unrendered = CURATED_VOICES.filter((v) => !rendered.has(shippedConfig(v))).map((v) => v.name);
    const unrenderedHtml = unrendered.length
        ? `<div class="skipped"><b>No as-shipped clip</b> for ${esc(unrendered.join(', '))}, so the shipped view is missing ${
              unrendered.length === 1 ? 'it' : 'them'
          }. Render with <code>npm run voices</code>.</div>`
        : '';

    const skippedHtml = skipped.length
        ? `<div class="skipped"><b>Not auditioned</b> - no key set:<ul>${skipped
              .map(
                  (s) =>
                      `<li>${esc(s.label)} - set <code>${esc(s.envKeys[0] ?? '')}</code> in <code>ts/server/.env</code> (<a href="${esc(
                          s.signupUrl
                      )}">get a key</a>)${s.reason ? ` <span class="sub">${esc(s.reason)}</span>` : ''}</li>`
              )
              .join('')}</ul></div>`
        : '';

    return `<!doctype html><meta charset="utf-8"><title>aloud voice audition</title>
<style>
 :root{--fg:#1c1c1e;--mut:#6b6b70;--line:#e6e6e9;--bg:#fff;--accent:#2f6f5e;--best:#0a7a52}
 body{font:15px/1.55 system-ui,-apple-system,sans-serif;max-width:1080px;margin:2rem auto;padding:0 1.2rem;color:var(--fg);background:var(--bg)}
 h1{font-size:1.3rem;margin:0 0 .2rem}
 .sample{color:var(--mut);font-style:italic;margin:.4rem 0 1rem;max-width:60ch}
 .bar{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin:1rem 0;padding:.7rem 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
 .chip{border:1px solid var(--line);background:#f6f6f7;color:var(--mut);border-radius:999px;padding:.25rem .7rem;font:inherit;font-size:.85em;cursor:pointer}
 .chip.on{background:var(--accent);border-color:var(--accent);color:#fff}
 input[type=search]{border:1px solid var(--line);border-radius:6px;padding:.3rem .6rem;font:inherit;min-width:14rem}
 label.tog{font-size:.85em;color:var(--mut);display:flex;gap:.3rem;align-items:center}
 table{width:100%;border-collapse:collapse}
 th{text-align:left;font-size:.78em;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);padding:.4rem .5rem;border-bottom:1px solid var(--line);cursor:pointer;user-select:none}
 th.num,td.num{text-align:right}
 td{padding:.45rem .5rem;border-bottom:1px solid var(--line);vertical-align:top}
 .sub{color:var(--mut);font-size:.78em;margin-top:.1rem}
 .nm{font-weight:600}
 .flag{display:inline-block;margin-left:.4rem;font-size:.7em;padding:.05rem .4rem;border-radius:999px;vertical-align:middle}
 .flag.def{background:var(--accent);color:#fff}
 .flag.cur{background:#eef1f0;color:var(--accent)}
 .flag.tier{background:#f3eefa;color:#5b4a86}
 select{border:1px solid var(--line);border-radius:6px;padding:.3rem .4rem;font:inherit;font-size:.85em;background:#fff;color:var(--fg)}
 td.tr8{max-width:11rem}
 .key{background:#fbfbfc;border:1px solid var(--line);border-radius:8px;padding:.6rem 1rem;margin:0 0 1rem;font-size:.86em}
 .key summary{cursor:pointer;font-weight:600}
 .keysrc{margin-top:.5rem} .keysrc ul{margin:.2rem 0 0;padding-left:1.2rem}
 .keysrc li{color:var(--mut)} .kname{color:var(--fg);font-weight:600}
 tr.samevoice td.who,tr.samevoice td.src{visibility:hidden}
 .cost.best{color:var(--best);font-weight:600}
 button.playbtn,button.starbtn{border:1px solid var(--line);background:#fafafa;border-radius:6px;width:2rem;height:1.9rem;cursor:pointer;font-size:.9em;color:var(--fg)}
 button.playbtn.on{background:var(--accent);border-color:var(--accent);color:#fff}
 button.starbtn.on{color:#c58b12;border-color:#e3c98a;background:#fdf7e8}
 tr.playing{background:#f3f8f6}
 .skipped{background:#fbfbfc;border:1px solid var(--line);border-radius:8px;padding:.7rem 1rem;margin:1rem 0;font-size:.88em}
 .skipped ul,.notes ul{margin:.4rem 0 0;padding-left:1.2rem}
 .notes{margin-top:2rem;font-size:.85em;color:var(--mut);border-top:1px solid var(--line);padding-top:1rem}
 .out{width:100%;min-height:7rem;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:.5rem;border:1px solid var(--line);border-radius:6px;padding:.5rem;display:none}
 kbd{background:#f2f2f4;border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:0 .3rem;font-size:.85em}
</style>
<h1>aloud voice audition</h1>
<div class="sub">${rows.length} clips across ${sources.length} source${sources.length === 1 ? '' : 's'} · speed ${[
        ...new Set(rows.map((r) => r.rate)),
    ]
        .sort()
        .join(', ')} · <kbd>e</kbd> play/pause · <kbd>w</kbd>/<kbd>s</kbd> prev/next · <kbd>f</kbd> shortlist</div>
<p class="sample">“${esc(SAMPLE)}”</p>
${skippedHtml}${unrenderedHtml}
<div class="bar">
 ${srcChips}
 <input type="search" id="q" placeholder="filter by name, id, character…">
 <select id="shipview" title="which voices to show">
  <option value="">all voices</option>
  <option value="shipped">shipped, as shipped</option>
  <option value="new">not shipped yet</option>
 </select>
 <label class="tog"><input type="checkbox" id="onlystar"> shortlisted only</label>
 <label class="tog"><input type="checkbox" id="groupvoice" checked> group prosody variants</label>
 <button class="chip" id="copy">copy shortlist</button>
</div>
${prosodyKey(rows)}
<table>
<thead><tr>
 <th></th><th></th>
 <th data-sort="name">Voice</th>
 <th data-sort="src">Source</th>
 <th data-sort="treatment">Prosody</th>
 <th class="num" data-sort="secs">Clip</th>
 <th class="num" data-sort="cost">$/1M chars</th>
 <th class="num" data-sort="cost">☁/hr</th>
</tr></thead>
<tbody id="rows">
${rowHtml}
</tbody>
</table>
<textarea class="out" id="out" readonly></textarea>
<div class="notes">
 <p><b>$/1M chars is pace-adjusted</b>, measured from each clip's real duration at our own meditation instruction - not the provider's headline rate. Duration-priced engines get more expensive the slower they speak, which is exactly the register aloud uses. ☁/hr assumes the mid talk profile (${Math.round(CHARS_PER_HOUR)} chars/hr, pricing/estimate.ts).</p>
 <p><b>As shipped</b> rows are the catalog voices through the server's own synth path (their style, pace bias and lead silence) at the default session speed, ${SESSION_RATE}: what a meditator hears. Every other row is a source treatment, which for a styled or pace-biased voice is not what ships.</p>
 <p><b>Prosody</b> is expressed differently per engine, and the gap is wide. Google honors SSML
 <code>&lt;prosody&gt;</code> + <code>&lt;break&gt;</code> on <em>both</em> tiers, Chirp3-HD included - the strongest
 pacing lever we have, and it is on the engine we already ship - but Google bills the tags, so a marked-up
 line costs more per spoken word (that tax is already in the $/1M column). Azure honors the same SSML levers
 (and also bills the tags, minus the speak/voice wrapper). OpenAI, Gemini and Inworld take a
 natural-language style instruction only. Deepgram Aura-2 exposes no prosody control at all.</p>
 <p>Rate sources:</p><ul>${rateNotes}</ul>
</div>
<script>
const rows=[...document.querySelectorAll('#rows tr')];
const audio=new Audio(); let cur=null;
const KEY='aloud-voice-shortlist';
const stars=new Set(JSON.parse(localStorage.getItem(KEY)||'[]'));
document.querySelectorAll('.starbtn').forEach(b=>{
  if(stars.has(b.dataset.vid))b.classList.add('on'),b.textContent='★';
  b.onclick=e=>{e.stopPropagation();toggleStar(b)};
});
function toggleStar(b){
  const v=b.dataset.vid;
  if(stars.has(v)){stars.delete(v);b.classList.remove('on');b.textContent='☆';}
  else{stars.add(v);b.classList.add('on');b.textContent='★';}
  localStorage.setItem(KEY,JSON.stringify([...stars]));apply();
}
function play(tr){
  const btn=tr.querySelector('.playbtn');
  if(cur===tr&&!audio.paused){audio.pause();btn.textContent='▶';return;}
  if(cur===tr&&audio.src){btn.classList.add('on');btn.textContent='⏸';audio.play().catch(()=>{});return;}
  document.querySelectorAll('.playbtn.on').forEach(b=>{b.classList.remove('on');b.textContent='▶'});
  document.querySelectorAll('tr.playing').forEach(t=>t.classList.remove('playing'));
  cur=tr;tr.classList.add('playing');btn.classList.add('on');btn.textContent='⏸';
  audio.src=btn.dataset.file;audio.play().catch(()=>{});
  tr.scrollIntoView({block:'nearest'});
}
audio.onended=()=>{document.querySelectorAll('.playbtn.on').forEach(b=>{b.classList.remove('on');b.textContent='▶'});};
rows.forEach(tr=>{tr.querySelector('.playbtn').onclick=()=>play(tr)});
function visible(){return [...document.getElementById('rows').children].filter(r=>r.style.display!=='none')}
function step(d){
  const v=visible();if(!v.length)return;
  const i=cur?v.indexOf(cur):-1;
  play(v[Math.max(0,Math.min(v.length-1,i+d))]||v[0]);
}
addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA')return;
  if(e.metaKey||e.ctrlKey||e.altKey)return;
  const k=e.key.toLowerCase();
  if(k==='e'){e.preventDefault();cur?play(cur):step(1);}
  else if(k==='s')step(1); else if(k==='w')step(-1);
  else if(k==='f'&&cur)toggleStar(cur.querySelector('.starbtn'));
});
const off=new Set();
document.querySelectorAll('.chip[data-src]').forEach(c=>{c.onclick=()=>{
  c.classList.toggle('on');off.has(c.dataset.src)?off.delete(c.dataset.src):off.add(c.dataset.src);apply();
}});
// With variants on, a voice's treatments should read as one block: sort them
// adjacent and blank the repeated name/source cells so the eye compares prosody,
// not names.
function regroup(){
  const on=document.getElementById('groupvoice').checked;
  const tb=document.getElementById('rows');
  document.querySelectorAll('tr.samevoice').forEach(r=>r.classList.remove('samevoice'));
  if(!on)return;
  const seen=new Map();
  // Visible rows only, or a filtered-out sibling takes the name cell with it.
  [...tb.children].forEach(r=>{
    if(r.style.display==='none')return;
    const v=r.dataset.voice;
    if(!seen.has(v))seen.set(v,[]);
    seen.get(v).push(r);
  });
  seen.forEach(group=>{
    if(group.length<2)return;
    group[0].after(...group.slice(1));
    group.slice(1).forEach(r=>r.classList.add('samevoice'));
  });
}
function apply(){
  const q=document.getElementById('q').value.trim().toLowerCase();
  const onlyStar=document.getElementById('onlystar').checked;
  const view=shipview.value;
  rows.forEach(r=>{
    const starred=stars.has(r.querySelector('.starbtn').dataset.vid);
    const ok=!off.has(r.dataset.src)&&(!q||r.dataset.name.includes(q))
      &&(!onlyStar||starred)
      &&(view!=='shipped'||r.dataset.shipped==='1')&&(view!=='new'||r.dataset.shipping==='0');
    r.style.display=ok?'':'none';
  });
  regroup();
}
// The view rides in the hash, so index.html#shipped opens on the shipped list
// and a reload keeps it.
const shipview=document.getElementById('shipview');
if([...shipview.options].some(o=>o.value===location.hash.slice(1)))shipview.value=location.hash.slice(1);
// The shipped list is short; the prosody legend would push it off the screen.
const key=document.querySelector('.key');
function syncKey(){if(key)key.open=shipview.value!=='shipped';}
syncKey();
shipview.addEventListener('change',()=>{history.replaceState(null,'','#'+shipview.value);syncKey();});
['q','onlystar','shipview','groupvoice'].forEach(id=>{
  const el=document.getElementById(id);el.addEventListener(el.type==='search'?'input':'change',apply);
});
let asc={};
document.querySelectorAll('th[data-sort]').forEach(th=>{th.onclick=()=>{
  const k=th.dataset.sort;asc[k]=!asc[k];const dir=asc[k]?1:-1;const tb=document.getElementById('rows');
  const val=r=>k==='cost'?parseFloat(r.dataset.cost)
    :k==='secs'?parseFloat(r.children[5].textContent)||0
    :k==='treatment'?r.children[4].textContent.trim().toLowerCase()
    :k==='src'?r.dataset.src:r.querySelector('.nm').textContent.toLowerCase();
  [...tb.children].sort((a,b)=>val(a)>val(b)?dir:val(a)<val(b)?-dir:0).forEach(r=>tb.appendChild(r));
  regroup();
}});
document.getElementById('copy').onclick=()=>{
  const out=document.getElementById('out');
  const seen=new Set();
  const picked=rows.filter(r=>stars.has(r.dataset.voice)&&!seen.has(r.dataset.voice)&&(seen.add(r.dataset.voice),true));
  out.style.display='block';
  out.value=picked.length
    ? picked.map(r=>{
        const [src,...idp]=r.querySelector('.starbtn').dataset.vid.split(':');
        const n=r.dataset.name;
        const g=n.includes('androgynous')?'androgynous':n.includes('female')?'female':n.includes('male')?'male':'?';
        // Stars are per-voice, not per-treatment, so naming one treatment here
        // would be a guess - the cost quoted is the first listed row's.
        return "{ name: '"+r.querySelector('.nm').textContent.trim()+"', provider: '"+src
          +"', providerVoiceId: '"+idp.join(':')+"', gender: '"+g+"', tier: '?' },"
          +"  // $"+r.dataset.cost+"/1M chars";
      }).join('\\n')
    : 'Nothing shortlisted yet - press ☆ (or f) on the voices you like.';
  out.select();
  if(picked.length&&navigator.clipboard){
    navigator.clipboard.writeText(out.value).then(()=>{
      const b=document.getElementById('copy');b.textContent='copied ✓';
      setTimeout(()=>{b.textContent='copy shortlist'},1500);
    }).catch(()=>{});
  }
};
apply();
</script>
`;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/** Curated mode is a different shape from a roster: it walks CURATED_VOICES so
 *  the page shows exactly what ships, each under the source that speaks it. */
function curatedTargets(): { source: AuditionSource; voice: AuditionVoice; curated: CuratedVoice }[] {
    const out = [];
    for (const cv of CURATED_VOICES) {
        const hit = sourceForCurated(cv);
        if (!hit) continue;
        out.push({ source: hit.source, voice: { id: hit.voiceId, label: cv.name, note: cv.gender }, curated: cv });
    }
    return out;
}

/** One curated voice exactly as POST /cloud/v1/tts would speak it. */
async function synthAsShipped(v: CuratedVoice, rate: number): Promise<SynthResult> {
    const resolved = resolveVoice(v.name);
    const synth = synthFor(loadConfig(), resolved);
    if (!synth) throw new Error(`no ${v.provider} key`);
    return { bytes: await synth(SAMPLE, rate), ext: 'mp3', billedChars: billedCharsFor(resolved, SAMPLE, rate) };
}

async function main(): Promise<void> {
    try {
        process.loadEnvFile();
    } catch {
        /* rely on ambient env */
    }

    const args = process.argv.slice(2);
    const flag = (name: string): string | undefined =>
        args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
    const names = args.filter((a) => !a.startsWith('--')).map((a) => a.toLowerCase());
    const rate = Number(flag('rate') ?? 1);
    const shippedRate = Number(flag('rate') ?? SESSION_RATE);
    const limit = Number(flag('limit') ?? Infinity);
    const filter = flag('filter');
    const locales = (flag('locales') ?? 'en-US').split(',').map((s) => s.trim()).filter(Boolean);
    const rosterOpts = { locales, ...(filter === undefined ? {} : { filter }) };

    // Prosody axis. Default: one clip per voice, in the source's default
    // treatment, so a plain run is the roster comparison. `--prosody` renders
    // every treatment a source can express, which is the "how much pacing can I
    // actually buy here" listen; `--treatments=` narrows that. A curated run
    // renders the as-shipped clip instead, plus these only when asked.
    const only = flag('only')?.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
    const wantAllTreatments = args.includes('--prosody');
    const treatmentIds = flag('treatments')?.split(',').map((t) => t.trim()).filter(Boolean);
    const treatmentsFor = (source: AuditionSource): readonly Treatment[] => {
        if (treatmentIds?.length) {
            const picked = source.treatments.filter((t) => treatmentIds.includes(t.id));
            // A source that can't express a requested treatment still gets
            // auditioned in its default one, rather than vanishing from the page.
            return picked.length ? picked : source.treatments.slice(0, 1);
        }
        return wantAllTreatments ? source.treatments : source.treatments.slice(0, 1);
    };

    const rebuildOnly = args.includes('--rebuild');
    const mode = names.length === 0 ? ['curated'] : names;
    const wanted =
        mode.includes('all') ? SOURCES.map((s) => s.id)
        : mode.includes('curated') ? ['curated']
        : mode;
    // `curated azure` audits only the shipping voices from that source - the
    // per-source deep listen without re-billing the whole curated set.
    const curatedSources = mode.includes('curated') ? mode.filter((m) => m !== 'curated') : [];

    for (const w of [...wanted, ...curatedSources]) {
        if (w !== 'curated' && !sourceById(w)) {
            console.error(`Unknown source "${w}". Known: ${SOURCES.map((s) => s.id).join(', ')}, curated, all.`);
            process.exit(1);
        }
    }

    const outDir = resolve(import.meta.dirname, '..', 'voice-previews');
    const manifestPath = resolve(outDir, 'rows.json');
    if (args.includes('--fresh')) rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    // Merge into whatever is already there. Auditioning one source must not
    // destroy a page built from another - that is a slow, expensive rebuild and
    // it happens exactly when someone is mid-listen.
    let prior: Manifest = { rows: [], sources: [] };
    if (existsSync(manifestPath)) {
        try {
            prior = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
        } catch {
            /* unreadable manifest: start clean rather than die */
        }
    }
    // An as-shipped clip of a voice that has since left the catalog, or changed
    // its style or pace there, is no longer what ships.
    const shipping = new Set(CURATED_VOICES.map(shippedConfig));
    prior.rows = prior.rows.filter((r) => !r.shipped || shipping.has(r.shipped));
    // A carried row holds the price of the day it was rendered. Per-char rows
    // follow the rate table instead, or a corrected rate never reaches a page
    // built from earlier runs (the MAI voices sat at the Neural rate that way).
    for (const r of prior.rows) {
        const src = sourceById(r.sourceId);
        if (!src || src.billing !== 'per-char' || !r.usdPerUnit) continue;
        const scale = src.usdPerUnit(r.voiceId) / r.usdPerUnit;
        r.usdPerMillionChars *= scale;
        r.creditsPerHour *= scale;
        r.usdPerUnit *= scale;
    }

    const rows: Row[] = [];
    const skipped: Skipped[] = [];
    const used: AuditionSource[] = [];

    // Build the work list: either the shipping set, or each source's roster.
    type Target = {
        source: AuditionSource;
        voice: AuditionVoice;
        key: string;
        treatment: Treatment;
        /** Set on the as-shipped clip of a curated voice. */
        shipped?: CuratedVoice;
    };
    const targets: Target[] = [];

    if (rebuildOnly) {
        // The catalog is re-read below; the clips on disk stand as they are.
    } else if (wanted[0] === 'curated') {
        for (const t of curatedTargets()) {
            if (curatedSources.length && !curatedSources.includes(t.source.id)) continue;
            if (only && !only.includes(t.curated.name.toLowerCase()) && !only.includes(t.voice.id.toLowerCase()))
                continue;
            const key = keyFor(t.source);
            if (!key) {
                if (!skipped.some((s) => s.label === t.source.label))
                    skipped.push({ ...t.source, reason: 'curated voices from this source were skipped' });
                continue;
            }
            targets.push({ source: t.source, voice: t.voice, key, treatment: AS_SHIPPED, shipped: t.curated });
            if (wantAllTreatments || treatmentIds?.length)
                for (const treatment of treatmentsFor(t.source))
                    targets.push({ source: t.source, voice: t.voice, key, treatment });
        }
    } else {
        for (const id of wanted) {
            const source = sourceById(id)!;
            const key = keyFor(source);
            if (!key) {
                skipped.push({ ...source, reason: '' });
                continue;
            }
            let roster: AuditionVoice[];
            try {
                roster = await source.roster(key, rosterOpts);
            } catch (err) {
                skipped.push({ ...source, reason: `roster failed - ${String(err)}` });
                continue;
            }
            if (only) roster = roster.filter((v) => only.includes(v.id.toLowerCase()));
            for (const voice of roster.slice(0, limit))
                for (const treatment of treatmentsFor(source))
                    targets.push({ source, voice, key, treatment });
        }
    }

    if (targets.length === 0 && !rebuildOnly) {
        console.error('Nothing to audition. Set at least one provider key in ts/server/.env:');
        for (const s of SOURCES) console.error(`  ${s.envKeys[0]} — ${s.label} (${s.signupUrl})`);
        process.exit(1);
    }

    if (!rebuildOnly) console.log(`Auditioning ${targets.length} clips → ${outDir}\n`);

    for (const { source, voice, key, treatment, shipped } of targets) {
        const name = voice.label ?? voice.id;
        const clipRate = shipped ? shippedRate : rate;
        try {
            const result = shipped
                ? await synthAsShipped(shipped, clipRate)
                : await source.synth(SAMPLE, voice.id, clipRate, key, treatment);
            const file = `${source.id}-${voice.id.replace(/[^\w.-]/g, '_')}-${treatment.id}.${result.ext}`;
            const path = resolve(outDir, file);
            writeFileSync(path, result.bytes);
            const seconds = durationSeconds(path);

            // One comparable number across billing models: what this clip cost,
            // divided by its characters. A per-second source only lands here
            // honestly because we measured the audio.
            // A treatment can change BOTH legs: SSML bills its tags (billedChars),
            // and a slower delivery bills more seconds. Normalising by the plain
            // sample length keeps every row comparable in $/1M SPOKEN chars,
            // which is what a session actually costs.
            const usd =
                result.usdActual ??
                (source.billing === 'per-char'
                    ? (result.billedChars ?? SAMPLE.length) * source.usdPerUnit(voice.id)
                    : seconds * source.usdPerUnit(voice.id));
            const usdPerMillionChars = (usd / SAMPLE.length) * M;
            const curated = curatedFor(source.id, voice.id);

            if (!used.includes(source)) used.push(source);
            rows.push({
                sourceId: source.id,
                sourceLabel: source.label,
                name,
                voiceId: voice.id,
                note: voice.note ?? '',
                file,
                seconds,
                treatment: treatment.label,
                treatmentNote: treatment.note,
                ...(shipped ? { detail: shippedDetail(shipped, clipRate), shipped: shippedConfig(shipped) } : {}),
                rate: clipRate,
                usdPerMillionChars,
                ...(source.billing === 'per-char' && result.usdActual === undefined
                    ? { usdPerUnit: source.usdPerUnit(voice.id) }
                    : {}),
                creditsPerHour: usdToCredits((usdPerMillionChars / M) * CHARS_PER_HOUR),
                billing: source.billing === 'per-char' ? 'per char' : 'per second',
            });
            console.log(
                `  ✓ ${name.padEnd(24)} ${source.id.padEnd(9)} ${treatment.id.padEnd(20)} ` +
                    `${seconds.toFixed(1).padStart(5)}s ${money(usdPerMillionChars).padStart(6)}/1M` +
                    `${curated && !shipped ? `  (ships as ${curated.name})` : ''}`
            );
        } catch (err) {
            console.log(`  ✗ ${name.padEnd(24)} ${source.id.padEnd(9)} ${treatment.id.padEnd(20)} ${String(err).slice(0, 110)}`);
        }
    }

    // Rows this run re-auditioned supersede their prior versions; everything
    // else in the manifest survives.
    const fresh = new Set(rows.map((r) => `${r.sourceId}|${r.voiceId}|${r.treatment}`));
    const merged = [
        ...prior.rows.filter((r) => !fresh.has(`${r.sourceId}|${r.voiceId}|${r.treatment}`)),
        ...rows,
    ];
    merged.sort((a, b) => a.usdPerMillionChars - b.usdPerMillionChars || a.name.localeCompare(b.name));

    const sourceMeta = new Map(prior.sources.map((m) => [m.id, m]));
    for (const src of SOURCES)
        if (used.includes(src) || sourceMeta.has(src.id))
            sourceMeta.set(src.id, { id: src.id, label: src.label, rateNote: src.rateNote });
    // Drop meta for sources no longer represented, so the chips can't outlive
    // their rows.
    const present = new Set(merged.map((r) => r.sourceId));
    const sources = [...sourceMeta.values()].filter((m) => present.has(m.id));

    writeFileSync(manifestPath, JSON.stringify({ rows: merged, sources } satisfies Manifest));
    writeFileSync(resolve(outDir, 'index.html'), html(merged, skipped, sources));

    const carried = merged.length - rows.length;
    if (carried > 0 && !rebuildOnly) console.log(`\n  (+ ${carried} clips carried over from earlier runs; --fresh to start over)`);

    if (wanted[0] === 'curated' && !rebuildOnly) {
        console.log(
            '\nThat was the CURATED set - the voices we ship, as a session hears them. To hear new ones:\n' +
                '  npm run voices -- google --locales=en-US,en-GB,en-AU   # ~130 Google voices\n' +
                '  npm run voices -- openai                               # the full OpenAI roster\n' +
                '  npm run voices -- all                                  # every source with a key'
        );
    }

    if (skipped.length) {
        console.log('\nSkipped (no key):');
        for (const s of skipped) console.log(`  ${s.label} — set ${s.envKeys[0]} (${s.signupUrl})`);
    }
    console.log(`\nOpen: ${resolve(outDir, 'index.html')}${wanted[0] === 'curated' ? '#shipped' : ''}`);
}

void main();
