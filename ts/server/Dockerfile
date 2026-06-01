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
FROM node:22-slim
WORKDIR /app

# Manifests first so `npm ci` is cached across source-only changes. Both the
# workspace root and the server package manifests are needed for the install.
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
RUN npm ci

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

CMD ["npm", "run", "start", "--workspace", "@aloud/server"]
