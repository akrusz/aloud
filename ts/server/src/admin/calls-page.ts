/**
 * The per-call page (GET /cloud/v1/admin/calls): pick one of the operator's
 * own sessions, see every metered call it made (admin/calls.ts). Its own page
 * because the panel is already long, and this is a drill-down you open with a
 * question, not a dashboard you watch.
 *
 * Same contract as panel.ts: served unauthenticated, carries no data, and
 * reads through gated endpoints. It borrows the panel's stored credential
 * (same origin, same localStorage key), so sign in there first.
 */

import { CACHE_TTL_SEC } from './calls.js';
import { ADMIN_STYLE } from './style.js';

export function renderCallsPage(): string {
    return CALLS_PAGE_TEMPLATE.replace('"__CACHE_TTL_SEC__"', String(CACHE_TTL_SEC));
}

const CALLS_PAGE_TEMPLATE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>aloud - calls</title>
<style>
${ADMIN_STYLE}
  tr.cold td { background: rgba(217,138,122,.08); }
  tr.incident td { color: var(--bad); }
  tr.selected td { background: #2a241f; }
</style>
</head>
<body class="hide-help">
  <h1><span>aloud<span class="dot">.</span> calls</span><span class="controls"><a href="/cloud/v1/admin" class="muted" style="font-size:14px">← panel</a><button id="toggleHelp" class="ghost xs" type="button">Show explanations</button></span></h1>
  <p class="sub help-text">Every metered call one of your sessions made. Only sessions from admin accounts (<code>ALOUD_ADMIN_EMAILS</code>) are listed; real users stay aggregate-only.</p>
  <div class="msg" id="msg"></div>

  <div id="app" class="hidden">
    <h2>Sessions
      <span class="controls">
        <select id="win">
          <option value="24">last 24h</option>
          <option value="168" selected>last 7d</option>
          <option value="720">last 30d</option>
          <option value="2160">last 90d</option>
        </select>
      </span>
    </h2>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Start</th><th>Account</th><th class="num">Min</th><th>Model</th><th class="num">Turns</th><th class="num">Cold</th><th class="num">LLM $</th><th class="num">Util $</th><th class="num">STT $</th><th class="num">TTS $</th><th class="num">Total $</th></tr></thead>
        <tbody id="sessions"></tbody>
      </table>
    </div>

    <div id="detail" class="hidden">
      <h2 id="detailTitle">Session</h2>
      <div class="grid" id="stats"></div>
      <p class="sub help-text"><b>Facilitation spend by token type.</b> Output includes hidden thinking. Cache writes cost 1.25x input (5m) or 2x (1h anchor); reads are cheap, so a big write column means the cache went cold.</p>
      <div class="grid" id="split"></div>
      <h2>Calls
        <span class="controls">
          <label class="check"><input type="checkbox" id="showUtil"> utility</label>
          <label class="check"><input type="checkbox" id="showStt"> STT</label>
          <label class="check"><input type="checkbox" id="showTts"> TTS</label>
        </span>
      </h2>
      <p class="sub help-text"><b>Gap</b> is the time since the previous facilitation call; past the 5-minute cache TTL, the next call re-writes the prefix. <b>Cold</b> rows wrote more cache than they read. Incident rows (red) come from the same session: cut-off replies, blank turns, errors.</p>
      <div class="card table-wrap">
        <table>
          <thead><tr><th>t</th><th class="num">Gap</th><th>Call</th><th class="num">In</th><th class="num">Out</th><th class="num">Read</th><th class="num">Write</th><th class="num">1h</th><th class="num">$</th></tr></thead>
          <tbody id="calls"></tbody>
        </table>
      </div>
    </div>
  </div>

<script>
(function () {
  var KEY = 'aloud-admin-token';
  var CACHE_TTL_SEC = "__CACHE_TTL_SEC__";
  var $ = function (id) { return document.getElementById(id); };
  var token = '';
  try { token = localStorage.getItem(KEY) || ''; } catch (e) {}
  var detail = null;

  function api(path) {
    return fetch('/cloud/v1/admin' + path, { headers: { authorization: 'Bearer ' + token } }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error((body && body.error && body.error.message) || ('HTTP ' + r.status));
        return body;
      });
    });
  }
  function fail(e) {
    $('msg').className = 'msg err';
    $('msg').innerHTML = esc(e.message) + ' - <a href="/cloud/v1/admin">sign in on the panel</a>, then come back.';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function int(n) { return Math.round(n).toLocaleString(); }
  function usd(n, dp) { return '$' + n.toFixed(dp == null ? 3 : dp); }
  function clock(sec) {
    sec = Math.round(sec);
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function when(ts) {
    return new Date(ts * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function model(m) { return m ? m.replace(/^[^:]+:/, '') : '-'; }
  function stat(k, v, warn) {
    return '<div class="stat"><div class="k" title="' + esc(k) + '">' + esc(k) + '</div><div class="v' + (warn ? ' warn' : '') + '">' + v + '</div></div>';
  }

  function loadSessions() {
    return api('/sessions?sinceHours=' + $('win').value).then(function (body) {
      $('app').classList.remove('hidden');
      var rows = body.sessions || [];
      $('sessions').innerHTML = rows.length ? rows.map(function (s) {
        var c = s.costUsd;
        return '<tr data-id="' + esc(s.sessionId) + '"' + (detail && detail.session.sessionId === s.sessionId ? ' class="selected"' : '') + '>' +
          '<td style="white-space:nowrap">' + when(s.startTs) + '</td><td>' + esc(s.account) + '</td>' +
          '<td class="num">' + s.minutes.toFixed(0) + '</td><td><code>' + esc(model(s.model)) + '</code></td>' +
          '<td class="num">' + s.turns + '</td><td class="num">' + (s.coldCalls || '') + '</td>' +
          '<td class="num">' + usd(c.facilitation) + '</td><td class="num">' + usd(c.utility) + '</td>' +
          '<td class="num">' + usd(c.stt) + '</td><td class="num">' + usd(c.tts) + '</td>' +
          '<td class="num"><b>' + usd(c.total) + '</b></td></tr>';
      }).join('') : '<tr><td colspan="11" class="muted">No admin-account sessions in this window.</td></tr>';
      Array.prototype.forEach.call($('sessions').querySelectorAll('tr[data-id]'), function (tr) {
        tr.onclick = function () { location.hash = tr.getAttribute('data-id'); };
      });
    });
  }

  function loadDetail(id) {
    return api('/sessions/' + encodeURIComponent(id)).then(function (d) {
      detail = d;
      renderDetail();
      Array.prototype.forEach.call($('sessions').querySelectorAll('tr[data-id]'), function (tr) {
        tr.classList.toggle('selected', tr.getAttribute('data-id') === id);
      });
    });
  }

  function renderDetail() {
    var d = detail, s = d.session, c = s.costUsd, fc = d.facilitationCosts, ft = d.facilitationTokens;
    $('detail').classList.remove('hidden');
    $('detailTitle').textContent = 'Session ' + when(s.startTs) + ' · ' + model(s.model);
    var hours = s.minutes / 60;
    $('stats').innerHTML =
      stat('Minutes', s.minutes.toFixed(1)) +
      stat('Facilitation turns', s.turns) +
      stat('Cold calls', s.coldCalls, s.coldCalls > 0) +
      stat('Incidents', d.incidents.length, d.incidents.length > 0) +
      stat('Total', usd(c.total)) +
      stat('Per hour', hours > 0 ? usd(c.total / hours, 2) : '-') +
      stat('LLM', usd(c.facilitation)) +
      stat('Utility', usd(c.utility)) +
      stat('STT', usd(c.stt)) +
      stat('TTS', usd(c.tts));
    function tok(n) { return '<div class="muted" style="font-size:13px;font-weight:400">' + int(n) + ' tok</div>'; }
    $('split').innerHTML =
      stat('Output', usd(fc.output) + tok(ft.output)) +
      stat('Cache read', usd(fc.cacheRead) + tok(ft.cacheRead)) +
      stat('Cache write 5m', usd(fc.cacheWrite) + tok(ft.cacheWrite)) +
      stat('Cache write 1h', usd(fc.cacheWrite1h) + tok(ft.cacheWrite1h)) +
      stat('Fresh input', usd(fc.input) + tok(ft.input)) +
      stat('Out / turn', s.turns ? int(ft.output / s.turns) + ' tok' : '-');
    renderCalls();
  }

  function renderCalls() {
    if (!detail) return;
    var show = { facilitation: true, utility: $('showUtil').checked, stt: $('showStt').checked, tts: $('showTts').checked };
    var t0 = detail.session.startTs;
    var items = detail.calls.filter(function (x) { return show[x.role]; })
      .map(function (x) { return { ts: x.ts, call: x }; })
      .concat(detail.incidents.map(function (i) { return { ts: i.ts, incident: i }; }))
      .sort(function (a, b) { return a.ts - b.ts; });
    $('calls').innerHTML = items.map(function (it) {
      if (it.incident) {
        var i = it.incident;
        return '<tr class="incident"><td>' + clock(i.ts - t0) + '</td><td></td><td colspan="7"><b>' + esc(i.kind) + '</b> ' +
          '<span title="' + esc(i.detail) + '">' + esc(i.detail) + '</span></td></tr>';
      }
      var x = it.call;
      var what = x.role === 'facilitation' ? model(x.model)
        : x.role === 'utility' ? 'util · ' + model(x.model)
        : x.role === 'stt' ? 'STT · ' + x.seconds.toFixed(1) + 's'
        : 'TTS · ' + int(x.chars) + ' chars';
      var llm = x.kind === 'llm';
      var gap = x.gapSec == null ? '' : clock(x.gapSec);
      if (x.gapSec != null && x.gapSec > CACHE_TTL_SEC) gap = '<span class="pill warn">' + gap + '</span>';
      return '<tr' + (x.cold ? ' class="cold"' : '') + '><td>' + clock(x.offsetSec) + '</td><td class="num">' + gap + '</td>' +
        '<td>' + esc(what) + (x.cold ? ' <span class="pill warn">cold</span>' : '') + '</td>' +
        '<td class="num">' + (llm ? int(x.tokensIn) : '') + '</td><td class="num">' + (llm ? int(x.tokensOut) : '') + '</td>' +
        '<td class="num">' + (llm ? int(x.cacheRead) : '') + '</td><td class="num">' + (llm ? int(x.cacheCreation - x.cacheCreation1h) : '') + '</td>' +
        '<td class="num">' + (llm && x.cacheCreation1h ? int(x.cacheCreation1h) : '') + '</td>' +
        '<td class="num">' + usd(x.costUsd, 4) + '</td></tr>';
    }).join('');
  }

  function route() {
    var id = decodeURIComponent(location.hash.slice(1));
    if (id) loadDetail(id).catch(fail);
  }

  $('toggleHelp').onclick = function () {
    var hidden = document.body.classList.toggle('hide-help');
    $('toggleHelp').textContent = hidden ? 'Show explanations' : 'Hide explanations';
  };
  $('win').onchange = function () { loadSessions().catch(fail); };
  ['showUtil', 'showStt', 'showTts'].forEach(function (id) { $(id).onchange = renderCalls; });
  window.addEventListener('hashchange', route);

  if (!token) { fail(new Error('Not signed in')); return; }
  loadSessions().then(route).catch(fail);
})();
</script>
</body>
</html>`;
