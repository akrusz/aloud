#!/bin/sh
# aloud cloud container entrypoint. Wraps the server in Litestream so the
# SQLite credit ledger (ALOUD_DB_PATH) is continuously replicated to Cloudflare
# R2 and can be restored after a volume loss. See dev-docs/deploy.md → Backups.
set -e

# No R2 configured → run the server directly, exactly as before. This keeps
# dev and self-host (no bucket) working with zero backup setup; replication
# only engages when the R2 secrets are present.
if [ -z "$R2_BUCKET" ]; then
  echo "litestream: R2_BUCKET unset — running without backup replication"
  exec npm run start --workspace @aloud/server
fi

# Disaster recovery: if the volume has no ledger yet (a fresh or replaced
# volume), pull the latest snapshot from R2 before the server opens the DB.
# -if-replica-exists makes the first-ever boot (empty bucket) a clean no-op,
# so the server then creates a fresh ledger as usual.
if [ ! -f "$ALOUD_DB_PATH" ]; then
  echo "litestream: $ALOUD_DB_PATH missing — attempting restore from R2"
  litestream restore -if-replica-exists "$ALOUD_DB_PATH"
fi

# Run the server under Litestream: it streams the WAL to R2 (~1s lag) and
# forwards signals so shutdown does a final sync before exit.
exec litestream replicate -exec "npm run start --workspace @aloud/server"
