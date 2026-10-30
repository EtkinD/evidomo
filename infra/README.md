# Evidomo production runbook (Track D)

One Linode VPS in an EU region runs the whole stack with Docker Compose: `caddy` (HTTPS), `web`, `api`, `worker`, `postgres`, and `backup`. You run every step below yourself; nothing in this repository connects to the server, to DNS, or to a secret. Architecture reference: `docs/architecture.md` section 13.

| Step                           | Task | Where            | Time                                |
| ------------------------------ | ---- | ---------------- | ----------------------------------- |
| 1. Create the Linode           | D-02 | Linode manager   | 10 min                              |
| 2. DNS records                 | D-03 | Squarespace      | 5 min + wait (5 min to a few hours) |
| 3. Provision the server        | D-02 | server, as root  | 5 to 8 min                          |
| 4. Get the code                | D-02 | server, `deploy` | 2 min                               |
| 5. Secrets (`infra/.env`)      | D-04 | server, `deploy` | 10 min                              |
| 6. First deploy                | D-05 | server, `deploy` | 10 to 15 min (cold build)           |
| 7. Verify HTTPS                | D-03 | laptop           | 5 min                               |
| 8. Demo run                    | -    | server, `deploy` | 5 min                               |
| 9. Smoke tests from the laptop | D-06 | laptop           | 2 min                               |

Plan about 1 hour of work, plus DNS propagation. Do steps 1 and 2 first and let DNS propagate while you do 3 to 5.

## 1. Create the Linode

Recommended:

- **Image:** Ubuntu 24.04 LTS (22.04 also works).
- **Region:** Amsterdam (`nl-ams`) if your first users are in the Netherlands (the demo property uses the `nl` market profile), otherwise Frankfurt (`de-fra`). Both are EU, which the GDPR stance in section 14 of the architecture requires; pick the one closer to the people who will use it.
- **Plan:** Shared CPU, **4 GB RAM / 2 vCPU / 80 GB** ("Linode 4 GB", about 24 USD a month at the time of writing; check current pricing). Reasoning: the running stack is small (about 0.4 GB idle on the local run), but the images are built on the server and `next build` peaks around 1.5 to 2 GB. A 2 GB plan would swap during builds (the script adds swap below 4 GB RAM) and a failed build during a demo is the worst moment to find that out. You can resize later, no rebuild needed.
- **Authentication:** add your SSH public key in the Linode form (root key). Set a root password too (Linode requires one; it is never used for SSH, only for the Lish console).
- **Backups add-on:** optional (about 5 USD); the `backup` service already dumps the database daily, but dumps live on the same disk. Copy one off the server before anything you cannot recreate lives there (see "Backups").
- **Private IP, VLAN, firewall (cloud):** leave off. The server runs its own `ufw`.

Note the server's public IPv4 address (`SERVER_IP` below).

No SSH key yet? On your laptop: `ssh-keygen -t ed25519 -C "evidomo"` and use `~/.ssh/id_ed25519.pub`.

## 2. DNS at Squarespace (D-03)

Pick the canonical host. **Recommendation: the apex (`evidomo.example`) is the site and `www` redirects to it.** The session cookie is host-pinned (`__Host-`), so serving two hosts would give each its own login; `APP_ORIGIN` is one origin. Caddy does the redirect (`WWW_ADDRESS`).

In Squarespace: Domains, choose the domain, DNS, DNS settings (the labels can differ slightly). Add:

| Type | Host  | Data        | TTL                    |
| ---- | ----- | ----------- | ---------------------- |
| A    | `@`   | `SERVER_IP` | lowest offered (5 min) |
| A    | `www` | `SERVER_IP` | lowest offered (5 min) |

- Delete any record Squarespace pre-created for the same host (Squarespace-site defaults: other `A` records on `@`, a `CNAME` on `www`). An old record next to yours sends some visitors elsewhere and breaks the certificate.
- **Create no `AAAA` records for now.** Docker publishes IPv6 ports through a userland proxy that hides the client address, so every IPv6 visitor would share one rate-limit bucket in the API. Add `AAAA` later only after you have checked how Caddy sees IPv6 clients.
- If the domain has `CAA` records, they must allow `letsencrypt.org` (`0 issue "letsencrypt.org"`).

Check propagation (from your laptop; repeat until both answer `SERVER_IP`):

```sh
dig +short A evidomo.example @1.1.1.1
dig +short A www.evidomo.example @8.8.8.8
dig +short A evidomo.example                 # your own resolver; may lag behind
```

Caddy requests the certificate on first start, and Let's Encrypt must reach the server on port 80 for the domain you named. **Do not run step 6 before the first two commands answer `SERVER_IP`**; a failed attempt makes Caddy back off and Let's Encrypt limits repeated failures.

## 3. Provision the server (D-02)

From your laptop, in a checkout of this repository:

```sh
scp infra/provision/provision.sh ~/.ssh/id_ed25519.pub root@SERVER_IP:/root/
ssh root@SERVER_IP
bash provision.sh --ssh-key-file /root/id_ed25519.pub
```

The script (idempotent; run it again if it stops halfway): unattended security updates (reboots at 03:30 UTC if a kernel update needs it; `--no-auto-reboot` disables that), Docker Engine and the compose plugin from Docker's apt repository (the signing key's fingerprint is pinned), user `deploy` in the `docker` group with your key and no password, root login and password logins disabled in sshd, `ufw` allowing only 22 (rate limited), 80, and 443 (tcp, plus udp for HTTP/3), fail2ban on sshd, swap below 4 GB RAM, and NTP.

It ends with a checklist (`ok:` / `FAIL:` per item). **Before you log out of root, open a second terminal and run `ssh deploy@SERVER_IP`.** Once that works, close the root session. If you locked yourself out, use the Lish console in the Linode manager.

Important about the firewall: Docker publishes ports through its own iptables rules, which `ufw` does not filter. The stack is only safe because `infra/compose.yaml` publishes nothing except caddy's 80 and 443 (postgres, api, web, and worker have no `ports:`). Do not add a `ports:` entry to another service; `infra/deploy.sh` fails the deploy if any non-caddy container publishes a host port.

## 4. Get the code

```sh
ssh deploy@SERVER_IP
git clone https://github.com/EtkinD/evidomo.git ~/evidomo
cd ~/evidomo
```

The repository is public, so a read-only HTTPS clone needs no deploy key. To deploy a tag, `infra/deploy.sh v0.6.0` checks it out; with no argument it fast-forwards the current branch (`main`).

## 5. Secrets (D-04)

On the server, as `deploy`:

```sh
cd ~/evidomo
install -m 600 infra/.env.example infra/.env   # copy created with mode 600
nano infra/.env
ls -l infra/.env                               # expect: -rw------- 1 deploy deploy
```

Fill in every variable (the file explains each one). The ones that matter first:

| Variable                                | Value                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `SITE_ADDRESS`                          | `evidomo.example` (your apex, bare)                                             |
| `WWW_ADDRESS`                           | `www.evidomo.example`                                                           |
| `APP_ORIGIN`, `NEXT_PUBLIC_SITE_ORIGIN` | `https://evidomo.example` (both, identical)                                     |
| `POSTGRES_PASSWORD`                     | `openssl rand -hex 32` (run it, paste the output)                               |
| `LIVE_RUN_ACCESS_CODE`                  | `openssl rand -base64 18`; share it only with people allowed to start live runs |
| `MODEL_API_KEY`                         | your Meta Model API key (reaches `api` and `worker` only)                       |
| `DAILY_BUDGET_USD`                      | for example `10.00`                                                             |
| `RUN_COSTS_VISIBLE`                     | leave **empty** (costs hidden from browsers)                                    |
| `DEMO_RUN_IDS`                          | leave empty until step 8                                                        |
| `HSTS_MAX_AGE`                          | leave `300` for now                                                             |

Type the model key into the editor; do not put it on a command line (shell history). Never copy `infra/.env` off the server or into a chat. `.env` files are git-ignored; `infra/deploy.sh` refuses to run if the file is readable by group or others, or owned by someone else, and compose refuses to start without the database password and the access code.

Where each secret goes (enforced by `compose.yaml`, which passes variables explicitly, never with `env_file:`): `MODEL_API_KEY` to `api` and `worker`; `LIVE_RUN_ACCESS_CODE` to `api`; the database password to `postgres`, `api`, `worker`, and `backup`; `web` and `caddy` receive none. `NEXT_PUBLIC_SITE_ORIGIN` is not a secret: it is a build argument of the web image.

## 6. First deploy (D-05)

```sh
cd ~/evidomo
infra/deploy.sh --dry-run    # checks only: env file, compose config, git
infra/deploy.sh
```

The script, in order: checks the environment, fast-forwards or checks out the target, builds the images (running containers are untouched), starts postgres and applies migrations with the `migrate` image, switches the services with health checks, runs the smoke check through Caddy (`/api/healthz`, `/`, `/favicon.svg`, `/api/demo/runs`, and that only caddy publishes host ports), and prints a rollback hint. If a build or migration fails, nothing running is touched. If the switch or the smoke check fails, the previous images and checkout are restored automatically (the first deploy has nothing to restore; read the logs).

Rollback by hand: `infra/deploy.sh <previous tag or commit>` (the hint at the end of each deploy). Migrations are forward-only: a rollback keeps the migrated database, so keep migrations backward compatible with the previous release.

Logs: `docker compose -p evidomo-prod -f infra/compose.yaml --env-file infra/.env logs --tail 100 -f caddy api`.

## 7. Verify HTTPS (D-03)

```sh
curl -sI https://evidomo.example | head -20            # 200, plus the security headers
curl -sI http://evidomo.example | grep -i '^location'  # redirects to https
curl -sI https://www.evidomo.example | grep -i '^location'   # https://evidomo.example/
openssl s_client -connect evidomo.example:443 -servername evidomo.example </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates        # issuer Let's Encrypt, valid dates
```

Also open the site in a browser and register a test account (the session cookie is `Secure`, so this proves HTTPS end to end). From your laptop, confirm that nothing else is reachable: `nmap -Pn -p 22,80,443,3000,4000,5432 SERVER_IP` shows 22, 80, 443 open and the rest closed or filtered.

Headers Caddy adds (`infra/caddy/Caddyfile`): `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options: SAMEORIGIN` (the pack preview is a same-origin iframe), `Permissions-Policy` (microphone for the voice recorder only), and `Strict-Transport-Security`.

**HSTS:** it starts at 300 seconds so a mistake expires quickly. After the site has worked over HTTPS for a day (and `www` redirects correctly), set `HSTS_MAX_AGE=31536000` in `infra/.env` and run `infra/deploy.sh` (or `docker compose ... up -d caddy`). Do not add `includeSubDomains` or `preload` without a reason.

**Content-Security-Policy is deferred**, deliberately. Next.js (Pages Router) emits inline scripts that need per-request nonces or hashes, `_document.tsx` adds the theme script (`THEME_INIT_SCRIPT`), and React sets inline `style` attributes. A static CSP in Caddy would either be so loose (`'unsafe-inline'`) that it adds little, or it would break pages, and it cannot be verified without running through every page in a browser. The proper route is a Next middleware that sets a nonce-based CSP, tested in Report-Only first; it is a separate task. The theme script already documents that it can be allowed by hash.

If the certificate does not appear: `docker compose ... logs caddy | grep -i -E "error|obtain"`. The usual causes are DNS not pointing at the server yet, port 80 blocked, or a stale `AAAA` record. To rehearse without Let's Encrypt rate limits, set `ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory`, deploy, check that Caddy obtained a (browser-untrusted) certificate, then clear `ACME_CA`, run `docker compose -p evidomo-prod -f infra/compose.yaml --env-file infra/.env stop caddy`, `docker volume rm evidomo-prod_caddy-data`, and deploy again.

## 8. Demo run

Zero model calls; it replays the committed synthetic fixtures through the real pipeline. After the first deploy (migrations applied):

```sh
cd ~/evidomo
docker compose -p evidomo-prod -f infra/compose.yaml --env-file infra/.env --profile tools run --rm --build demo-seed
```

It prints `DEMO_RUN_IDS=<uuid>`. Put that in `infra/.env` (comma-separated if you keep several), then recreate the api so it re-reads the file (`restart` would not):

```sh
nano infra/.env
docker compose -p evidomo-prod -f infra/compose.yaml --env-file infra/.env up -d --wait api
curl -s https://evidomo.example/api/demo/runs
```

Every listed run is public without login, in full. Only runs printed by `demo-seed` (synthetic data) belong there. Re-seeding creates a new run; remove old IDs from the list.

## 9. Production smoke test (D-06)

From your laptop, in the repository (once: `npm ci --ignore-scripts && npx playwright install chromium`):

```sh
E2E_BASE_URL=https://evidomo.example npx playwright test
```

With `E2E_BASE_URL` set, Playwright starts no local servers. The specs that run against production: `e2e/smoke.spec.ts` (landing page) and `e2e/demo.spec.ts` (public demo pages: header link, landing link, a not-published run answers "not found"). All of them only read. `auth`, `projects`, and `capture` specs skip themselves because they create accounts and projects (`test.skip` on `E2E_BASE_URL`). Nothing needs a seeded database; with a demo run published, the demo list test just sees the run. The same command against a local run of the production stack: `E2E_BASE_URL=http://localhost:8080`.

## Backups and restore

The `backup` service runs next to the stack. At start (if the newest backup is older than 24 hours) and daily at `BACKUP_AT` (UTC, default 03:15) it writes, into the `backups` volume:

- `daily/evidomo-<timestamp>.dump`: `pg_dump --format=custom` (compressed), validated with `pg_restore --list`;
- `daily/storage-<timestamp>.tar.gz`: the uploaded files and artifacts (the database rows point at these files, so both belong together).

Retention: the newest 7 daily sets, plus a copy of each Sunday's set kept as the newest 4 weekly sets.

```sh
infra/restore.sh list                     # what exists
docker compose -p evidomo-prod -f infra/compose.yaml --env-file infra/.env run --rm --no-deps backup run   # a backup now
```

**Restore** (destructive; visitors get errors from the API for a minute or two):

```sh
cd ~/evidomo
infra/restore.sh latest                   # or daily/evidomo-<timestamp>.dump, weekly/...
```

It asks you to type the database name, takes a safety backup of the current state, stops `api` and `worker`, drops and recreates the database from the dump, replaces the storage volume with the matching archive, starts the services, and smoke checks. `--no-storage` restores the database only; `--yes` skips the question.

**Backups sit on the same disk as the data.** They protect against mistakes and bad deploys, not against losing the server. Before real customer data arrives, get a copy off the server: enable the Linode Backups add-on, or pull a set out of the volume, for example `docker run --rm -v evidomo-prod_backups:/b:ro alpine tar -C /b -cz daily | ssh you@laptop 'cat > evidomo-backups.tgz'`. Rehearse a restore on a throwaway stack now and then (see the last section).

## Day to day

| Task                       | Command                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| Deploy the latest `main`   | `infra/deploy.sh`                                                                |
| Deploy or roll back to ref | `infra/deploy.sh v0.6.0` (tag, branch, or commit)                                |
| Change a setting           | edit `infra/.env`, then `infra/deploy.sh` (or `docker compose ... up -d --wait`) |
| Status                     | `docker compose -p evidomo-prod -f infra/compose.yaml --env-file infra/.env ps`  |
| Disk                       | `df -h /` and `docker system df`                                                 |

`NEXT_PUBLIC_SITE_ORIGIN` is baked into the web image: changing it needs a rebuild, which `infra/deploy.sh` does.

## Testing the production stack on a laptop

Use a throwaway project, image prefix, and host ports so nothing collides with the dev servers or database:

```sh
export ENV_FILE=/path/to/test.env COMPOSE_PROJECT_NAME=evidomo-try IMAGE_PREFIX=try   # outside the repo, mode 600
# in test.env: SITE_ADDRESS=:80  HTTP_PORT=8080  HTTPS_PORT=8443  APP_ORIGIN=http://localhost:8080
#              NEXT_PUBLIC_SITE_ORIGIN=http://localhost:8080  plus dummy POSTGRES_PASSWORD, MODEL_API_KEY,
#              LIVE_RUN_ACCESS_CODE, DAILY_BUDGET_USD
infra/deploy.sh
```

Remove it with `docker compose -p evidomo-try -f infra/compose.yaml --env-file "$ENV_FILE" down -v`.
