# Google OAuth setup (once for the whole tool, not per workspace)

chotu reads your sites via seo-monster with **read-only** scopes only:
`webmasters.readonly` + `analytics.readonly`. No write access, no login as you anywhere.

## One-time setup

1. Google Cloud Console → new project `chotu-seo` → enable **Search Console API**
   + **Google Analytics Data API** (+ PageSpeed Insights API only if you want PSI keys).
2. OAuth consent screen → **External** → app name + your email → scopes: add the two
   read-only scopes above. Then **Publish App** (move Testing → Production) —
   otherwise refresh tokens die after 7 days and tracking silently breaks weekly.
3. Credentials → Create **OAuth Client ID, type Desktop app** → download client-secrets JSON
   to the box as `secrets/google-client.json` (never in git).
4. On the box: `uvx seo-monster auth` → browser opens → approve → token cached at
   `~/.config/seo-monster/token.json` (0600). The worker uses this token; it auto-refreshes.

## Per new workspace (2 clicks, no new OAuth)

In Search Console + GA4 UIs: add the same Google account as **Viewer** on the new
site's Search Console property and GA4 property. Done — next hourly pull includes it.

## Verify

Ops tab → doctor shows `gsc: ok`. `site_metrics` rows appear within the hour.
