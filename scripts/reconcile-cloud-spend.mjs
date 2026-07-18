#!/usr/bin/env node
/**
 * Reconcile aloud cloud's computed provider spend against what the providers
 * actually bill (meditation-pal-xejm, minimal script version).
 *
 * Our side:   GET /cloud/v1/admin/usage/provider-daily  (computed from the
 *             usage_events telemetry: our rate table x provider-reported counts)
 * Anthropic:  GET /v1/organizations/cost_report          (Admin API key)
 * OpenAI:     GET /v1/organization/costs                 (org Admin key)
 * Google:     no simple cost API - Gemini + Cloud TTS bill through Cloud
 *             Billing; check the console or a BigQuery billing export manually.
 *
 * Usage:
 *   ALOUD_ADMIN_TOKEN=... ANTHROPIC_ADMIN_KEY=sk-ant-admin... OPENAI_ADMIN_KEY=... \
 *     node scripts/reconcile-cloud-spend.mjs [--days 14] [--threshold 10]
 *
 * Env:
 *   ALOUD_CLOUD_URL     hosted origin (default https://aloud-cloud.fly.dev)
 *   ALOUD_ADMIN_TOKEN   required - the admin bearer token
 *   ANTHROPIC_ADMIN_KEY optional - skips Anthropic reconciliation when absent
 *   OPENAI_ADMIN_KEY    optional - skips OpenAI reconciliation when absent
 *
 * Interpretation: single-day mismatches are expected noise (UTC bucket edges,
 * minimum billing increments, reporting lag up to ~5 min, today is partial).
 * The signal is a consistent bias across the window - that means either a
 * stale rate in ts/server/src/pricing/providers.ts (per-model drift) or calls
 * escaping the meter entirely (uniform gap).
 */

const args = process.argv.slice(2);
function argValue(name, fallback) {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] != null ? Number(args[i + 1]) : fallback;
}

// Anthropic's cost report caps 1d buckets at 31; keep everything in that range.
const days = Math.min(31, Math.max(1, argValue('--days', 14)));
const thresholdPct = argValue('--threshold', 10);

const cloudUrl = (process.env.ALOUD_CLOUD_URL ?? 'https://aloud-cloud.fly.dev').replace(/\/$/, '');

/** Secrets go into HTTP headers, which must be Latin-1. A pasted token with a
 *  Unicode lookalike (e.g. Cyrillic "у" for "u") crashes fetch with a cryptic
 *  ByteString error - catch it here and point at the exact character. */
function cleanSecret(name) {
    const raw = process.env[name];
    if (!raw) return undefined;
    const value = raw.trim();
    for (let i = 0; i < value.length; i++) {
        const code = value.codePointAt(i);
        if (code > 0x7e || code < 0x21) {
            console.error(
                `${name} contains a non-ASCII character at position ${i} ` +
                    `("${value[i]}", U+${code.toString(16).toUpperCase().padStart(4, '0')}). ` +
                    'Likely a copy-paste homoglyph - re-copy the value from its source.'
            );
            process.exit(2);
        }
    }
    return value;
}

const adminToken = cleanSecret('ALOUD_ADMIN_TOKEN');
const anthropicKey = cleanSecret('ANTHROPIC_ADMIN_KEY');
const openaiKey = cleanSecret('OPENAI_ADMIN_KEY');

if (!adminToken) {
    console.error('ALOUD_ADMIN_TOKEN is required (the admin bearer token for ' + cloudUrl + ')');
    process.exit(2);
}

const DAY = 24 * 60 * 60;
const todayStart = Math.floor(Date.now() / 1000 / DAY) * DAY;
const firstDay = todayStart - (days - 1) * DAY;
const iso = (ts) => new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const dayLabel = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

async function getJson(url, headers) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
        throw new Error(`${url.split('?')[0]} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return res.json();
}

// ---- our side: day -> provider -> USD --------------------------------------
async function fetchOurs() {
    const data = await getJson(`${cloudUrl}/cloud/v1/admin/usage/provider-daily?days=${days}`, {
        authorization: `Bearer ${adminToken}`,
    });
    const byProvider = new Map(); // provider -> Map(dayStartTs -> usd)
    for (const row of data.rows) {
        const m = byProvider.get(row.provider) ?? new Map();
        m.set(row.dayStartTs, (m.get(row.dayStartTs) ?? 0) + row.providerCostUsd);
        byProvider.set(row.provider, m);
    }
    return byProvider;
}

// ---- Anthropic: cost_report, amounts are decimal-string CENTS --------------
async function fetchAnthropic() {
    const daily = new Map(); // dayStartTs -> usd
    let page;
    do {
        const params = new URLSearchParams({
            starting_at: iso(firstDay),
            ending_at: iso(todayStart + DAY),
            bucket_width: '1d',
        });
        if (page) params.set('page', page);
        const data = await getJson(`https://api.anthropic.com/v1/organizations/cost_report?${params}`, {
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
        });
        for (const bucket of data.data ?? []) {
            const day = Math.floor(Date.parse(bucket.starting_at) / 1000 / DAY) * DAY;
            const usd = (bucket.results ?? []).reduce((s, r) => s + Number(r.amount ?? 0) / 100, 0);
            daily.set(day, (daily.get(day) ?? 0) + usd);
        }
        page = data.has_more ? data.next_page : undefined;
    } while (page);
    return daily;
}

// ---- OpenAI: organization costs, amount.value is USD -----------------------
async function fetchOpenAI() {
    const daily = new Map();
    let page;
    do {
        const params = new URLSearchParams({
            start_time: String(firstDay),
            end_time: String(todayStart + DAY),
            bucket_width: '1d',
            limit: String(days),
        });
        if (page) params.set('page', page);
        const data = await getJson(`https://api.openai.com/v1/organization/costs?${params}`, {
            authorization: `Bearer ${openaiKey}`,
        });
        for (const bucket of data.data ?? []) {
            const day = Math.floor(bucket.start_time / DAY) * DAY;
            const usd = (bucket.results ?? []).reduce((s, r) => s + Number(r.amount?.value ?? 0), 0);
            daily.set(day, (daily.get(day) ?? 0) + usd);
        }
        page = data.has_more ? data.next_page : undefined;
    } while (page);
    return daily;
}

// ---- diff + report ---------------------------------------------------------
const usd = (n) => '$' + n.toFixed(4);

function reportProvider(name, ours, theirs) {
    console.log(`\n== ${name} ==`);
    console.log('day         | ours       | billed     | delta      | drift');
    let oursTotal = 0;
    let theirsTotal = 0;
    let flagged = 0;
    for (let d = firstDay; d <= todayStart; d += DAY) {
        const a = ours.get(d) ?? 0;
        const b = theirs.get(d) ?? 0;
        if (a === 0 && b === 0) continue;
        const partial = d === todayStart;
        // Drift relative to the billed side; full mismatch when one side is 0.
        const pct = b > 0 ? ((a - b) / b) * 100 : 100;
        const flag = !partial && Math.abs(pct) > thresholdPct;
        if (flag) flagged += 1;
        if (!partial) {
            oursTotal += a;
            theirsTotal += b;
        }
        console.log(
            `${dayLabel(d)}  | ${usd(a).padStart(10)} | ${usd(b).padStart(10)} | ${usd(a - b).padStart(10)} | ` +
                (partial ? '(today, partial)' : `${pct.toFixed(1)}%${flag ? '  <-- over threshold' : ''}`)
        );
    }
    if (oursTotal === 0 && theirsTotal === 0) {
        console.log('no spend on either side in this window');
        return { flagged: 0 };
    }
    const totalPct = theirsTotal > 0 ? ((oursTotal - theirsTotal) / theirsTotal) * 100 : 100;
    console.log(
        `TOTAL (full days) | ${usd(oursTotal).padStart(10)} | ${usd(theirsTotal).padStart(10)} | ` +
            `${usd(oursTotal - theirsTotal).padStart(10)} | ${totalPct.toFixed(1)}%`
    );
    return { flagged };
}

const ours = await fetchOurs();
console.log(`Reconciling ${cloudUrl} vs provider billing, last ${days} days (UTC), threshold ${thresholdPct}%`);

let anyFlagged = false;
const covered = new Set();

if (anthropicKey) {
    covered.add('anthropic');
    const r = reportProvider('anthropic', ours.get('anthropic') ?? new Map(), await fetchAnthropic());
    anyFlagged = anyFlagged || r.flagged > 0;
} else {
    console.log('\nANTHROPIC_ADMIN_KEY not set - skipping Anthropic');
}

if (openaiKey) {
    covered.add('openai');
    const r = reportProvider('openai', ours.get('openai') ?? new Map(), await fetchOpenAI());
    anyFlagged = anyFlagged || r.flagged > 0;
} else {
    console.log('\nOPENAI_ADMIN_KEY not set - skipping OpenAI');
}

// Providers we metered but can't pull a bill for programmatically.
for (const [provider, dailyMap] of ours) {
    if (covered.has(provider)) continue;
    const total = [...dailyMap.values()].reduce((s, v) => s + v, 0);
    if (total > 0) {
        console.log(
            `\n${provider}: ${usd(total)} computed in window - no cost API wired; ` +
                (provider === 'google'
                    ? 'check Cloud Billing (console or BigQuery export) manually'
                    : 'reconcile via the provider dashboard')
        );
    }
}

if (anyFlagged) {
    console.log(`\nDrift beyond ${thresholdPct}% on at least one full day. A consistent bias means a stale`);
    console.log('rate in ts/server/src/pricing/providers.ts or calls escaping the meter.');
    process.exitCode = 1;
} else {
    console.log('\nNo full-day drift beyond threshold for the reconciled providers.');
}
