# syntax=docker/dockerfile:1

# ---- build: compile TypeScript and run the checks --------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY test ./test
# The tests never touch the network; a failing test fails the image build.
RUN npm run typecheck && npm test && npm run build

# ---- runtime: production dependencies and the compiled JS only -------------
FROM node:22-alpine AS runtime

ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="ethereum-key-status" \
      org.opencontainers.image.description="Checks Ethereum validator key status against beacon nodes and posts a summary to Microsoft Teams on a schedule" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

# tini forwards SIGTERM from `docker stop` to node and reaps zombies, so the
# scheduler's graceful shutdown actually runs. tzdata makes TZ=Europe/Vienna
# (or any other zone) work on alpine, which ships without zone files.
RUN apk add --no-cache tini tzdata

ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    LOG_DIR=/app/logs \
    RESULTS_DIR=/app/results \
    KEYSETS_PATH=/app/config/keysets.json \
    KEY_JSON_PATH=/app/config/keys.json

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Mount points. Pre-created and owned by `node` (uid 1000) so they are
# writable without a mount, or with a named volume; bind-mounted host dirs
# must be chowned to 1000 on the host (see README).
RUN mkdir -p /app/results /app/logs /app/config \
    && chown node:node /app/results /app/logs

USER node

# The scheduler rewrites its heartbeat file every 30 s; a stale file means
# the event loop is wedged. Meaningless (but harmless) in --once mode.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
    CMD ["node", "dist/healthcheck.js"]

ENTRYPOINT ["/sbin/tini", "--"]
# Scheduler (daemon) mode. For a single check:
#   docker compose run --rm keystatus node dist/index.js --once
CMD ["node", "dist/index.js"]
