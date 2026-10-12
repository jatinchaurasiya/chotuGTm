# Medium multi-account ops (process, not code)

Target: 7+/week total across 3+ accounts (~2–3 each), adjustable.

## Rules (abuse-detection is behavioral — software can't fix it)

1. **Distinct signup details per account** (email, payment if any, profile). Never cross-link.
2. **Staggered publishing** — the content calendar enforces: no two accounts publish
   within 6h; same topic never lands on two accounts in the same week.
3. **Distinct voices** — each account has its own `VoiceProfile` (tone, examples,
   banned phrases) enforced at the SlopMonster gate. Readers + recommender notice copy-paste.
4. **Ramp gradually** — start ~1/week/account for the first month (organic history),
   then scale to 2–3. Never launch all three at full cadence day one.
5. **You paste manually** — the tool queues drafts with account labels; publishing
   times shown are suggestions, you control the actual click.

## Queue labels

Each Medium draft shows `account_ref` + suggested publish slot. The scheduler
spreads slots across the week automatically.
