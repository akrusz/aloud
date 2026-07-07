#!/usr/bin/env python3
"""Render bd tickets as a self-contained, filterable HTML board.

    python3 scripts/bd-board.py [output.html]

Runs `bd list` itself (open + in_progress + closed) and writes a single
self-contained HTML file (default: bd-board.html) you can open in any browser.
A far friendlier read than the CLI for reviewing the backlog. Re-run anytime to
refresh. Requires `bd` on PATH; no other deps.
"""
import json, html, re, os, sys, subprocess

def bd(status):
    try:
        out = subprocess.run(["bd","list","--status",status,"--json"],
                             capture_output=True, text=True, check=True).stdout
        return json.loads(out or "[]")
    except Exception as e:
        print("warning: bd list --status", status, "failed:", e, file=sys.stderr)
        return []

active = bd("open") + bd("in_progress")
closed = bd("closed")

PREFIX = "meditation-pal-"
def short(i): return i.replace(PREFIX, "")

# Area buckets by keyword in title/description — encodes real structure, not decoration.
AREAS = [
    ("Mobile", re.compile(r"\b(mobile|capacitor|ios|android|testflight|play store|app store|native|apk|stt|tts|on-device|sign-?in)\b", re.I)),
    ("Billing & credits", re.compile(r"\b(credit|billing|stripe|x402|usdc|pricing|ledger|payment|monetiz|iap|gift)\b", re.I)),
    ("Cloud & server", re.compile(r"\b(cloud|hosted|server|proxy|litestream|fly|postgres|oauth|account|auth|deploy|CORS)\b", re.I)),
    ("Facilitation & modes", re.compile(r"\b(nedera|felt.sense|facilitat|mode|prompt|pacing|noting|meditation|kasina)\b", re.I)),
    ("Voice & STT/TTS", re.compile(r"\b(voice|whisper|piper|vibevoice|elevenlabs|speech|recogni)\b", re.I)),
    ("Desktop & shell", re.compile(r"\b(tauri|desktop|updater|dmg|msi|rust|shell)\b", re.I)),
]
def area_of(t):
    hay = (t.get("title","") + " " + t.get("description","")[:200])
    for name, rx in AREAS:
        if rx.search(hay):
            return name
    return "Other / UI"

def esc(s): return html.escape(s or "")
def para(s):
    # Preserve line structure from bd descriptions.
    s = esc(s).strip()
    return s.replace("\n", "<br>")

def rec(t, is_closed=False):
    return {
        "id": short(t["id"]),
        "fid": t["id"],
        "title": t.get("title",""),
        "desc": t.get("description","") or "",
        "notes": t.get("notes","") or "",
        "status": t.get("status","open"),
        "priority": t.get("priority", 2),
        "type": t.get("issue_type","task"),
        "area": area_of(t),
        "deps": t.get("dependency_count",0),
        "dependents": t.get("dependent_count",0),
        "updated": (t.get("updated_at","") or "")[:10],
        "closed": is_closed,
    }

data = [rec(t) for t in active] + [rec(t, True) for t in closed]

# Order areas: Mobile first (current focus), then by active count.
active_counts = {}
for r in data:
    if not r["closed"]:
        active_counts[r["area"]] = active_counts.get(r["area"],0)+1
area_order = ["Mobile"] + [a for a,_ in sorted(active_counts.items(), key=lambda kv:-kv[1]) if a!="Mobile"]
for a in {r["area"] for r in data}:
    if a not in area_order: area_order.append(a)

payload = json.dumps({"tickets": data, "areaOrder": area_order}, ensure_ascii=False)

n_active = sum(1 for r in data if not r["closed"])
n_prog = sum(1 for r in data if r["status"]=="in_progress")

HTML = r"""<title>aloud backlog</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{
  --ground:#f7f3 ea; --ground:#f8f4ec; --panel:#fffdf8; --panel-2:#f2ece0;
  --ink:#211b16; --ink-soft:#6a6154; --ink-faint:#938a7b; --line:#e6ddcd;
  --accent:#e0218a; --accent-soft:#fbe3f0; --orb:#f5a524;
  --p0:#d1344b; --p1:#e8590c; --p2:#c08a00; --p3:#5b7fa6; --p4:#9a9182;
  --ok:#2f9e6f; --prog:#c98a00;
  --radius:11px; --mono:ui-monospace,"SF Mono",Menlo,monospace;
  --sans:ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
}
@media (prefers-color-scheme:dark){:root{
  --ground:#17130f; --panel:#211b16; --panel-2:#2a231c; --ink:#f2ebdf; --ink-soft:#b3a897;
  --ink-faint:#847a6a; --line:#332a20; --accent:#ff5bb0; --accent-soft:#3a1327; --orb:#f5a524;
  --p3:#7ea3c9;
}}
:root[data-theme="dark"]{
  --ground:#17130f; --panel:#211b16; --panel-2:#2a231c; --ink:#f2ebdf; --ink-soft:#b3a897;
  --ink-faint:#847a6a; --line:#332a20; --accent:#ff5bb0; --accent-soft:#3a1327; --p3:#7ea3c9;
}
:root[data-theme="light"]{
  --ground:#f8f4ec; --panel:#fffdf8; --panel-2:#f2ece0; --ink:#211b16; --ink-soft:#6a6154;
  --ink-faint:#938a7b; --line:#e6ddcd; --accent:#e0218a; --accent-soft:#fbe3f0; --p3:#5b7fa6;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);
  line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px 80px}
header.top{padding:34px 0 20px}
.brand{font-size:15px;letter-spacing:.02em;color:var(--ink-soft);font-weight:600}
.brand b{color:var(--accent);font-weight:800}
h1{margin:.15em 0 .1em;font-size:clamp(28px,5vw,40px);font-weight:800;letter-spacing:-.02em;text-wrap:balance}
.sub{color:var(--ink-soft);font-size:15px;max-width:60ch}
.counts{display:flex;gap:18px;margin-top:16px;flex-wrap:wrap;font-size:13px;color:var(--ink-soft)}
.counts b{color:var(--ink);font-variant-numeric:tabular-nums}
.controls{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--ground) 88%,transparent);
  backdrop-filter:blur(8px);padding:12px 0;border-bottom:1px solid var(--line);margin-bottom:8px}
.controls .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
#q{flex:1;min-width:180px;padding:9px 13px;border:1px solid var(--line);border-radius:9px;
  background:var(--panel);color:var(--ink);font-size:14px;font-family:var(--sans)}
#q:focus{outline:2px solid var(--accent);outline-offset:1px}
.seg{display:flex;gap:4px;flex-wrap:wrap}
.chip{border:1px solid var(--line);background:var(--panel);color:var(--ink-soft);
  padding:6px 11px;border-radius:99px;font-size:12.5px;cursor:pointer;user-select:none;font-weight:600;
  transition:.12s}
.chip[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}
.chip:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.area{margin:26px 0 6px;display:flex;align-items:baseline;gap:10px}
.area h2{margin:0;font-size:13px;text-transform:uppercase;letter-spacing:.11em;color:var(--ink-faint);font-weight:700}
.area .n{font-size:12px;color:var(--ink-faint);font-variant-numeric:tabular-nums}
.area .bar{flex:1;height:1px;background:var(--line)}
ul.list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px}
li.t{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);
  overflow:hidden;position:relative}
li.t .strip{position:absolute;left:0;top:0;bottom:0;width:4px}
.p0 .strip{background:var(--p0)} .p1 .strip{background:var(--p1)} .p2 .strip{background:var(--p2)}
.p3 .strip{background:var(--p3)} .p4 .strip{background:var(--p4)}
.hd{display:flex;align-items:center;gap:10px;padding:11px 15px 11px 18px;cursor:pointer}
.hd:hover{background:var(--panel-2)}
.id{font-family:var(--mono);font-size:12px;color:var(--ink-faint);flex-shrink:0}
.ti{flex:1;font-size:14.5px;font-weight:600;min-width:0}
.meta{display:flex;gap:6px;align-items:center;flex-shrink:0}
.tag{font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;letter-spacing:.02em;white-space:nowrap}
.ty-bug{background:#fde3e3;color:#b2201f} .ty-feature{background:#e5f0ff;color:#1f5fbf}
.ty-task{background:var(--panel-2);color:var(--ink-soft)} .ty-epic{background:#efe3ff;color:#7a3fd0}
.ty-chore{background:var(--panel-2);color:var(--ink-soft)}
@media (prefers-color-scheme:dark){
  .ty-bug{background:#3a1a1a;color:#f7a3a2}.ty-feature{background:#16273f;color:#8fbaf5}
  .ty-epic{background:#281a3d;color:#c3a3f0}}
:root[data-theme="dark"] .ty-bug{background:#3a1a1a;color:#f7a3a2}
:root[data-theme="dark"] .ty-feature{background:#16273f;color:#8fbaf5}
:root[data-theme="dark"] .ty-epic{background:#281a3d;color:#c3a3f0}
.pill{font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;white-space:nowrap}
.st-open{background:var(--panel-2);color:var(--ink-faint)}
.st-in_progress{background:color-mix(in srgb,var(--prog) 22%,transparent);color:var(--prog)}
.st-closed{background:color-mix(in srgb,var(--ok) 20%,transparent);color:var(--ok)}
.dep{font-size:11px;color:var(--ink-faint);font-family:var(--mono)}
.body{display:none;padding:2px 18px 16px 18px;border-top:1px solid var(--line);
  background:var(--panel-2)}
li.open .body{display:block}
.body .txt{font-size:13.5px;color:var(--ink);white-space:normal;margin-top:12px;
  max-width:78ch;line-height:1.62}
.body .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.09em;color:var(--ink-faint);
  font-weight:700;margin:14px 0 4px}
.body .notes{border-left:2px solid var(--accent);padding-left:12px}
.empty{text-align:center;color:var(--ink-faint);padding:50px;font-size:14px}
.caret{color:var(--ink-faint);font-size:11px;transition:.15s;flex-shrink:0}
li.open .caret{transform:rotate(90deg)}
kbd{font-family:var(--mono);font-size:11px;background:var(--panel-2);border:1px solid var(--line);
  border-radius:5px;padding:1px 5px;color:var(--ink-soft)}
</style>

<div class="wrap">
<header class="top">
  <div class="brand"><b>aloud.</b> &nbsp;backlog</div>
  <h1>What's on the board</h1>
  <p class="sub">Every open ticket from Beads, grouped by area and ranked by priority. Click a row to read the full detail and notes. Mobile is up first, since that's the active push.</p>
  <div class="counts">
    <span><b>__NACTIVE__</b> active</span>
    <span><b>__NPROG__</b> in progress</span>
    <span>P0 <span style="color:var(--p0)">&#9632;</span> critical &rarr; P4 <span style="color:var(--p4)">&#9632;</span> backlog</span>
    <span>tap <kbd>/</kbd> to search</span>
  </div>
</header>

<div class="controls">
  <div class="row">
    <input id="q" type="search" placeholder="Search title, id, or text&hellip;" aria-label="Search tickets">
  </div>
  <div class="row" style="margin-top:8px">
    <div class="seg" id="fPrio" role="group" aria-label="Priority">
      <span class="chip" data-k="p" data-v="0" aria-pressed="false">P0</span>
      <span class="chip" data-k="p" data-v="1" aria-pressed="false">P1</span>
      <span class="chip" data-k="p" data-v="2" aria-pressed="false">P2</span>
      <span class="chip" data-k="p" data-v="3" aria-pressed="false">P3</span>
      <span class="chip" data-k="p" data-v="4" aria-pressed="false">P4</span>
    </div>
    <div class="seg" id="fType" role="group" aria-label="Type">
      <span class="chip" data-k="t" data-v="bug" aria-pressed="false">bugs</span>
      <span class="chip" data-k="t" data-v="feature" aria-pressed="false">features</span>
      <span class="chip" data-k="t" data-v="task" aria-pressed="false">tasks</span>
      <span class="chip" data-k="t" data-v="epic" aria-pressed="false">epics</span>
    </div>
    <div class="seg" id="fState" role="group" aria-label="State">
      <span class="chip" data-k="s" data-v="in_progress" aria-pressed="false">in progress</span>
      <span class="chip" data-k="s" data-v="closed" aria-pressed="false">show closed</span>
    </div>
  </div>
</div>

<div id="board"></div>
<div class="empty" id="empty" hidden>No tickets match those filters.</div>
</div>

<script id="data" type="application/json">__PAYLOAD__</script>
<script>
const {tickets, areaOrder} = JSON.parse(document.getElementById('data').textContent);
const board = document.getElementById('board'), empty = document.getElementById('empty'), q = document.getElementById('q');
const F = {p:new Set(), t:new Set(), s:new Set()};

function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
function ml(s){return esc(s).replace(/\n/g,'<br>');}

function passes(t){
  if(F.p.size && !F.p.has(String(t.priority))) return false;
  if(F.t.size && !F.t.has(t.type)) return false;
  // Closed hidden unless "show closed" is on.
  if(t.closed && !F.s.has('closed')) return false;
  if(F.s.has('in_progress') && t.status!=='in_progress') return false;
  const term = q.value.trim().toLowerCase();
  if(term){
    const hay = (t.id+' '+t.title+' '+t.desc+' '+t.notes).toLowerCase();
    if(!hay.includes(term)) return false;
  }
  return true;
}

function row(t){
  const li=document.createElement('li');
  li.className='t p'+t.priority;
  const deps = t.deps? `<span class="dep" title="depends on ${t.deps}">&#8627;${t.deps}</span>`:'';
  const dependents = t.dependents? `<span class="dep" title="${t.dependents} depend on this">&#8593;${t.dependents}</span>`:'';
  const body = (t.desc||t.notes)
    ? `<div class="body">${t.desc?`<div class="lbl">Detail</div><div class="txt">${ml(t.desc)}</div>`:''}`
      + `${t.notes?`<div class="lbl">Notes</div><div class="txt notes">${ml(t.notes)}</div>`:''}</div>`
    : `<div class="body"><div class="txt" style="color:var(--ink-faint)">No description recorded.</div></div>`;
  li.innerHTML = `<div class="strip"></div>
    <div class="hd">
      <span class="id">${esc(t.id)}</span>
      <span class="ti">${esc(t.title)}</span>
      <span class="meta">
        ${deps}${dependents}
        <span class="tag ty-${t.type}">${t.type}</span>
        <span class="pill st-${t.status}">${t.status.replace('_',' ')}</span>
        <span class="caret">&#9654;</span>
      </span>
    </div>${body}`;
  li.querySelector('.hd').addEventListener('click',()=>li.classList.toggle('open'));
  return li;
}

function render(){
  board.innerHTML='';
  const shown = tickets.filter(passes);
  let any=false;
  for(const area of areaOrder){
    const items = shown.filter(t=>t.area===area)
      .sort((a,b)=> a.priority-b.priority || (a.closed-b.closed) || a.id.localeCompare(b.id));
    if(!items.length) continue;
    any=true;
    const head=document.createElement('div');
    head.className='area';
    head.innerHTML=`<h2>${esc(area)}</h2><span class="n">${items.length}</span><span class="bar"></span>`;
    board.appendChild(head);
    const ul=document.createElement('ul');ul.className='list';
    items.forEach(t=>ul.appendChild(row(t)));
    board.appendChild(ul);
  }
  empty.hidden=any;
}

document.querySelectorAll('.chip').forEach(c=>{
  c.addEventListener('click',()=>{
    const on=c.getAttribute('aria-pressed')==='true';
    c.setAttribute('aria-pressed', on?'false':'true');
    F[c.dataset.k][on?'delete':'add'](c.dataset.v);
    render();
  });
});
q.addEventListener('input',render);
addEventListener('keydown',e=>{if(e.key==='/'&&document.activeElement!==q){e.preventDefault();q.focus();}});
render();
</script>
"""

HTML = (HTML.replace("__PAYLOAD__", payload)
            .replace("__NACTIVE__", str(n_active))
            .replace("__NPROG__", str(n_prog))
            .replace("#f7f3 ea", "#f8f4ec"))  # fix stray token
out = sys.argv[1] if len(sys.argv)>1 else "bd-board.html"
open(out, "w").write(HTML)
print("wrote", out, f"({len(HTML)//1024} KB), {n_active} active tickets")
