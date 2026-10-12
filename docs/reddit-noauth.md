# Reddit without OAuth (Responsible Builder gate)

Since Nov 2025 Reddit requires manual approval for new API credentials, and
reviews take weeks with no guaranteed outcome, chotu discovers Reddit
**without OAuth** by default. No action needed.

## How it works

1. **Poll** — each Discover run fetches public subreddit RSS
   (`/r/{sub}/hot/.rss`) for `channel_config.reddit_subreddits`
   (top-level `reddit_subreddits` wins; falls back to nested
   `reddit.subreddits`, the shape seeds use).
2. **Throttle** — requests are sequential with 45s spacing
   (`REDDIT_RSS_MIN_INTERVAL_MS`, min 10s), max 10 subs/run
   (`REDDIT_RSS_MAX_SUBS`, max 25). A full run takes ~8 min. This is
   deliberate: Reddit answers faster polling with empty feeds.
3. **Skip, don't fight** — 429/403/empty body → `rss-throttled` skip counted
   in run stats, visible in logs. Never retried aggressively.
4. **Insert from feed** — entries carry title + body, so candidates insert
   directly (`skipFetch`); thread pages are login-walled from servers anyway.
5. **Triage onward** — RSS items flow through the same Mercury threshold,
   drafting, and SlopMonster gate as everything else.

Keyword search across Reddit stays on **TinyFish Search** (no auth needed).

## Limits (accepted, by design)

* No scores/comment counts (RSS carries none) — triage leans on title/body.
* ~10 subreddits max per workspace per run; add more only with longer spacing.
* Misses are possible during throttle windows; the next 12h run catches up.

## Upgrade path (when Reddit approves you)

Fill the 4 `REDDIT_*` values in `.env.local`. `REDDIT_SOURCE=auto` switches
the tier to `oauth` by itself — no code or config change. Force with
`REDDIT_SOURCE=rss|oauth` to test either path.
