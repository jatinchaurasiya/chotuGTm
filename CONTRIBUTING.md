# Contributing to chotu (MIT)

## Agent lanes

15 subagents own exclusive paths — see `AGENTS.md`. Cross-lane edits go through
`senior-lead`. Reviewers (`senior-lead`, `docs-reviewer`) are read-only.

## Rules for every change

- Idempotent jobs (key by opportunity/draft/post id; pre-check before LLM spend).
- Retry-with-backoff on all external calls; exhaust → `failed_jobs`, never silent.
- Skip-on-block for fetches (403/login-wall = skip, never defeat).
- RLS on all tables; `service_role` server-only; no secrets in git (gitleaks hook).
- Attribution labeled directional; UTM-exact vs inferred recorded per row.

## Local dev

```bash
cp .env.example .env  # fill, never commit
npm install && npx tsc --noEmit
npm test
```

Keep PRs small, one lane per PR, with the lane's Done gate evidence attached.
