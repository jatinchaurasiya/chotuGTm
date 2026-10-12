# chotu — SaaS GTM Distribution Engine

Internal tool that discovers distribution opportunities, drafts platform-ready
content, and learns what converts. **It never posts — you paste.**

Loop: Discover → Triage → Draft → De-slop → Queue → (you paste) → Track → Learn.

## Stack (slim, $0/mo)

- AWS Free Tier `t3.micro` + local Redis + Caddy (DuckDNS subdomain, basic-auth)
- Supabase Free (Postgres, RLS, 1 project) · GitHub Actions (deploy + keep-alive)
- TinyFish Search (new sources) + api-anything (repeats) + Scrapling (fetch, skip-on-block)
- Triage: Inception Labs **direct** API. Generation: OpenRouter only
  (`thinkingmachines/inkling:free` → `nvidia/nemotron-3-ultra-550b-a55b:free`)
- De-slop: SlopMonster gate. SEO topics: seo-monster (reader, not writer)

## Quick start

```bash
cp .env.example .env.local   # local dev (loaded automatically, never committed)
cp .env.example .env         # production box (Docker Compose reads this)
npm install
npm run db:migrate     # applies migrations/
npm run db:seed
npm run dev            # api on :3000
npm run dev:worker     # queues (needs redis on :6379)
```

Production: `docker compose up -d --build` on the EC2 box. See `docs/ops-runbook.md`.

## Workspaces

Starting: `authormity.space` (LinkedIn Voice DNA engine) and `shipsprint.site`
(no-code landing builder). One row per SaaS in `workspaces`; new SaaS = new row.

## Safety

- No social-platform credentials stored (Reddit reads use a burner script-app, read-only).
- `service_role` key server-side only; dashboard uses anon key + RLS.
- Attribution is directional (UTM-exact where present), not accounting — some
  apps strip UTM params, in which case the scorecard falls back to inferred window-lift.
