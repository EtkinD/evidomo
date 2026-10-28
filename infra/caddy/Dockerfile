# syntax=docker/dockerfile:1

# Caddy with the site config baked in, running as a non-root user.
# Build context: infra/caddy (kept separate from infra/ so the server's infra/.env is never
# part of a build context).

FROM caddy:2.11-alpine

# The official image runs as root. Its binary carries cap_net_bind_service, so an
# unprivileged user can still bind 80/443. /data holds certificates and ACME state.
RUN addgroup -S -g 10001 caddy \
    && adduser -S -D -H -u 10001 -G caddy caddy \
    && chown -R caddy:caddy /data /config

COPY Caddyfile /etc/caddy/Caddyfile
# Fail the build on a Caddyfile error instead of at container start.
RUN SITE_ADDRESS=:80 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

USER caddy

# The admin API listens on localhost inside the container only.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:2019/config/"]
