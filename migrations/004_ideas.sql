-- chotu migration 004_ideas
-- New table public.content_ideas + angle/hook columns on opportunities/drafts.
--
-- Idempotent: CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- DROP POLICY IF EXISTS guards — safe to re-apply.
-- Ledger-safe: applied once and recorded by filename in chotu_migrations
-- (see scripts/migrate.js); re-deploys skip it by filename.
--
-- Apply: psql "$SUPABASE_DB_URL" -f migrations/004_ideas.sql
--        or: npm run db:migrate

-- gen_random_uuid()
create extension if not exists "pgcrypto";

-- ------------------------------------------------------------ content_ideas
create table if not exists public.content_ideas (
  id                    uuid        primary key default gen_random_uuid(),
  workspace_id          uuid        not null references public.workspaces (id) on delete cascade,
  platform              text        not null check (platform in ('reddit-reply', 'reddit-post', 'twitter', 'linkedin', 'medium')),
  title                 text        not null,
  angle                 text        not null default '—',
  hook                  text        not null default '—',
  source                text        not null default 'mined' check (source in ('mined', 'generated', 'seo')),
  source_opportunity_id uuid        references public.opportunities (id) on delete set null,
  status                text        not null default 'proposed' check (status in ('proposed', 'approved', 'dismissed', 'drafted')),
  score                 double precision not null default 0.5,
  created_at            timestamptz not null default now()
);

create index if not exists content_ideas_workspace_platform_status_idx
  on public.content_ideas (workspace_id, platform, status);

-- ------------------------------------------------------------------ extends
-- Backfill rule: ADD COLUMN with a non-null DEFAULT rewrites existing rows
-- with that default, so the NOT NULL constraint below holds even when the
-- tables already contain rows (idempotent re-runs are no-ops).
alter table public.opportunities
  add column if not exists angle text not null default '—',
  add column if not exists hook  text not null default '—';

-- NOTE: content_ideas must exist before this (FK target, created above).
alter table public.drafts
  add column if not exists idea_id uuid references public.content_ideas (id) on delete set null,
  add column if not exists angle   text not null default '—',
  add column if not exists hook    text not null default '—';

create index if not exists drafts_idea_id_idx
  on public.drafts (idea_id);

-- ---------------------------------------------------------------------- RLS
-- Deny-by-default, mirroring 001_init.sql: policy granted ONLY to
-- `authenticated` via workspace membership. No policy for `anon` => denied.
alter table public.content_ideas enable row level security;

drop policy if exists "content_ideas_member_all" on public.content_ideas;
create policy "content_ideas_member_all"
  on public.content_ideas
  for all
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
