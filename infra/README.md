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

**Publishing a live run.** The demo API serves a listed run only if its project belongs to the demo account (`demo-replay@evidomo.invalid`, created by `demo-seed`); a customer's run listed by mistake stays 404. A live run qualifies only when every input is invented or freely licensed (no real address, person, or voice) and you accept that photos, recording, transcript, decisions, and pack become public. Move its project to the demo account (it leaves your own project list; storage keys depend on the project, not the owner), then list the run ID as above:

```sh
docker compose -p evidomo-prod -f infra/compose.yaml --env-file infra/.env exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -v run=<run-id>' <<'SQL'
begin;
-- Before: the project and its current owner (keep this to move it back).
select p.id as project_id, u.email as owner from runs r
  join projects p on p.id = r.project_id join users u on u.id = p.owner_id where r.id = :'run';
update projects set owner_id = (select id from users where email = 'demo-replay@evidomo.invalid')
  where id = (select project_id from runs where id = :'run' and status = 'completed')
    and exists (select 1 from users where email = 'demo-replay@evidomo.invalid');
-- Expect "UPDATE 1". On "UPDATE 0" (unknown or unfinished run, no demo account) nothing changed.
commit;
SQL
```

## 9. Production smoke test (D-06)

From your laptop, in the repository (once: `npm ci --ignore-scripts && npx playwright install chromium`):

```sh
E2E_BASE_URL=https://evidomo.example npx playwright test
```

With `E2E_BASE_URL` set, Playwright starts no local servers. The specs that run against production: `e2e/smoke.spec.ts` (landing page) and `e2e/demo.spec.ts` (public demo pages: header link, landing link, a not-published run answers "not found"). All of them only read. `auth`, `projects`, and `capture` specs skip themselves because they create accounts and projects (`test.skip` on `E2E_BASE_URL`). Nothing needs a seeded database; with a demo run published, the demo list test just sees the run. The same command against a local run of the production stack: `E2E_BASE_URL=http://localhost:8080`.

## Sizing, limits, and replicas

Every service has a CPU and memory limit, and `web` can run several copies. Both come from `infra/.env` (the "Resources and replicas" block of `infra/.env.example`); the defaults fit the documented minimum host (4 GB RAM, 2 vCPU).

**Sizing rule.** Add up the limits of everything that runs all the time (caddy, web, api, worker, postgres, backup; `replicas x limit` for web). The sum of CPUs and the sum of memory must each stay at or below **80% of the host**. The other 20% is for the operating system, ssh, and above all for builds: `infra/deploy.sh` builds on the server and `next build` peaks near 2 GB of RAM, while the running stack normally uses far less than its limits (the limits are ceilings). `infra/deploy.sh` prints the sum and warns when it is over (it reads the host size from `docker info`); the check needs `python3`, which Ubuntu has. The one-off `tools` services (migrate, demo-seed) have their own small limits and are not counted.

To size a bigger host: take 80% of its vCPU and RAM, give the api, worker, and postgres what the load needs, and spend the rest on `WEB_REPLICAS` (each copy is single threaded, so about one vCPU of limit per copy is the useful ceiling). Apply with `infra/deploy.sh` or `docker compose ... up -d --wait`.

**Why the api and the worker are single instances.** The api keeps its rate limits (login, registration, run starts, the public demo API per IP) and the open replay-stream cap per IP in process memory. Every extra api copy would multiply each of them, and a client could land on a fresh counter on every request. A local run measured the api at about a quarter of one core at 200 simulated visitors, so one Node thread should carry several hundred; the server's load test (below) is what shows whether it is the first bottleneck. Only if it is, a shared limiter store (a table or Redis, and a change to every limiter) is worth its cost. The worker is single because it is the only place model spend is paced; its concurrency is a pipeline setting, not a replica count. `web` has no state (static pages, no sessions, no in-process cache), so it scales freely.

**Database connections** at the shipped shape: api pool 10 plus pg-boss 10, worker pool 10 plus pg-boss 10, backup 1, plus a one-off `migrate` or `demo-seed` at deploy time: at most 42 of PostgreSQL's default 100 (`max_connections`). Web copies do not connect to the database. If you ever run more than one api, multiply the api's 20.

**Node memory.** Node sizes its heap from the container's memory limit, so no `--max-old-space-size` is set; the limits above leave room for the heap plus buffers (sharp and ffmpeg in the worker). If a container is killed for memory (`docker inspect <container> --format '{{.State.OOMKilled}}'`), raise its `*_MEMORY` and recheck the 80% rule.

**How Caddy finds the copies.** `infra/caddy/Caddyfile` uses `dynamic a` for `web`: Caddy reads every address behind the service name (refreshed each second), balances with `least_conn`, and retries a request on another copy for up to 5 seconds when one is down. A static `web:3000` would lean on Docker's DNS shuffling per new connection. Active health checks do not run for dynamic upstreams; docker's own healthcheck and `up --wait` cover that. The api route retries the connection for up to 10 seconds in the same way, so a deploy or restart of the single api shows visitors a slow request instead of a 502. Checked on a local run with 2 web copies and constant traffic: restarting, killing (the restart policy brings it back), and force-recreating web copies, and recreating the api, produced no failed requests; the slowest request during those events took 1 to 3 seconds.

Check it on a running stack:

```sh
docker compose -p evidomo-prod -f infra/compose.yaml --env-file infra/.env ps web
docker stats --no-stream      # per container CPU and memory against the limits
```

## Load test (D-08)

A repeatable test of the public, read-only surface with [k6](https://k6.io) in Docker (`grafana/k6`, pinned to an exact version in `infra/load/run.sh`; nothing is installed). It ramps concurrent visitors in steps (default 50, 100, 250, 500, 750, 1000, 2 minutes each plus a 30 second ramp) and reports the first step whose p95 latency or error rate crosses the thresholds (default: p95 above 1 s, errors above 1%), or "1,000 passed".

What each visitor does (GET only; no registration, login, project, live run, or POST): views a page with 1 to 4 seconds of think time in between (landing `/` 20%, `/tr` 10%, `/method` 10%, `/demo` 15% plus its API call, a demo run page 35% plus its snapshot call, `/api/healthz` 10%); 20% of the page views also download the page's scripts, styles, and fonts as a first-time visitor would; and 10% of the visitors watch the demo replay stream (`/api/demo/runs/<id>/events?speed=...`, about 11 seconds, 16 KB) in a loop. The demo run comes from `GET /api/demo/runs`, so a demo run must be published (step 8). All settings (steps, hold time, thresholds, shares) are listed at the top of `infra/load/evidomo.js`.

**1. Raise the per-IP demo limits for the window.** The test sends all traffic from one address, and the demo API allows 2000 requests per 15 minutes and 3 replay streams per address, so without this it measures the limiter. In the server's `infra/.env` set `DEMO_REQUESTS_PER_IP_PER_15_MIN=10000000` and `DEMO_STREAMS_PER_IP=1000`, then `docker compose -p evidomo-prod -f infra/compose.yaml --env-file infra/.env up -d --wait api`. **Empty both again afterwards** and recreate the api. As a second guard the report counts 429 responses separately (left out of the error rate) and prints a warning when there were any: such a run says nothing about the routes that were limited.

**2. Watch the server.** On the server, in a second terminal (Linux only; stop it with Ctrl-C to get the peak):

```sh
infra/load/watch-host.sh 5        # host CPU and RAM plus per-container usage every 5 s, with the peak at the end
```

**3. Run the test** from a machine that is not the server, with Docker, a wired or datacenter connection, and `data/load/` free (reports are git-ignored):

```sh
infra/load/run.sh https://evidomo.example                   # the full ramp, about 17 minutes
infra/load/run.sh https://evidomo.example STEPS=50,100 HOLD=30s RAMP=10s     # a short rehearsal
infra/load/run.sh https://evidomo.example STOP_AT_FIRST_FAIL=1              # stop the ramp at the first failing step
```

The report (`data/load/load-<time>.txt` and `.json`) has one row per step: requests per second, p95 and p99 latency, time to first byte, client-side blocking, error rate, 429 count, decoded body volume, and the stream's time to first byte. Keep it, with the peak from step 2, outside git. Do not run it while a deploy or backup runs; do not run it without telling anyone who uses the site.

**Single-source caveat: is the client or the server the bottleneck?** One machine generates all load, so its own limits can show up as "server" failures.

- Client signs: `blocked95` climbs while `ttfb95` stays flat (requests wait for a free local socket); the Mbit/s column plateaus while VUs grow (your uplink or downlink is full: a first-time page view is about 0.9 MB of assets, so lower `COLD_SHARE` before suspecting the server); k6 prints `too many open files` or dial errors; `docker stats` on the k6 machine shows its container near 100% of a core per 250 VUs or more, or the machine is swapping. Fix: a stronger client, `COLD_SHARE=0.05`, or running k6 on two machines with half the steps each.
- Server signs: `ttfb95` grows together with p95, `watch-host.sh` shows host CPU near 100% or a container at its limit, errors are 502/503/504 from Caddy.
- Also expected: the server's network allowance (bandwidth, packets per second) can be the limit before CPU is; the host log will then show idle CPU with falling throughput.
- The result is for one source address and the path between the two machines. It says what the stack serves for visitors on a good connection, not how it handles thousands of different addresses.

Numbers from a laptop (Docker Desktop) do not predict the server; use the local run only to check that the script and the reporting work.

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

## Continuous deployment (D-09)

A push to `main` deploys that commit, and a `vX.Y.Z` tag deploys the tag, once lint, tests, the image builds, and e2e pass (`deploy` job in `.github/workflows/ci.yml`). The job connects with its own SSH key, which can run only `infra/cd/ssh-deploy.sh` on the server. Design and threat model: `docs/architecture.md` section 13.

Set it up once. Nothing below goes into the repository; keep every value out of issues, commits, and chat.

1. **A dedicated key** (on your laptop, in a temporary folder):

   ```sh
   ssh-keygen -t ed25519 -N '' -C evidomo-cd -f evidomo-cd
   ```

2. **Restrict it on the server.** Append one line to `~/.ssh/authorized_keys` of the account that runs deploys. Use the absolute path of the checkout and the contents of `evidomo-cd.pub`:

   ```text
   restrict,command="/absolute/path/to/evidomo/infra/cd/ssh-deploy.sh" ssh-ed25519 AAAA... evidomo-cd
   ```

   `restrict` turns off the shell's PTY and every kind of forwarding; `command=` makes the deploy script the only thing this key can run, whatever the client asks for.

3. **The server's host key**, so the job refuses any other machine: on the server, `cat /etc/ssh/ssh_host_ed25519_key.pub` and copy the first two fields (`ssh-ed25519 AAAA...`).

4. **GitHub environment.** Repository Settings → Environments → New environment `production`:
   - Deployment branches and tags: **Selected branches and tags**, add the branch `main` and the tag pattern `v*`.
   - Optional: Required reviewers, if every deploy should wait for your click.
   - Environment secrets: `DEPLOY_SSH_KEY` (the whole private key file `evidomo-cd`), `DEPLOY_SSH_HOST_KEY` (step 3), `DEPLOY_SSH_HOST` (address or domain), `DEPLOY_SSH_USER`, and `DEPLOY_SSH_PORT` only if SSH does not listen on 22.

5. **Turn it on:** Settings → Secrets and variables → Actions → Variables → New repository variable `DEPLOY_ENABLED` = `true`. Without it the job is skipped; set it to anything else to pause CD. A manual run of the CI workflow on `main` (Actions → CI → Run workflow) deploys main's head, or answers that it is already deployed.

6. **Check the restriction** from your laptop; both must be refused:

   ```sh
   ssh -i evidomo-cd <user>@<host> 'deploy main'
   ssh -i evidomo-cd <user>@<host> 'id'
   ```

   Then delete `evidomo-cd` and `evidomo-cd.pub` from the laptop. To revoke the key, remove its line from `authorized_keys`.

**Day to day:** the job's log shows the deploy stages and the result only (Actions logs of a public repository are public). The full output of each deploy is on the server in `~/evidomo-deploy-logs/`. A commit older than the deployed one is refused; roll back by hand with `infra/deploy.sh <tag or commit>`. After a CD deploy the checkout is a detached HEAD, so deploy the latest `main` by hand with `infra/deploy.sh main` instead of `git pull`.

## Day to day

| Task                       | Command                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| Deploy the latest `main`   | `infra/deploy.sh main` (after CD, HEAD is detached, so not `git pull`)           |
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
