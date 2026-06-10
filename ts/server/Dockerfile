# aloud cloud (@aloud/server) — deploy image. meditation-pal-a3u.
#
# BUILD CONTEXT IS THE ts/ WORKSPACE ROOT, not ts/server. The server runs via
# tsx and resolves the `@aloud/core` path alias (../src) at runtime, so core's
# source must be in the image — the server's own files aren't enough. Build:
#
#   cd ts && docker build -f server/Dockerfile -t aloud-cloud .
#
# Fly does this for you: `fly deploy` from ts/ with server/fly.toml (its
# [build] dockerfile points here). See dev-docs/deploy.md.
#
# Node 22 because the durable ledger uses the built-in `node:sqlite`
# (SqliteCreditsStore); no native module to compile.

# Litestream binary, copied from its official image — continuously replicates
# the SQLite ledger to Cloudflare R2 and restores it after a volume loss. See
# server/litestream.yml + docker-entrypoint.sh, and dev-docs/deploy.md → Backups.
FROM litestream/litestream:0.3.13 AS litestream

FROM node:22-slim
WORKDIR /app
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
# node:22-slim ships without a CA bundle; Litestream is a static Go binary that
# verifies R2's TLS against the system trust store, so without this it fails with
# "x509: certificate signed by unknown authority". ~200KB, worth it.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Manifests first so `npm ci` is cached across source-only changes. Both the
# workspace root and the server package manifests are needed for the install.
# Production-only install: tsx (the runtime) is a regular dependency of
# @aloud/server, so --omit=dev drops the whole workspace dev toolchain (vite,
# vitest, typescript, the Tauri/Capacitor CLIs) from the image. The root
# package's *prod* deps (small, pure-JS) still install — npm resolves every
# workspace from the one lockfile — which is an acceptable cost.
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
RUN npm ci --omit=dev

# Source. core (src/) + the server, plus the root tsconfig the server's
# tsconfig extends/uses for the @aloud/core alias. ui/ and src-tauri/ are
# excluded by .dockerignore — this image is API-only.
COPY tsconfig.json ./
COPY src ./src
COPY server ./server

ENV ALOUD_ENV=production
ENV PORT=8787
# Durable credit ledger on the mounted volume (fly.toml [mounts]). Without a
# persistent path here the server would refuse to start in production.
ENV ALOUD_DB_PATH=/data/aloud.db
EXPOSE 8787

# Litestream config at its default path, plus the entrypoint that restores the
# ledger from R2 on a fresh volume then runs the server under replication. With
# no R2_* secrets set, the entrypoint runs the server directly (no backups) —
# see docker-entrypoint.sh.
COPY server/litestream.yml /etc/litestream.yml
COPY server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
CMD ["/usr/local/bin/docker-entrypoint.sh"]
