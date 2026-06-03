/**
 * Self-contained operator control panel, served as one HTML string from the
 * admin routes (GET /cloud/v1/admin) when ALOUD_ADMIN_TOKEN is configured.
 *
 * Deliberately a single inline page with no build step and no framework: it's
 * an internal tool that must keep working with zero deploy ceremony. The admin
 * token is NEVER baked in — the operator pastes it once, it lives in
 * localStorage for this origin, and every call sends it as a Bearer header.
 * Same-origin with the API, so no CORS in play.
 *
 * Everything the page can do maps to a token-gated endpoint in routes/admin.ts;
 * with no token, those return 404 and the page is just an inert form.
 */

export const ADMIN_PANEL_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>aloud — admin</title>
<style>
  :root {
    --bg: #14110f; --panel: #1d1916; --line: #2e2823; --ink: #efe7dd;
    --dim: #a89a8c; --accent: #e0a96d; --good: #7fb389; --bad: #d98a7a;
    --radius: 12px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
    padding: 24px; max-width: 980px; margin-inline: auto;
  }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: .3px; }
  h1 .dot { color: var(--accent); }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 1px;
       color: var(--dim); margin: 28px 0 12px; font-weight: 600; }
  .sub { color: var(--dim); font-size: 14px; margin: 0 0 20px; }
  .card { background: var(--panel); border: 1px solid var(--line);
          border-radius: var(--radius); padding: 16px 18px; margin-bottom: 14px; }
  label { display: block; font-size: 14px; color: var(--dim); margin-bottom: 5px; }
  input, textarea {
    width: 100%; padding: 9px 11px; background: #100d0b; color: var(--ink);
    border: 1px solid var(--line); border-radius: 8px; font: inherit;
  }
  textarea { resize: vertical; min-height: 60px; }
  input:focus, textarea:focus { outline: none; border-color: var(--accent); }
  .check { display: flex; align-items: center; gap: 9px; cursor: pointer; font-size: 14px; }
  .check input { width: auto; }
  button.xs { padding: 3px 9px; font-size: 14px; }
  button {
    padding: 9px 16px; background: var(--accent); color: #1a1208; border: none;
    border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer;
  }
  button.ghost { background: transparent; color: var(--ink); border: 1px solid var(--line); }
  button:disabled { opacity: .5; cursor: default; }
  button:hover:not(:disabled) { filter: brightness(1.08); }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; }
  .row > div { flex: 1; min-width: 140px; }
  .row > button { flex: 0 0 auto; }
  table { width: 100%; border-collapse: collapse; font-size: 15px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  th { color: var(--dim); font-weight: 600; font-size: 14px;
       text-transform: uppercase; letter-spacing: .6px; }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: #221d19; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px;
          font-size: 14px; font-weight: 600; }
  .pill.paid { background: rgba(127,179,137,.18); color: var(--good); }
  .pill.free { background: rgba(168,154,140,.16); color: var(--dim); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .stat { background: #100d0b; border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .stat .k { font-size: 14px; color: var(--dim); text-transform: uppercase; letter-spacing: .5px; }
  .stat .v { font-size: 20px; font-weight: 700; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .stat .v.warn { color: var(--bad); }
  .msg { font-size: 15px; margin-top: 10px; min-height: 18px; }
  .msg.ok { color: var(--good); }
  .msg.err { color: var(--bad); }
  .muted { color: var(--dim); }
  .hidden { display: none; }
  code { background: #100d0b; padding: 1px 5px; border-radius: 4px; font-size: 14px; }
  .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.6);
              display: flex; align-items: center; justify-content: center; padding: 20px; }
  .modal { background: var(--panel); border: 1px solid var(--line);
           border-radius: var(--radius); padding: 20px; max-width: 560px; width: 100%;
           max-height: 80vh; overflow: auto; }
  .modal h3 { margin: 0 0 2px; font-size: 16px; }
  .x { float: right; background: none; border: none; color: var(--dim);
       font-size: 22px; cursor: pointer; padding: 0; line-height: 1; }
</style>
</head>
<body>
  <h1>aloud<span class="dot">.</span> admin</h1>
  <p class="sub">Operator console — spend, accounts, and credit grants. Token-gated; never share this URL with the token in it.</p>

  <div class="card" id="authCard">
    <label for="tok">Admin token (<code>ALOUD_ADMIN_TOKEN</code>)</label>
    <div class="row">
      <div><input id="tok" type="password" placeholder="paste token" autocomplete="off"></div>
      <button id="connect">Connect</button>
      <button class="ghost" id="forget">Forget</button>
    </div>
    <div class="msg" id="authMsg"></div>
  </div>

  <div id="app" class="hidden">
    <h2>Spend &amp; abuse <button class="ghost" id="refreshMetrics" style="float:right;padding:4px 10px;font-size:14px">refresh</button></h2>
    <div class="grid" id="stats"></div>

    <h2>Cost attribution
      <span style="float:right;display:flex;gap:8px;align-items:center">
        <select id="usageWindow" style="width:auto;padding:4px 8px;font-size:14px">
          <option value="24">last 24h</option>
          <option value="168">last 7d</option>
          <option value="720">last 30d</option>
          <option value="1000000">all time</option>
        </select>
        <button class="ghost" id="refreshUsage" style="padding:4px 10px;font-size:14px">refresh</button>
      </span>
    </h2>
    <p class="sub" style="margin:-4px 0 12px">What real sessions actually cost — the LLM/STT/TTS split, cache-hit ratio, and per-session economics the ledger can't show. Use this to calibrate <code>USD_PER_CREDIT</code> and pack sizing.</p>
    <div class="grid" id="usageStats"></div>
    <div class="card">
      <p class="sub" style="margin:0 0 10px">Cost split by service — what drives the bill.</p>
      <table>
        <thead><tr><th>Service</th><th class="num">Provider $</th><th class="num">Share</th><th class="num">Credits</th><th class="num">Calls</th></tr></thead>
        <tbody id="usageServiceRows"><tr><td colspan="5" class="muted">Connect to load.</td></tr></tbody>
      </table>
    </div>
    <div class="card">
      <p class="sub" style="margin:0 0 10px">Per-model / per-voice cost, biggest first.</p>
      <table>
        <thead><tr><th>Service</th><th>Model / voice</th><th class="num">Provider $</th><th class="num">Credits</th><th class="num">Calls</th></tr></thead>
        <tbody id="usageModelRows"><tr><td colspan="5" class="muted">Connect to load.</td></tr></tbody>
      </table>
    </div>
    <div class="card">
      <p class="sub" style="margin:0 0 10px">Per-session distribution — sessions reconstructed by clustering each account's calls (gaps over 8&nbsp;min split a session).</p>
      <table>
        <thead><tr><th>Metric</th><th class="num">Median</th><th class="num">p90</th><th class="num">Max</th><th class="num">Mean</th></tr></thead>
        <tbody id="usageSessionRows"><tr><td colspan="5" class="muted">Connect to load.</td></tr></tbody>
      </table>
    </div>

    <h2>Usage over time
      <span style="float:right;display:flex;gap:8px;align-items:center">
        <select id="historyMetric" style="width:auto;padding:4px 8px;font-size:14px">
          <option value="sessions">sessions</option>
          <option value="turns">turns</option>
          <option value="cost">provider $</option>
          <option value="credits">credits</option>
          <option value="duration">avg min / session</option>
        </select>
        <select id="historyDays" style="width:auto;padding:4px 8px;font-size:14px">
          <option value="7">last 7d</option>
          <option value="30" selected>last 30d</option>
          <option value="90">last 90d</option>
        </select>
        <button class="ghost" id="refreshHistory" style="padding:4px 10px;font-size:14px">refresh</button>
      </span>
    </h2>
    <p class="sub" style="margin:-4px 0 12px">Daily trend, one bar per day. Each session is counted on the day it began. Hover a bar for the exact value.</p>
    <div class="card">
      <div id="historyChart"><p class="muted" style="margin:0">Connect to load.</p></div>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Day</th><th class="num">Sessions</th><th class="num">Turns</th><th class="num">Provider $</th><th class="num">Credits</th><th class="num">Avg min</th></tr></thead>
        <tbody id="historyRows"><tr><td colspan="6" class="muted">Connect to load.</td></tr></tbody>
      </table>
    </div>

    <h2>Free credits</h2>
    <div class="card">
      <p class="sub" style="margin:0 0 14px">Tune the free tier live — no redeploy. Set either to <strong>0</strong> to stop handing out free credits while you test. Persisted across restarts.</p>
      <div class="row">
        <div>
          <label for="cSignup">Free credits per new signup</label>
          <input id="cSignup" type="number" min="0" step="1" autocomplete="off">
        </div>
        <div>
          <label for="cBudget">Global free-grant budget / hour</label>
          <input id="cBudget" type="number" min="0" step="1" autocomplete="off">
        </div>
        <button id="saveConfig">Save</button>
      </div>
      <div class="msg" id="configMsg"></div>
    </div>

    <h2>Soft launch — pause spending</h2>
    <div class="card">
      <p class="sub" style="margin:0 0 14px">While paused, signed-in users keep their credits, but a conversation turn returns a polite "come back later" message instead of a real (billed) facilitator response — so nobody spends yet, and their session still saves. Tester emails below bypass the pause so you can keep testing.</p>
      <label class="check"><input type="checkbox" id="cPaused"> <span>Pause metered usage (conversations return the canned apology)</span></label>
      <div style="margin-top:14px">
        <label for="cTesters">Tester emails — exempt from the pause (one per line)</label>
        <textarea id="cTesters" rows="3" placeholder="you@example.com" autocomplete="off"></textarea>
      </div>
      <div class="row" style="margin-top:12px"><button id="savePause">Save</button></div>
      <div class="msg" id="pauseMsg"></div>
    </div>

    <h2>Grant credits</h2>
    <div class="card">
      <div class="row">
        <div><label for="gEmail">Account email</label><input id="gEmail" placeholder="someone@example.com" autocomplete="off"></div>
        <div style="flex:0 0 130px"><label for="gCredits">Credits</label><input id="gCredits" type="number" min="1" step="1" placeholder="100"></div>
        <button id="grant">Grant</button>
      </div>
      <div class="msg" id="grantMsg"></div>
    </div>

    <h2>Retreats <button class="ghost" id="refreshRetreats" style="float:right;padding:4px 10px;font-size:14px">refresh</button></h2>
    <div class="card">
      <p class="sub" style="margin:0 0 14px">Time-boxed unlimited access for a retreat. Create a pass, then add attendees by email (they must have signed in once). Members aren't metered while the pass is active and in its date window. Leave the daily cap blank for truly unlimited, or set a per-attendee credit ceiling as a backstop.</p>
      <div class="row">
        <div><label for="rLabel">Label</label><input id="rLabel" placeholder="Spring Vipassana 2026" autocomplete="off"></div>
        <div style="flex:0 0 150px"><label for="rStart">Starts</label><input id="rStart" type="date"></div>
        <div style="flex:0 0 150px"><label for="rEnd">Ends</label><input id="rEnd" type="date"></div>
        <div style="flex:0 0 150px"><label for="rCap">Daily cap / person</label><input id="rCap" type="number" min="1" step="1" placeholder="unlimited"></div>
        <button id="createRetreat">Create</button>
      </div>
      <div class="msg" id="retreatMsg"></div>
    </div>
    <div id="retreatList"></div>

    <h2>Accounts <button class="ghost" id="refreshAccts" style="float:right;padding:4px 10px;font-size:14px">refresh</button></h2>
    <div class="card">
      <div class="row" style="margin-bottom:12px">
        <div><input id="search" placeholder="filter by email…" autocomplete="off"></div>
      </div>
      <table>
        <thead><tr><th>Email</th><th>Status</th><th class="num">Balance</th><th class="num">Granted</th><th class="num">Spent</th><th>Joined</th><th></th></tr></thead>
        <tbody id="acctRows"><tr><td colspan="7" class="muted">Connect to load accounts.</td></tr></tbody>
      </table>
    </div>
  </div>

  <div id="modalRoot"></div>

<script>
(function () {
  var KEY = 'aloud-admin-token';
  var $ = function (id) { return document.getElementById(id); };
  var token = '';

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ authorization: 'Bearer ' + token }, opts.headers || {});
    return fetch('/cloud/v1/admin' + path, opts).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error((body && body.error && body.error.message) || ('HTTP ' + r.status));
        return body;
      }, function () {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return {};
      });
    });
  }

  function setMsg(el, text, kind) {
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function usd(n) { return '$' + Number(n || 0).toFixed(2); }
  // Provider costs per call/session are often fractions of a cent — show enough
  // precision to be legible (4 dp under $1, 2 dp above).
  function usdp(n) { n = Number(n || 0); return '$' + n.toFixed(n < 1 ? 4 : 2); }
  function pct(n) { return (Number(n || 0) * 100).toFixed(0) + '%'; }
  function int(n) { return Number(n || 0).toLocaleString(); }
  // Credit amounts are fractional (TTS debits sub-credit), so show one decimal.
  function dec1(n) { return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
  // Counts that can be fractional means (turns/session) — up to one decimal, no
  // forced trailing zero, so a clean integer median still reads as "6".
  function num1(n) { return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 1 }); }
  function date(ts) { return new Date(ts * 1000).toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' }); }

  // ---- metrics dashboard -------------------------------------------------
  function loadMetrics() {
    return api('/metrics?sinceHours=24').then(function (m) {
      var t = m.totals, w = m.window, a = m.abuse;
      var cards = [
        ['Accounts', int(t.accounts)],
        ['Credits outstanding', dec1(t.creditsOutstanding)],
        ['Provider cost (all-time)', usd(t.providerCostUsd)],
        ['Free burn (non-converters)', usd(t.freeBurnUsd), t.freeBurnUsd > 0 ? 'warn' : ''],
        ['Est. gross revenue', usd(t.estGrossRevenueUsd)],
        ['Signups (24h)', int(w.signups)],
        ['Provider cost (24h)', usd(w.providerCostUsd)],
        ['IP clusters (24h)', int(a.ipsOverThreshold), a.ipsOverThreshold > 0 ? 'warn' : ''],
      ];
      $('stats').innerHTML = cards.map(function (c) {
        return '<div class="stat"><div class="k">' + c[0] + '</div><div class="v ' + (c[2] || '') + '">' + c[1] + '</div></div>';
      }).join('');
    });
  }

  // ---- cost attribution --------------------------------------------------
  var SVC = { llm: 'LLM', stt: 'STT', tts: 'TTS' };
  function loadUsage() {
    return api('/usage?sinceHours=' + $('usageWindow').value).then(function (u) {
      var s = u.sessions;
      var cards = [
        ['Provider cost', usdp(u.totals.providerCostUsd)],
        ['Credits spent', dec1(u.totals.credits)],
        ['Metered calls', int(u.events)],
        ['LLM cache-hit', pct(u.llmCacheHitRatio)],
        ['Sessions', int(s.count)],
        ['Avg cost / session', usdp(s.costUsd.mean)],
        ['Median credits / session', dec1(s.credits.p50)],
        ['Avg turns / session', num1(s.turns.mean)],
        ['Avg session length', (Number(s.meanDurationMin) || 0).toFixed(1) + ' min'],
      ];
      $('usageStats').innerHTML = cards.map(function (c) {
        return '<div class="stat"><div class="k">' + c[0] + '</div><div class="v">' + c[1] + '</div></div>';
      }).join('');

      var svc = u.byService.slice().sort(function (a, b) { return b.providerCostUsd - a.providerCostUsd; });
      $('usageServiceRows').innerHTML = svc.map(function (v) {
        return '<tr><td>' + (SVC[v.kind] || v.kind) + '</td><td class="num">' + usdp(v.providerCostUsd) +
          '</td><td class="num">' + pct(v.costShare) + '</td><td class="num">' + dec1(v.credits) +
          '</td><td class="num">' + int(v.events) + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="muted">No usage in this window.</td></tr>';

      $('usageModelRows').innerHTML = u.byModel.map(function (m) {
        return '<tr><td>' + (SVC[m.kind] || m.kind) + '</td><td><code>' + esc(m.model) + '</code></td><td class="num">' +
          usdp(m.providerCostUsd) + '</td><td class="num">' + dec1(m.credits) + '</td><td class="num">' + int(m.events) + '</td></tr>';
      }).join('') || '<tr><td colspan="5" class="muted">No usage in this window.</td></tr>';

      function distRow(label, d, fmt) {
        return '<tr><td>' + label + '</td><td class="num">' + fmt(d.p50) + '</td><td class="num">' + fmt(d.p90) +
          '</td><td class="num">' + fmt(d.max) + '</td><td class="num">' + fmt(d.mean) + '</td></tr>';
      }
      $('usageSessionRows').innerHTML = s.count
        ? distRow('Provider $ / session', s.costUsd, usdp) +
          distRow('Credits / session', s.credits, dec1) +
          distRow('Turns / session', s.turns, num1)
        : '<tr><td colspan="5" class="muted">No sessions in this window.</td></tr>';
    });
  }

  // ---- usage over time (daily trend) -------------------------------------
  // Each metric: a label, a per-day value getter, and a value formatter.
  var HISTORY = [];
  var METRICS = {
    sessions: { label: 'Sessions', val: function (b) { return b.sessions; }, fmt: int },
    turns: { label: 'Turns', val: function (b) { return b.turns; }, fmt: int },
    cost: { label: 'Provider $', val: function (b) { return b.providerCostUsd; }, fmt: usdp },
    credits: { label: 'Credits', val: function (b) { return b.credits; }, fmt: dec1 },
    duration: {
      label: 'Avg min / session',
      val: function (b) { return b.sessions ? b.durationMin / b.sessions : 0; },
      fmt: function (n) { return (Number(n || 0)).toFixed(1); },
    },
  };

  // Inline-SVG bar chart — no deps, scales to the window. One bar per day, a
  // dashed max gridline, and first/mid/last date ticks so it stays legible at
  // 90 bars. Each bar carries a <title> for hover-to-read the exact value.
  function barChart(buckets, metricKey) {
    var m = METRICS[metricKey] || METRICS.sessions;
    if (!buckets.length) return '<p class="muted" style="margin:0">No usage in this window.</p>';
    var vals = buckets.map(m.val);
    var max = Math.max.apply(null, vals.concat([0]));
    var W = 760, H = 180, padX = 8, padTop = 16, padBot = 22;
    var n = buckets.length, bw = (W - padX * 2) / n, plotH = H - padTop - padBot;
    var bars = buckets.map(function (b, i) {
      var v = m.val(b);
      var h = max > 0 ? plotH * (v / max) : 0;
      var x = padX + i * bw, y = padTop + (plotH - h);
      return '<rect x="' + (x + 0.7).toFixed(1) + '" y="' + y.toFixed(1) +
        '" width="' + Math.max(0.5, bw - 1.4).toFixed(1) + '" height="' + h.toFixed(1) +
        '" rx="1.5" fill="var(--accent)"><title>' + esc(date(b.dayStartTs) + ': ' + m.fmt(v)) + '</title></rect>';
    }).join('');
    var baseY = padTop + plotH;
    var axis = '<line x1="' + padX + '" y1="' + baseY + '" x2="' + (W - padX) + '" y2="' + baseY +
      '" stroke="var(--line)" stroke-width="1"/>';
    // Dashed gridline + label at the max.
    var grid = max > 0
      ? '<line x1="' + padX + '" y1="' + padTop + '" x2="' + (W - padX) + '" y2="' + padTop +
        '" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 3"/>' +
        '<text x="' + (W - padX) + '" y="' + (padTop - 4) + '" text-anchor="end" font-size="11" fill="var(--dim)">' +
          esc(m.fmt(max)) + '</text>'
      : '';
    // Date ticks: first, middle, last.
    var ticks = [0, Math.floor(n / 2), n - 1].filter(function (v, i, a) { return a.indexOf(v) === i; });
    var labels = ticks.map(function (i) {
      var x = padX + i * bw + bw / 2;
      var anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      return '<text x="' + x.toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + anchor +
        '" font-size="11" fill="var(--dim)">' + esc(date(buckets[i].dayStartTs)) + '</text>';
    }).join('');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H +
      '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="' + esc(m.label) + ' per day">' +
      grid + bars + axis + labels + '</svg>';
  }

  function renderHistory() {
    $('historyChart').innerHTML = barChart(HISTORY, $('historyMetric').value);
    $('historyRows').innerHTML = HISTORY.slice().reverse().map(function (b) {
      var avgMin = b.sessions ? b.durationMin / b.sessions : 0;
      return '<tr><td class="muted">' + date(b.dayStartTs) + '</td>' +
        '<td class="num">' + int(b.sessions) + '</td>' +
        '<td class="num">' + int(b.turns) + '</td>' +
        '<td class="num">' + usdp(b.providerCostUsd) + '</td>' +
        '<td class="num">' + dec1(b.credits) + '</td>' +
        '<td class="num">' + avgMin.toFixed(1) + '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="muted">No usage yet.</td></tr>';
  }

  function loadUsageHistory() {
    return api('/usage/history?days=' + $('historyDays').value).then(function (h) {
      HISTORY = h.buckets || [];
      renderHistory();
    });
  }

  // ---- free-credit knobs -------------------------------------------------
  function loadConfig() {
    return api('/config').then(function (cfg) {
      $('cSignup').value = cfg.freeSignupCredits;
      $('cBudget').value = cfg.freeGrantBudgetPerHour;
      $('cPaused').checked = !!cfg.meteredPaused;
      $('cTesters').value = (cfg.testerEmails || []).join('\n');
    });
  }
  function savePause() {
    var testers = $('cTesters').value.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
    $('savePause').disabled = true;
    api('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meteredPaused: $('cPaused').checked, testerEmails: testers }),
    }).then(function (cfg) {
      $('cTesters').value = (cfg.testerEmails || []).join('\n');
      setMsg($('pauseMsg'), cfg.meteredPaused
        ? 'Saved — spending PAUSED for everyone except ' + (cfg.testerEmails.length || 0) + ' tester(s).'
        : 'Saved — spending is live.', 'ok');
    }).catch(function (e) {
      setMsg($('pauseMsg'), e.message, 'err');
    }).then(function () { $('savePause').disabled = false; });
  }
  function saveConfig() {
    var signup = parseInt($('cSignup').value, 10);
    var budget = parseInt($('cBudget').value, 10);
    if (!(signup >= 0) || !(budget >= 0)) { setMsg($('configMsg'), 'Both values must be 0 or more.', 'err'); return; }
    $('saveConfig').disabled = true;
    api('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ freeSignupCredits: signup, freeGrantBudgetPerHour: budget }),
    }).then(function (cfg) {
      $('cSignup').value = cfg.freeSignupCredits;
      $('cBudget').value = cfg.freeGrantBudgetPerHour;
      var off = cfg.freeSignupCredits === 0 || cfg.freeGrantBudgetPerHour === 0;
      setMsg($('configMsg'), 'Saved.' + (off ? ' Free credits are OFF.' : ''), 'ok');
    }).catch(function (e) {
      setMsg($('configMsg'), e.message, 'err');
    }).then(function () { $('saveConfig').disabled = false; });
  }

  // ---- accounts table ----------------------------------------------------
  var allAccounts = [];
  function renderAccounts() {
    var q = $('search').value.trim().toLowerCase();
    var rows = allAccounts.filter(function (a) { return !q || a.email.toLowerCase().indexOf(q) >= 0; });
    if (!rows.length) {
      $('acctRows').innerHTML = '<tr><td colspan="7" class="muted">No accounts' + (q ? ' match.' : ' yet.') + '</td></tr>';
      return;
    }
    $('acctRows').innerHTML = rows.map(function (a) {
      var pill = a.purchased ? '<span class="pill paid">paid</span>' : '<span class="pill free">free</span>';
      return '<tr data-id="' + a.id + '">' +
        '<td>' + esc(a.email) + '</td>' +
        '<td>' + pill + '</td>' +
        '<td class="num">' + dec1(a.balance) + '</td>' +
        '<td class="num">' + dec1(a.granted) + '</td>' +
        '<td class="num">' + dec1(a.debited) + '</td>' +
        '<td class="muted">' + date(a.createdAt) + '</td>' +
        '<td><button class="ghost xs" data-grant="' + esc(a.email) + '">grant</button></td>' +
        '</tr>';
    }).join('');
    Array.prototype.forEach.call($('acctRows').querySelectorAll('tr'), function (tr) {
      tr.addEventListener('click', function () { openLedger(tr.getAttribute('data-id')); });
    });
    // Per-row grant: prefill the Grant form with this email (don't open ledger).
    Array.prototype.forEach.call($('acctRows').querySelectorAll('[data-grant]'), function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        $('gEmail').value = btn.getAttribute('data-grant');
        $('gCredits').focus();
        $('gCredits').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  }
  function loadAccounts() {
    return api('/accounts').then(function (list) { allAccounts = list; renderAccounts(); });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ---- per-account ledger modal -----------------------------------------
  function openLedger(id) {
    api('/accounts/' + encodeURIComponent(id)).then(function (d) {
      var entries = d.entries.slice().reverse(); // newest first
      var rows = entries.map(function (e) {
        var amt = e.amount > 0 ? '+' + dec1(e.amount) : dec1(e.amount);
        var cls = e.amount > 0 ? 'good' : 'bad';
        return '<tr><td class="muted">' + date(e.createdAt) + '</td><td>' + esc(e.kind) +
          '</td><td>' + esc(e.reason) + '</td><td class="num" style="color:var(--' + cls + ')">' + amt + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="muted">No ledger entries.</td></tr>';
      $('modalRoot').innerHTML =
        '<div class="modal-bg" id="mbg"><div class="modal">' +
        '<button class="x" id="mx">&times;</button>' +
        '<h3>' + esc(d.account.email) + '</h3>' +
        '<p class="sub" style="margin:0 0 14px">Balance <strong>' + dec1(d.balance) + '</strong> credits · ' +
        'id <code>' + esc(d.account.id) + '</code></p>' +
        '<table><thead><tr><th>When</th><th>Kind</th><th>Reason</th><th class="num">Δ</th></tr></thead><tbody>' +
        rows + '</tbody></table></div></div>';
      $('mx').onclick = $('mbg').onclick = function (e) {
        if (e.target === $('mbg') || e.target === $('mx')) $('modalRoot').innerHTML = '';
      };
    }).catch(function (e) { alert(e.message); });
  }

  // ---- grant -------------------------------------------------------------
  function doGrant() {
    var email = $('gEmail').value.trim();
    var credits = parseInt($('gCredits').value, 10);
    if (!email || !(credits > 0)) { setMsg($('grantMsg'), 'Enter an email and a positive credit amount.', 'err'); return; }
    $('grant').disabled = true;
    api('/grant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email, credits: credits }),
    }).then(function (r) {
      setMsg($('grantMsg'), 'Granted ' + int(credits) + ' to ' + email + ' — new balance ' + dec1(r.balance) + '.', 'ok');
      $('gCredits').value = '';
      return Promise.all([loadAccounts(), loadMetrics()]);
    }).catch(function (e) {
      setMsg($('grantMsg'), e.message, 'err');
    }).then(function () { $('grant').disabled = false; });
  }

  // ---- retreats ----------------------------------------------------------
  function loadRetreats() {
    return api('/retreats').then(renderRetreats);
  }
  function renderRetreats(list) {
    if (!list.length) {
      $('retreatList').innerHTML = '<p class="muted" style="padding:0 2px 8px">No retreat passes yet.</p>';
      return;
    }
    var now = Date.now() / 1000;
    $('retreatList').innerHTML = list.map(function (p) {
      var active = p.status === 'active' && p.startsAt <= now && p.endsAt >= now;
      var state = p.status === 'revoked' ? '<span class="pill free">revoked</span>'
        : active ? '<span class="pill paid">active</span>'
        : p.startsAt > now ? '<span class="pill free">scheduled</span>'
        : '<span class="pill free">ended</span>';
      var cap = p.perAttendeeDailyCap == null ? 'unlimited' : dec1(p.perAttendeeDailyCap) + ' credits/day';
      var revoke = p.status === 'revoked' ? ''
        : '<button class="ghost xs" data-revoke="' + p.id + '">revoke</button>';
      // Per-attendee rows: email, their provider cost, and suggested bill.
      var memberRows = p.members.length
        ? p.members.map(function (m) {
            return '<tr><td>' + esc(m.email) + '</td><td class="num">' + usdp(m.spend.providerCostUsd) +
              '</td><td class="num">' + usdp(m.billableUsd) + '</td></tr>';
          }).join('')
        : '<tr><td colspan="3" class="muted">No attendees signed in yet.</td></tr>';
      // Pending invites (added by email, not yet claimed by a sign-in).
      var pending = (p.invites && p.invites.length)
        ? '<p class="sub" style="margin:8px 0 0">Pending (will join on first sign-in): ' +
            p.invites.map(esc).join(', ') + '</p>'
        : '';
      return '<div class="card">' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<strong>' + esc(p.label) + '</strong> ' + state +
          '<span style="flex:1"></span>' + revoke +
        '</div>' +
        '<p class="sub" style="margin:8px 0">' + date(p.startsAt) + ' → ' + date(p.endsAt) +
          ' · cap ' + cap + '</p>' +
        '<div class="grid" style="margin:0 0 10px">' +
          '<div class="stat"><div class="k">Provider cost</div><div class="v">' + usdp(p.spend.providerCostUsd) + '</div></div>' +
          '<div class="stat"><div class="k">Suggested bill</div><div class="v">' + usdp(p.billableUsd) + '</div></div>' +
          '<div class="stat"><div class="k">Calls</div><div class="v">' + int(p.spend.events) + '</div></div>' +
          '<div class="stat"><div class="k">Attendees</div><div class="v">' + int(p.members.length) + '</div></div>' +
        '</div>' +
        '<table><thead><tr><th>Attendee</th><th class="num">Provider $</th><th class="num">Bill</th></tr></thead>' +
          '<tbody>' + memberRows + '</tbody></table>' +
        pending +
        '<div class="row" style="margin-top:12px"><div><input data-email="' + p.id + '" placeholder="attendee@example.com" autocomplete="off"></div>' +
          '<button class="ghost xs" data-add="' + p.id + '">Add attendee</button></div>' +
        '<div class="msg" data-msg="' + p.id + '"></div>' +
      '</div>';
    }).join('');

    Array.prototype.forEach.call($('retreatList').querySelectorAll('[data-revoke]'), function (btn) {
      btn.addEventListener('click', function () {
        if (!confirm('Revoke this pass? Coverage stops immediately for every attendee.')) return;
        api('/retreats/' + btn.getAttribute('data-revoke') + '/revoke', { method: 'POST' })
          .then(loadRetreats)
          .catch(function (e) { alert(e.message); });
      });
    });
    Array.prototype.forEach.call($('retreatList').querySelectorAll('[data-add]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-add');
        var input = $('retreatList').querySelector('[data-email="' + id + '"]');
        var msg = $('retreatList').querySelector('[data-msg="' + id + '"]');
        var email = input.value.trim();
        if (!email) { setMsg(msg, 'Enter an email.', 'err'); return; }
        btn.disabled = true;
        api('/retreats/' + id + '/members', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: email }),
        }).then(function () { input.value = ''; return loadRetreats(); })
          .catch(function (e) { setMsg(msg, e.message, 'err'); btn.disabled = false; });
      });
    });
  }
  function createRetreat() {
    var label = $('rLabel').value.trim();
    var start = $('rStart').value, end = $('rEnd').value;
    var capRaw = $('rCap').value.trim();
    if (!label || !start || !end) { setMsg($('retreatMsg'), 'Label, start, and end dates are required.', 'err'); return; }
    // Cover the whole end day (local time); send epoch seconds.
    var startsAt = new Date(start + 'T00:00:00').getTime() / 1000;
    var endsAt = new Date(end + 'T23:59:59').getTime() / 1000;
    if (!(endsAt > startsAt)) { setMsg($('retreatMsg'), 'End must be after start.', 'err'); return; }
    var cap = capRaw === '' ? null : Number(capRaw);
    $('createRetreat').disabled = true;
    api('/retreats', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: label, startsAt: startsAt, endsAt: endsAt, perAttendeeDailyCap: cap }),
    }).then(function () {
      setMsg($('retreatMsg'), 'Created "' + label + '".', 'ok');
      $('rLabel').value = ''; $('rCap').value = '';
      return loadRetreats();
    }).catch(function (e) {
      setMsg($('retreatMsg'), e.message, 'err');
    }).then(function () { $('createRetreat').disabled = false; });
  }

  // ---- connect / boot ----------------------------------------------------
  function connect() {
    token = $('tok').value.trim();
    if (!token) { setMsg($('authMsg'), 'Paste the admin token first.', 'err'); return; }
    setMsg($('authMsg'), 'Connecting…');
    loadMetrics().then(function () {
      localStorage.setItem(KEY, token);
      setMsg($('authMsg'), 'Connected.', 'ok');
      $('app').classList.remove('hidden');
      return Promise.all([loadAccounts(), loadConfig(), loadUsage(), loadUsageHistory(), loadRetreats()]);
    }).catch(function (e) {
      setMsg($('authMsg'), 'Failed: ' + e.message, 'err');
      $('app').classList.add('hidden');
    });
  }

  $('connect').onclick = connect;
  $('forget').onclick = function () {
    localStorage.removeItem(KEY); token = ''; $('tok').value = '';
    $('app').classList.add('hidden'); setMsg($('authMsg'), 'Token forgotten.');
  };
  $('grant').onclick = doGrant;
  $('saveConfig').onclick = saveConfig;
  $('savePause').onclick = savePause;
  $('refreshMetrics').onclick = function () { loadMetrics().catch(function (e) { setMsg($('authMsg'), e.message, 'err'); }); };
  $('refreshUsage').onclick = function () { loadUsage().catch(function (e) { setMsg($('authMsg'), e.message, 'err'); }); };
  $('usageWindow').addEventListener('change', function () { loadUsage().catch(function (e) { setMsg($('authMsg'), e.message, 'err'); }); });
  $('refreshHistory').onclick = function () { loadUsageHistory().catch(function (e) { setMsg($('authMsg'), e.message, 'err'); }); };
  $('historyDays').addEventListener('change', function () { loadUsageHistory().catch(function (e) { setMsg($('authMsg'), e.message, 'err'); }); });
  // Metric switch is a pure client-side re-render — no refetch needed.
  $('historyMetric').addEventListener('change', renderHistory);
  $('refreshAccts').onclick = function () { loadAccounts().catch(function (e) { setMsg($('authMsg'), e.message, 'err'); }); };
  $('refreshRetreats').onclick = function () { loadRetreats().catch(function (e) { setMsg($('authMsg'), e.message, 'err'); }); };
  $('createRetreat').onclick = createRetreat;
  $('search').addEventListener('input', renderAccounts);
  $('tok').addEventListener('keydown', function (e) { if (e.key === 'Enter') connect(); });
  $('gCredits').addEventListener('keydown', function (e) { if (e.key === 'Enter') doGrant(); });

  var saved = localStorage.getItem(KEY);
  if (saved) { $('tok').value = saved; connect(); }
})();
</script>
</body>
</html>`;
