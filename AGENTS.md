# AGENTS.md — chotu build contract

15 subagents in `.opencode/agents/`. File ownership is exclusive:

- senior-lead: sequencing + gates (no code)
- repo-architect: initial skeleton of compose/Caddy/env/CI (infra-docker-aws owns them after)
- database-supabase: migrations/*, src/db/*
- backend-api: src/api/*
- worker-jobs: src/queue/*, src/worker.ts
- discover-scraper: src/discover/*
- triage-mercury: src/triage/*
- draft-llm: src/draft/*
- deslop-quality: src/deslop/*
- frontend-queue: dashboard/app/queue/*, dashboard/components/*
- frontend-scorecard: dashboard/app/scorecard/*, dashboard/app/ops/*
- tracking-seo: src/track/*, src/learn/*
- infra-docker-aws: compose/Dockerfile/Caddy/workflows/docs/ops-runbook.md
- qa-e2e: tests/*
- docs-reviewer: README/CONTRIBUTING/docs/* except docs/ops-runbook.md (proposes, lead applies)

Rules: idempotent jobs, retry-with-backoff everywhere, dead-letter to
failed_jobs, skip-on-block for fetches (never defeat login walls), RLS on all
tables, no secrets in git, attribution labeled directional.
