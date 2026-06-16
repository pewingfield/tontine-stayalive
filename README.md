# tontine-stayalive

A small long-running watcher that performs the daily **stay-alive** check-in on
[tontine.cash](https://tontine.cash) for **your own** account. It drives a real
headless Chromium (the only way to mint the reCAPTCHA Enterprise token the
check-in requires), confirms successes to Discord, and — when the check-in fails
(as during the MSCHF server-side outage) — posts the same diagnostics you'd
gather by hand and keeps retrying.

## What it does each ET day

1. Picks `ATTEMPTS_PER_DAY` randomized times spread across the first
   `WINDOW_HOURS` of the Eastern-time day, and (optionally) fires once on start.
2. On each attempt it: opens tontine.cash → logs in → checks whether you're
   already "safe" → if not, mints a captcha token and calls `stayAlive`.
3. **Already checked in?** It does nothing and says nothing.
4. **Success?** Posts one ✅ confirmation, then stays silent the rest of the day.
5. **Failure?** Posts a throttled ⚠️ diagnostic (login / captcha / stayAlive
   statuses + a plain-English read) and keeps retrying. If a whole day ends
   unsecured it sends a 🚨 alert.

State (today's success, error throttle) lives in `/data/state.json`, so restarts
don't cause duplicate check-ins or duplicate pings.

## Running on Unraid (recommended: published image)

Once the GitHub Actions workflow has pushed the image (see below), this is the
simplest path — the image is self-contained (code + Chromium + healthcheck baked
in), so there are **no source files to copy**. You only mount `/data` and set env
vars.

- **Add Container / template:** copy `tontine-stayalive-ghcr.xml` to
  `/boot/config/plugins/dockerMan/templates-user/`, then Add Container, pick the
  template, fill in email/password/webhook, Apply.
- **Compose Manager:** paste `compose.ghcr.yml`.
- **SSH one-liner:**

```bash
mkdir -p /mnt/user/appdata/tontine-stayalive/data
docker run -d --name tontine-stayalive --restart unless-stopped \
  -p 8718:8080 \
  -e TONTINE_EMAIL='you@example.com' \
  -e TONTINE_PASSWORD='your_password' \
  -e DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/XXX/YYY' \
  -e ATTEMPTS_PER_DAY=12 -e WINDOW_HOURS=12 -e OVERTIME=true -e WATCH_STATS=true \
  -e TZ_NAME=America/New_York -e STATE_PATH=/data/state.json \
  -v /mnt/user/appdata/tontine-stayalive/data:/data \
  ghcr.io/pewingfield/tontine-stayalive:latest
```

GHCR packages are **private by default**. For Jarvis to pull anonymously, open the
package page on GitHub → *Package settings* → *Change visibility* → **Public**.
(Or keep it private and run `docker login ghcr.io` on Unraid with a PAT that has
`read:packages`.)

## Running on Unraid (from source, no image build)

If you'd rather not use CI, run the **official Playwright image** (browsers already
baked in) and bind-mount the code into it. Nothing is built on the box.

**1. Put the code in appdata.** Copy these three files into
`/mnt/user/appdata/tontine-stayalive/` (via the Unraid file manager, an SMB
share, or VS Code Remote-SSH):

```
stay-alive.js
package.json
entrypoint.sh
```

Keep that share on your cache pool, not the spinning array.

**2a. Easiest — import the template.** Copy `tontine-stayalive.xml` to
`/boot/config/plugins/dockerMan/templates-user/` on Jarvis, then in the Unraid
**Docker** tab click **Add Container**, pick `tontine-stayalive` from the
*Template* dropdown, fill in email/password/webhook, and **Apply**. Every tunable
(including `DISCORD_WEBHOOK_URL`) shows up as an editable box.

**2b. Or via SSH** (one shot, no template):

```bash
mkdir -p /mnt/user/appdata/tontine-stayalive/data
# ...copy the three files into /mnt/user/appdata/tontine-stayalive first...
docker run -d --name tontine-stayalive --restart unless-stopped \
  -w /app \
  -e TONTINE_EMAIL='you@example.com' \
  -e TONTINE_PASSWORD='your_password' \
  -e DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/XXX/YYY' \
  -e ATTEMPTS_PER_DAY=12 -e WINDOW_HOURS=12 -e OVERTIME=true \
  -e TZ_NAME=America/New_York -e STATE_PATH=/data/state.json \
  -v /mnt/user/appdata/tontine-stayalive:/app \
  -v /mnt/user/appdata/tontine-stayalive/data:/data \
  mcr.microsoft.com/playwright:v1.49.0-jammy \
  sh /app/entrypoint.sh
docker logs -f tontine-stayalive
```

**2c. Or the Compose Manager plugin:** add a new stack and paste
`compose.unraid.yml` (already uses the published image + `entrypoint.sh`, no
build).

### Changing the Discord channel later

The target channel is just the `DISCORD_WEBHOOK_URL` env var. Edit the container
in the Unraid UI (or the compose / `docker run`), paste the new channel's webhook
URL, restart. No rebuild.

## Local / non-Unraid run

```bash
cp .env.example .env   # fill in the values
npm install
npx playwright install chromium
npm start              # or: npm run once  (single immediate attempt)
```

## Health endpoint + dashboard feed (Homarr / Homepage)

The watcher serves two HTTP endpoints on `HEALTH_PORT` (mapped to host `8718` in
the examples):

- `GET /health` → `200 ok` while the process heartbeat is fresh, `503 stale`
  otherwise. This drives the Unraid health badge and works as a Homarr ping.
- `GET /status` → JSON for dashboards, e.g.

```json
{
  "service": "tontine-stayalive",
  "ok": true,
  "nowET": "2026-06-12 10:53 ET",
  "checkin": { "status": "failed", "attemptsToday": 4,
               "lastResult": "error:server-invalid-token",
               "lastError": "Stay Alive rejected a valid token...", "lastSuccessAt": null },
  "game": { "alive": 112, "safe": 0, "dead": 7029 }
}
```

**Homepage** (`services.yaml`) — custom API widget:

```yaml
- Tontine:
    icon: mdi-skull-outline
    href: https://tontine.cash
    widget:
      type: customapi
      url: http://JARVIS_IP:8718/status
      refreshInterval: 60000
      mappings:
        - field: checkin.status
          label: Check-in
        - field: game.alive
          label: Alive
        - field: game.safe
          label: Safe today
        - field: checkin.attemptsToday
          label: Attempts
```

**Homarr** — add a Ping/health-monitoring tile pointing at
`http://JARVIS_IP:8718/health` for the status dot, or a custom-API/iframe tile on
`/status` for the numbers.

## Watching alive & safe

With `WATCH_STATS=true` the watcher polls the stats endpoint every
`STATS_POLL_MIN` minutes and posts Discord alerts only on the meaningful moves:

- **`safe` 0 → >0** (once per ET day): "check-ins are registering" — the live
  signal that the stay-alive endpoint is healthy again.
- **`alive` decreases**: "players eliminated" — a purge round went through.

Routine `safe` increments and the nightly reset to 0 are ignored. `total` is not
tracked (it's frozen — entry sales are closed). Successful check-ins also include
the current `alive`/`safe` counts.

## Tuning the cadence

Everything is env-driven (see `.env.example`). The knobs you'll actually touch:

| Variable | Default | Meaning |
|---|---|---|
| `ATTEMPTS_PER_DAY` | `12` | How many randomized tries across the window. Crank it up for an obnoxious cadence. |
| `WINDOW_HOURS` | `12` | Tries are concentrated in the first N hours of the ET day. |
| `OVERTIME` | `true` | If the window ends without a check-in, keep retrying until `OVERTIME_STOP_HOUR:MINUTE` ET. |
| `OVERTIME_INTERVAL_MIN` | `20` | Overtime retry spacing (± `OVERTIME_JITTER_MIN`). |
| `ERROR_RENOTIFY_HOURS` | `3` | Don't repeat the same error to Discord more often than this. |

Changing values just needs a `docker compose up -d` (recreate); the schedule is
rebuilt at the start of each ET day and on boot.

## Continuous build (GitHub Actions → GHCR)

`.github/workflows/docker-publish.yml` builds and pushes the image to
`ghcr.io/<owner>/tontine-stayalive` on every push to `main`, on every `vX.Y.Z`
tag, and on manual dispatch. It uses the built-in `GITHUB_TOKEN` (no secrets to
configure) and needs `packages: write`, which the workflow already requests.

Tags produced:

- push to `main` → `:latest`, `:main`, `:sha-<short>`
- tag `v1.2.3` → `:1.2.3`, `:1.2`, `:latest`

After the first successful run, set the package visibility to **Public** (see
above) so Unraid can pull it without credentials, then point your container at
`ghcr.io/pewingfield/tontine-stayalive:latest`. Cut a versioned release with:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

## Keeping Playwright in lockstep

The npm `playwright` package and the `mcr.microsoft.com/playwright` base image
**must be the same version** (the image ships the browser build that the JS
package expects). `.github/workflows/bump-playwright.yml` enforces that: monthly
(and on manual dispatch) it checks npm for the latest Playwright, and if it
differs from the current pin it updates `package.json`, `Dockerfile`,
`compose.unraid.yml` and `tontine-stayalive.xml` to the **same** version and opens
one PR. Merging that PR triggers the build workflow, which republishes `:latest`.
Low churn is expected — tontine itself hasn't changed since 2021 — so most months
this is a no-op.

## Two honest caveats

- **It can't fix a server outage.** While MSCHF's `stayAlive` endpoint is
  rejecting valid tokens, this fails on schedule too — it just gives you
  visibility and grabs the moment the endpoint recovers, which a human watching
  the clock won't. The value is the retry-until-it-works loop, not magic.
- **reCAPTCHA score.** A headless datacenter browser sometimes scores low and
  the backend can reject the captcha even when everything else is correct. If
  you see persistent `captcha` or low-score errors once the server is healthy,
  route the container through a residential egress (you've got the Tailscale/VPS
  pieces for that) or run it on a residential IP.

## A note on the rules

The written Official Rules contain a generic "no automated entries" line, while
the game was marketed and is widely run as survive-by-any-means (four-plus years
with no winner is the evidence). Enforcement is entirely at MSCHF's discretion
and unknowable. This automates only your own paid entry on your own account —
your call to make with eyes open.

## Files

- `stay-alive.js` — the watcher (scheduler, browser flow, classifier, notifier).
- `Dockerfile` / `docker-compose.yml` — container build + deploy.
- `.env.example` — all configuration.
