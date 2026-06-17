#!/bin/sh
# aloud cloud container entrypoint. Wraps the server in Litestream so the
# SQLite credit ledger (ALOUD_DB_PATH) is continuously replicated to Cloudflare
# R2 and can be restored after a volume loss. See dev-docs/deploy.md → Backups.
set -e

# Run the server from its package dir as a SINGLE node process via tsx's loader
# (`node --import tsx`), NOT `npm run start` or the `tsx` CLI. npm — and a
# wrapper CLI — don't reliably forward SIGTERM/SIGINT to the underlying node
# process, so the graceful-shutdown handler in index.ts never fired: Litestream
# forwarded the signal, npm swallowed it, node kept running, and Fly force-halted
# the VM ("exited abruptly"), cutting Litestream's final R2 sync (meditation-pal-5iv4).
# With one process the signal reaches node directly. Imports (including the
# @aloud/core `../src` alias) resolve identically — verified by running
# `node --import tsx src/index.ts` from ts/server.
cd /app/server
SERVER="node --import tsx src/index.ts"

# No R2 configured → run the server directly, exactly as before. This keeps
# dev and self-host (no bucket) working with zero backup setup; replication
# only engages when the R2 secrets are present.
if [ -z "$R2_BUCKET" ]; then
  echo "litestream: R2_BUCKET unset — running without backup replication"
  exec $SERVER
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
# forwards signals to node, which shuts down cleanly so Litestream does a final
# sync before exit.
exec litestream replicate -exec "$SERVER"
