# syntax=docker/dockerfile:1

# Backup service: pg_dump (same major version as the database image) plus the scheduler script.
# Build context: infra/backup (kept separate from infra/ so the server's infra/.env is never part
# of a build context).

FROM postgres:18.6-alpine

# Runs as uid 1000, the same user as the api and worker (node), so it can read the storage volume
# whatever mode the files were created with. /backups is created here so a new named volume
# inherits this ownership.
RUN mkdir -p /backups/daily /backups/weekly \
    && chown -R 1000:1000 /backups

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod 0755 /usr/local/bin/backup.sh

USER 1000:1000
WORKDIR /backups

# Healthy while the newest daily dump is younger than 26 hours. The first dump is taken at start,
# so the start period only has to cover that.
HEALTHCHECK --interval=5m --timeout=10s --start-period=3m --retries=1 \
    CMD ["sh", "-c", "find /backups/daily -name '*.dump' -mmin -1560 | grep -q ."]

ENTRYPOINT ["/usr/local/bin/backup.sh"]
CMD ["schedule"]
