# Ops runbook — chotu on AWS Free Tier t3.micro

## Box setup (once)

```bash
# 4GB swap (mandatory on 1GB box) — idempotent, safe to re-run:
sudo bash scripts/provision-swap.sh
free -h  # verify /swapfile present

# DuckDNS: pick yourname.duckdns.org, point A record at Elastic IP.
# SITE_HOST, DASHBOARD_USER, DASHBOARD_HASH go in .env (see .env.example).
# Caddy hash: docker run --rm caddy:2-alpine caddy hash-password
```

## Deploy

Push to `main` → GitHub Actions SSH deploys (`/opt/chotu`: pull, build,
`docker compose up -d --build`, migrate). First time:

```bash
sudo mkdir -p /opt/chotu && sudo chown $USER /opt/chotu
git clone <repo> /opt/chotu && cd /opt/chotu
cp .env.example .env && $EDITOR .env
docker compose up -d --build && docker compose exec -T app node scripts/migrate.js
```

## Daily ops

- Dashboard: `https://<SITE_HOST>` (basic-auth, phone OK). Queue tab = copy/paste work.
- Ops tab = doctor status (incl. `recent_errors` — anything that couldn't reach
  `failed_jobs`) + failed_jobs + retry button. Attribution is directional: some
  apps strip UTM params, so unmatched windows fall back to inferred lift.
- Logs: `docker compose logs --tail=200 app|redis|caddy` (JSON driver rotates 10m x3).
- UptimeRobot: monitor `https://<SITE_HOST>/health` (expect `{"ok":true}`).

## Incidents

| Symptom | Fix |
|---|---|
| OOM / app restarts | `free -h`, check swap on; lower discover concurrency to 1; redis capped 256mb |
| Queue stuck | `docker compose exec -T redis redis-cli LLEN ...` or retry from Ops tab; poison rows land in `failed_jobs` |
| Supabase paused (1wk idle) | keepalive workflow pings twice weekly; manual: open dashboard SQL editor |
| GSC token expired | consent screen must be Production (7-day Testing expiry); re-run `uvx seo-monster auth` on box |
| 429 OpenRouter | worker backs off proactively; check Ops doctor for budget; drafts resume next cycle |

## Alarms (5-min, free)

- Billing: CloudWatch Console (us-east-1) → Billing → Alarms → create alarm on
  EstimatedCharges USD > 1, notify SNS email. No CLI needed.
- UptimeRobot (free): HTTP(s) monitor on `https://<SITE_HOST>/health` (basic-auth
  user/pass in monitor settings), 5-min interval, alert email.

## Backup / restore

Supabase daily backups (Free: last daily). PITR is a paid add-on — accepted risk;
content history also lives in git-tracked seeds + published URLs. Full DB export
monthly: `pg_dump $SUPABASE_DB_URL > /tmp/chotu-$(date +%F).sql` (store off-box).
