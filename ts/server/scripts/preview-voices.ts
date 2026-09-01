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
 *   npm run voices -- curated         # only what we already ship (the default)
 *   npm run voices -- google          # ~130 Google voices, all English locales
 *   npm run voices -- openai gemini   # several sources at once
 *   npm run voices -- all             # every source with a key
 *   npm run voices -- google --locales=en-US,en-GB,en-AU
 *   npm run voices -- google --filter=Chirp3-HD --limit=12
 *   npm run voices -- all --rate=0.85          # audition at session pace
 *   npm run voices -- google --prosody --limit=4   # every prosody treatment
 *                                                  # per voice, side by side
 *   npm run voices -- curated --treatments=plain,ssml-spacious
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

import { CURATED_VOICES } from '../src/providers/voice-catalog.js';
import { TTS_CHAR_PROFILES, TYPICAL_SESSION_MINUTES } from '../src/pricing/estimate.js';
import { usdToCredits } from '../src/pricing/meter.js';
import {
    SOURCES,
    keyFor,
    sourceById,
    type AuditionSource,
    type AuditionVoice,
    type Treatment,
} from './audition/sources.js';

/** Long enough to hear pacing and breath, short enough to stay cheap. */
const SAMPLE =
    "Let's begin. Find a comfortable position, and when you're ready, gently " +
    'let your eyes close. Take a slow breath in... and let it go. ' +
    "There's nothing to get right here. Just noticing what's already present.";

const M = 1_000_000;
/** Chars/hr at the mid talk profile - the basis for the ☁️/hr column. */
const CHARS_PER_HOUR = TTS_CHAR_PROFILES.typical * (60 / TYPICAL_SESSION_MINUTES);

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
    /** Speed this clip was synthesized at; a merged page can mix runs. */
    rate: number;
    /** True when this is the source's shipping treatment. */
    shippingTreatment: boolean;
    /** Pace-adjusted USD per 1M chars. */
    usdPerMillionChars: number;
    creditsPerHour: number;
    billing: string;
    /** Set when this voice is already in CURATED_VOICES. */
    curatedAs?: string;
    isDefault?: boolean;
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
function prosodyKey(rows: Row[]): string {
    const bySource = new Map<string, { label: string; note: string; ships: boolean }[]>();
    for (const r of rows) {
        const list = bySource.get(r.sourceLabel) ?? [];
        if (!list.some((e) => e.label === r.treatment))
            list.push({ label: r.treatment, note: r.treatmentNote, ships: r.shippingTreatment });
        bySource.set(r.sourceLabel, list);
    }
    for (const list of bySource.values()) list.sort((a, b) => Number(b.ships) - Number(a.ships));
    // Nothing to explain when every source was auditioned in one treatment.
    if (![...bySource.values()].some((l) => l.length > 1)) return '';
    const blocks = [...bySource.entries()]
        .map(
            ([src, list]) =>
                `<div class="keysrc"><b>${esc(src)}</b><ul>${list
                    .map(
                        (e) =>
                            `<li><span class="kname">${esc(e.label)}</span>${
                                e.ships ? '<span class="flag cur">what we ship today</span>' : ''
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
            const flags = [
                r.isDefault ? '<span class="flag def">current default</span>' : '',
                r.curatedAs && !r.isDefault ? `<span class="flag cur">shipping as ${esc(r.curatedAs)}</span>` : '',
            ].join('');
            return `<tr data-i="${i}" data-src="${esc(r.sourceId)}" data-cost="${r.usdPerMillionChars.toFixed(3)}"
   data-name="${esc((r.name + ' ' + r.note + ' ' + r.voiceId + ' ' + r.treatment).toLowerCase())}"
   data-shipping="${r.curatedAs ? 1 : 0}" data-voice="${esc(r.sourceId + ':' + r.voiceId)}">
 <td class="star"><button class="starbtn" data-vid="${esc(r.sourceId)}:${esc(r.voiceId)}" title="shortlist">☆</button></td>
 <td class="play"><button class="playbtn" data-file="${esc(r.file)}">▶</button></td>
 <td class="who"><span class="nm">${esc(r.name)}</span>${flags}<div class="sub">${esc(r.note)}</div></td>
 <td class="src">${esc(r.sourceLabel)}<div class="sub">${esc(r.voiceId)}</div></td>
 <td class="tr8">${esc(r.treatment)}</td>
 <td class="num">${r.seconds ? r.seconds.toFixed(1) + 's' : '-'}</td>
 <td class="num cost${r.usdPerMillionChars <= cheapest * 1.05 ? ' best' : ''}">${money(r.usdPerMillionChars)}<div class="sub">${esc(r.billing)}</div></td>
 <td class="num">${r.creditsPerHour.toFixed(1)}☁️</td>
</tr>`;
        })
        .join('\n');

    const srcChips = sources
        .map((s) => `<button class="chip on" data-src="${esc(s.id)}">${esc(s.label)}</button>`)
        .join('');

    const rateNotes = sources
        .map((s) => `<li><b>${esc(s.label)}</b> - ${esc(s.rateNote)}</li>`)
        .join('');

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
 .flag.var{background:#f3eefa;color:#5b4a86;margin-left:.35rem}
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
<div class="sub">${rows.length} voices across ${sources.length} source${sources.length === 1 ? '' : 's'} · speed ${[
        ...new Set(rows.map((r) => r.rate)),
    ]
        .sort()
        .join(', ')} · <kbd>e</kbd> play/pause · <kbd>w</kbd>/<kbd>s</kbd> prev/next · <kbd>f</kbd> shortlist</div>
<p class="sample">“${esc(SAMPLE)}”</p>
${skippedHtml}
<div class="bar">
 ${srcChips}
 <input type="search" id="q" placeholder="filter by name, id, character…">
 <label class="tog"><input type="checkbox" id="onlystar"> shortlisted only</label>
 <label class="tog"><input type="checkbox" id="hideship"> hide what we already ship</label>
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
 <th class="num" data-sort="cost">☁️/hr</th>
</tr></thead>
<tbody id="rows">
${rowHtml}
</tbody>
</table>
<textarea class="out" id="out" readonly></textarea>
<div class="notes">
 <p><b>$/1M chars is pace-adjusted</b>, measured from each clip's real duration at our own meditation instruction - not the provider's headline rate. Duration-priced engines get more expensive the slower they speak, which is exactly the register aloud uses. ☁️/hr assumes the mid talk profile (${Math.round(CHARS_PER_HOUR)} chars/hr, pricing/estimate.ts).</p>
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
  [...tb.children].forEach(r=>{
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
  const hideShip=document.getElementById('hideship').checked;
  rows.forEach(r=>{
    const starred=stars.has(r.querySelector('.starbtn').dataset.vid);
    const ok=!off.has(r.dataset.src)&&(!q||r.dataset.name.includes(q))
      &&(!onlyStar||starred)&&(!hideShip||r.dataset.shipping==='0');
    r.style.display=ok?'':'none';
  });
  regroup();
}
['q','onlystar','hideship','groupvoice'].forEach(id=>{
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
 *  the page shows exactly what ships, in ship order, with the default flagged. */
function curatedTargets(): { source: AuditionSource; voice: AuditionVoice; curated: (typeof CURATED_VOICES)[number] }[] {
    const out = [];
    for (const cv of CURATED_VOICES) {
        const source = sourceById(cv.provider);
        if (!source) continue;
        out.push({ source, voice: { id: cv.providerVoiceId, label: cv.name, note: cv.gender }, curated: cv });
    }
    return out;
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
    const limit = Number(flag('limit') ?? Infinity);
    const filter = flag('filter');
    const locales = (flag('locales') ?? 'en-US').split(',').map((s) => s.trim()).filter(Boolean);
    const rosterOpts = { locales, ...(filter === undefined ? {} : { filter }) };

    // Prosody axis. Default: one clip per voice, in the treatment that source
    // ships today, so a plain run is the roster comparison. `--prosody` renders
    // every treatment a source can express, which is the "how much pacing can I
    // actually buy here" listen; `--treatments=` narrows that.
    const wantAllTreatments = args.includes('--prosody');
    const treatmentIds = flag('treatments')?.split(',').map((t) => t.trim()).filter(Boolean);
    const treatmentsFor = (source: AuditionSource): readonly Treatment[] => {
        if (treatmentIds?.length) {
            const picked = source.treatments.filter((t) => treatmentIds.includes(t.id));
            // A source that can't express a requested treatment still gets
            // auditioned in its shipping one, rather than vanishing from the page.
            return picked.length ? picked : source.treatments.slice(0, 1);
        }
        return wantAllTreatments ? source.treatments : source.treatments.slice(0, 1);
    };

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

    const rows: Row[] = [];
    const skipped: Skipped[] = [];
    const used: AuditionSource[] = [];
    const curatedIndex = new Map(CURATED_VOICES.map((v) => [`${v.provider}:${v.providerVoiceId}`, v]));

    // Build the work list: either the shipping set, or each source's roster.
    type Target = { source: AuditionSource; voice: AuditionVoice; key: string; treatment: Treatment };
    const targets: Target[] = [];

    if (wanted[0] === 'curated') {
        for (const t of curatedTargets()) {
            if (curatedSources.length && !curatedSources.includes(t.source.id)) continue;
            const key = keyFor(t.source);
            if (!key) {
                if (!skipped.some((s) => s.label === t.source.label))
                    skipped.push({ ...t.source, reason: 'curated voices from this source were skipped' });
                continue;
            }
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
            for (const voice of roster.slice(0, limit))
                for (const treatment of treatmentsFor(source))
                    targets.push({ source, voice, key, treatment });
        }
    }

    if (targets.length === 0) {
        console.error('Nothing to audition. Set at least one provider key in ts/server/.env:');
        for (const s of SOURCES) console.error(`  ${s.envKeys[0]} — ${s.label} (${s.signupUrl})`);
        process.exit(1);
    }

    console.log(`Auditioning ${targets.length} voices at speed ${rate} → ${outDir}\n`);

    for (const { source, voice, key, treatment } of targets) {
        const name = voice.label ?? voice.id;
        try {
            const result = await source.synth(SAMPLE, voice.id, rate, key, treatment);
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
            const curated = curatedIndex.get(`${source.id}:${voice.id}`);

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
                rate,
                shippingTreatment: treatment.id === source.treatments[0]?.id,
                usdPerMillionChars,
                creditsPerHour: usdToCredits((usdPerMillionChars / M) * CHARS_PER_HOUR),
                billing: source.billing === 'per-char' ? 'per char' : 'per second',
                ...(curated ? { curatedAs: curated.name } : {}),
                ...(curated?.default ? { isDefault: true } : {}),
            });
            console.log(
                `  ✓ ${name.padEnd(24)} ${source.id.padEnd(9)} ${treatment.id.padEnd(20)} ` +
                    `${seconds.toFixed(1).padStart(5)}s ${money(usdPerMillionChars).padStart(6)}/1M` +
                    `${curated ? `  (ships as ${curated.name})` : ''}`
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
    for (const src of used) sourceMeta.set(src.id, { id: src.id, label: src.label, rateNote: src.rateNote });
    // Drop meta for sources no longer represented, so the chips can't outlive
    // their rows.
    const present = new Set(merged.map((r) => r.sourceId));
    const sources = [...sourceMeta.values()].filter((m) => present.has(m.id));

    writeFileSync(manifestPath, JSON.stringify({ rows: merged, sources } satisfies Manifest));
    writeFileSync(resolve(outDir, 'index.html'), html(merged, skipped, sources));

    const carried = merged.length - rows.length;
    if (carried > 0) console.log(`\n  (+ ${carried} voices carried over from earlier runs; --fresh to start over)`);

    if (wanted[0] === 'curated') {
        console.log(
            '\nThat was the CURATED set - only the voices we already ship. To hear new ones:\n' +
                '  npm run voices -- google --locales=en-US,en-GB,en-AU   # ~130 Google voices\n' +
                '  npm run voices -- openai                               # the full OpenAI roster\n' +
                '  npm run voices -- all                                  # every source with a key'
        );
    }

    if (skipped.length) {
        console.log('\nSkipped (no key):');
        for (const s of skipped) console.log(`  ${s.label} — set ${s.envKeys[0]} (${s.signupUrl})`);
    }
    console.log(`\nOpen: ${resolve(outDir, 'index.html')}`);
}

void main();
