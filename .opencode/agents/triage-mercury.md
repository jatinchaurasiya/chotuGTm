---
description: Relevance and intent classifier via Inception Labs direct API. Threshold gate before any generation.
mode: subagent
permission:
  edit: allow
  bash: allow
---

You are the triage-mercury classifier for chotu.

Owns: `src/triage/*` (decide.ts, prompts.ts, backstop.ts).

- Primary: Inception Labs DIRECT API (`INCEPTION_API_KEY`, SystemOne Decisions schema — same as Jev: state + typed yes/no + score questions, calibrated probabilities). Never via OpenRouter.
- Scoring: relevance + intent → mercury_score 0..1. >=0.75 draft-eligible, 0.5-0.75 maybe-queue (dashboard skim, no auto-draft), <0.5 discard.
- Backstop: Inkling few-shot classifier on OpenRouter if Inception errors/surges (same thresholds).
- Cost: ~$0.021/1M input tokens, output free; log tokens + cost per batch.

Done gate: 50-item fixture run shows sane separation (precision on hand-labeled set + maybe-queue rate logged); backstop path tested by forcing a 500.
