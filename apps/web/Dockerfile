# syntax=docker/dockerfile:1

# Web image: Next.js (Pages Router) production build served by `next start`.
# Build context: repository root.  docker build -f apps/web/Dockerfile .

ARG NODE_IMAGE=node:24.22-trixie-slim

FROM ${NODE_IMAGE} AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NEXT_TELEMETRY_DISABLED=1

# Every workspace manifest is copied because `npm ci` validates the whole lockfile.
# Add new workspaces here (and in apps/api/Dockerfile).
FROM base AS manifests
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

# `next build` type-checks, so the build stage needs the root devDependencies (typescript).
FROM manifests AS build
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev --ignore-scripts --workspace @evidomo/web --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
# Public origin for absolute og:image URLs. NEXT_PUBLIC_ values are inlined at build time, so
# this is a build argument (not a secret); changing it needs a rebuild.
ARG NEXT_PUBLIC_SITE_ORIGIN=
ENV NEXT_PUBLIC_SITE_ORIGIN=${NEXT_PUBLIC_SITE_ORIGIN}
RUN npm run build --workspace @evidomo/web \
    && rm -rf apps/web/.next/cache

FROM manifests AS prod-deps
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --workspace @evidomo/web

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000
COPY --from=prod-deps /app /app
COPY apps/web/next.config.ts apps/web/
COPY --from=build /app/apps/web/.next apps/web/.next
# Static files (icons, manifest, OG image) are served by `next start` from public/.
COPY --from=build /app/apps/web/public apps/web/public
# Build output stays root-owned; only Next's runtime cache directory is writable.
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
WORKDIR /app/apps/web
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "/app/node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]
