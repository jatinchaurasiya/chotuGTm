-- chotu migration 002_seed
-- Starter workspaces: authormity.space + shipsprint.site with channel_config.
-- Idempotent: fixed UUIDs + ON CONFLICT (id) DO UPDATE.
--
-- Apply: psql "$SUPABASE_DB_URL" -f migrations/002_seed.sql
--        or: npm run db:seed   (see scripts/seed.js)

insert into public.workspaces (id, name, site_url, voice_config, icp_doc, channel_config, medium_accounts)
values
  (
    '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
    'Authormity',
    'https://authormity.space',
    '{"tone": "direct, practitioner, no hype", "formats": ["linkedin-post", "reply"]}'::jsonb,
    'Authormity: LinkedIn Voice DNA engine. ICP: founders and ghostwriters who want posts that sound like them.',
    '{
      "linkedin": {"enabled": true, "account_refs": ["primary"], "daily_cap": 2},
      "x": {"enabled": true, "account_refs": ["primary"], "daily_cap": 3},
      "reddit": {"enabled": true, "subreddits": ["SaaS", "Entrepreneur"], "daily_cap": 2},
      "medium": {"enabled": false, "account_refs": [], "daily_cap": 0}
    }'::jsonb,
    '[]'::jsonb
  ),
  (
    '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b',
    'Shipsprint',
    'https://shipsprint.site',
    '{"tone": "builder, concise, demo-first", "formats": ["launch-post", "comment"]}'::jsonb,
    'Shipsprint: no-code landing-page builder. ICP: indie hackers and early-stage founders shipping MVPs.',
    '{
      "linkedin": {"enabled": true, "account_refs": ["primary"], "daily_cap": 1},
      "x": {"enabled": true, "account_refs": ["primary"], "daily_cap": 4},
      "reddit": {"enabled": true, "subreddits": ["SideProject", "nocode", "startups"], "daily_cap": 3},
      "medium": {"enabled": true, "account_refs": ["primary"], "daily_cap": 1}
    }'::jsonb,
    '[{"label": "primary", "note": "connect via dashboard settings"}]'::jsonb
  )
on conflict (id) do update set
  name            = excluded.name,
  site_url        = excluded.site_url,
  voice_config    = excluded.voice_config,
  icp_doc         = excluded.icp_doc,
  channel_config  = excluded.channel_config,
  medium_accounts = excluded.medium_accounts;
