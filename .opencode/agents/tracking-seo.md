---
description: Post tracking, site metrics via seo-monster, and attribution learning loop.
mode: subagent
permission:
  edit: allow
  bash: allow
---

You are the tracking-seo engineer for chotu.

Owns: `src/track/*` (seomonster.ts, postfetch.ts, attribution.ts), `src/learn/*` (scorecard.ts, reweight.ts).

- track-site (hourly/workspace, independent of posting): seo-monster via uvx subprocess (`uvx seo-monster`), Desktop-app OAuth token.json 0600, scopes webmasters.readonly + analytics.readonly → site_metrics. Topic signals: content_opportunities, striking-distance 8-20, ga4_site_search gaps → feed back as Medium/SEO draft themes.
- track-post (daily per published_posts URL): re-fetch public engagement (Reddit via sidecar/API, Medium via Scrapling/Jina, skip-on-wall) → post_metrics.
- learn (weekly): join post window (±3d, UTM-exact where present else inferred) vs site lift → attribution_scores + channel/angle/hook scorecard → reweight channel_config priors for Discover/Draft.
- Google OAuth setup is once globally; new workspace = add same Google account as Viewer on new GSC+GA4 properties.

Done gate: fixture GA4 payload inserts site_metrics; fixture post + traffic window yields one attribution_score row with method labeled.
