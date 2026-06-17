#!/usr/bin/env bash
# Durability probe — meditation-pal-b8hf.
#
# Proves that a committed write survives the failure cycle that lost a real
# credit purchase (meditation-pal-5iv4): an idle stop + redeploy, or a full
# volume loss + litestream restore.
#
# It writes an ISOLATED marker via the admin API — a "retreat pass" — and reads
# it back after the disruption. A retreat pass lives in the same SQLite file and
# the same WAL as the credit ledger, so its survival proves a ledger row's would
# survive too; using it keeps fake data out of the ledger/metrics, and it's
# reversible (revoke + delete the state file). Pass/fail is the exit code, so
# this drops into CI or a manual runbook step.
#
# Usage (see dev-docs/deploy.md → "Durability validation"):
#   ALOUD_ADMIN_TOKEN=… ./durability-probe.sh write     # BEFORE the disruption
#   …stop + redeploy, or destroy the volume + redeploy…
#   ALOUD_ADMIN_TOKEN=… ./durability-probe.sh check      # AFTER — PASS or FAIL
#   ALOUD_ADMIN_TOKEN=… ./durability-probe.sh cleanup    # revoke the marker
#
# Env:
#   ALOUD_ADMIN_TOKEN  (required) the ALOUD_ADMIN_TOKEN secret, OR a signed-in
#                      admin session JWT — copy it from the panel with
#                      localStorage.getItem('aloud-admin-token') in the console.
#   ALOUD_BASE_URL     (default https://aloud-cloud.fly.dev)
#   PROBE_STATE        (default ./.durability-probe.json) where `write` saves the id
set -euo pipefail

BASE="${ALOUD_BASE_URL:-https://aloud-cloud.fly.dev}"
STATE="${PROBE_STATE:-./.durability-probe.json}"
TOKEN="${ALOUD_ADMIN_TOKEN:?set ALOUD_ADMIN_TOKEN (admin token or a signed-in admin session JWT)}"
API="$BASE/cloud/v1/admin"
AUTH=(-H "authorization: Bearer $TOKEN")

case "${1:-}" in
  write)
    label="durability-probe-$(date +%s)-$$"
    start="$(date +%s)"
    end="$(( start + 86400 ))"
    resp="$(curl -fsS "${AUTH[@]}" -H 'content-type: application/json' \
      -X POST "$API/retreats" \
      -d "{\"label\":\"$label\",\"startsAt\":$start,\"endsAt\":$end}")"
    id="$(printf '%s' "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')"
    printf '{"id":"%s","label":"%s"}\n' "$id" "$label" >"$STATE"
    echo "WROTE marker  id=$id  label=$label  (saved to $STATE)"
    echo "Now run the disruption, then: $0 check"
    ;;
  check)
    [ -f "$STATE" ] || { echo "no state file $STATE — run '$0 write' first" >&2; exit 2; }
    id="$(PROBE_STATE="$STATE" python3 -c 'import os,json;print(json.load(open(os.environ["PROBE_STATE"]))["id"])')"
    list="$(curl -fsS "${AUTH[@]}" "$API/retreats")"
    if printf '%s' "$list" | PROBE_ID="$id" python3 -c \
      'import sys,os,json; ids=[p["id"] for p in json.load(sys.stdin)]; sys.exit(0 if os.environ["PROBE_ID"] in ids else 1)'; then
      echo "PASS  marker $id survived the cycle — the write was durable."
    else
      echo "FAIL  marker $id is GONE after the cycle — data was lost. Reopen meditation-pal-5iv4." >&2
      exit 1
    fi
    ;;
  cleanup)
    [ -f "$STATE" ] || { echo "nothing to clean ($STATE missing)"; exit 0; }
    id="$(PROBE_STATE="$STATE" python3 -c 'import os,json;print(json.load(open(os.environ["PROBE_STATE"]))["id"])')"
    curl -fsS "${AUTH[@]}" -X POST "$API/retreats/$id/revoke" >/dev/null && echo "revoked $id"
    rm -f "$STATE"
    ;;
  *)
    echo "usage: $0 {write|check|cleanup}" >&2; exit 2;;
esac
