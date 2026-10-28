# syntax=docker/dockerfile:1

# API and worker image (one image, two commands). Build context: repository root.
#   docker build -f apps/api/Dockerfile .                    -> runtime (api; worker via CMD override)
#   docker build -f apps/api/Dockerfile --target migrate .   -> one-off drizzle-kit migrations
#
# API and worker run TypeScript through Node's native type stripping, so there is no
# compile step: the runtime stage is production dependencies plus sources.

ARG NODE_IMAGE=node:24.22-trixie-slim

FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# Every workspace manifest is copied because `npm ci` validates the whole lockfile.
# Add new workspaces here (and in apps/web/Dockerfile).
FROM base AS manifests
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

FROM manifests AS app
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --workspace @evidomo/api
COPY packages/shared/src packages/shared/src
COPY apps/api/src apps/api/src
COPY apps/api/drizzle apps/api/drizzle
# Service definitions and market profiles, validated at boot (resolved as /app/definitions).
COPY definitions definitions

FROM base AS runtime
# ffmpeg converts audio to WAV for transcription (docs/architecture.md section 2).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data \
    && chown node:node /data
ENV NODE_ENV=production \
    PORT=4000
# Sources stay root-owned and read-only for the runtime user; only /data (storage volume) is writable.
COPY --from=app /app /app
WORKDIR /app/apps/api
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/server.ts"]

# Migrations need drizzle-kit (an api devDependency), so they get their own target instead
# of shipping dev dependencies in the runtime image.
FROM manifests AS migrate
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev --ignore-scripts --workspace @evidomo/api
COPY packages/shared/src packages/shared/src
COPY apps/api/drizzle.config.ts apps/api/
COPY apps/api/src apps/api/src
COPY apps/api/drizzle apps/api/drizzle
WORKDIR /app/apps/api
USER node
CMD ["node", "/app/node_modules/drizzle-kit/bin.cjs", "migrate"]
