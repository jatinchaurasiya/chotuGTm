-- chotu migration 001_init
-- Creates all 8 core tables (+ workspace_members for RLS membership),
-- enables RLS deny-by-default, adds indexes, prune helper, membership helper.
--
-- MEMBERSHIP ASSUMPTION (documented):
--   Dashboard uses the Supabase anon key with an authenticated user
--   (auth.uid() set). Row access is granted only via workspace_members.
--   Server-side jobs use service_role (bypasses RLS) and MUST scope by
--   workspace_id in application code. With RLS enabled and no policy for
--   the anon role, anonymous users are denied on every table by default.
--
-- Apply: psql "$SUPABASE_DB_URL" -f migrations/001_init.sql
--        or: npm run db:migrate   (see scripts/migrate.js)

-- gen_random_uuid()
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- workspaces
create table if not exists public.workspaces (
  id            uuid        primary key default gen_random_uuid(),
  name          text        not null,
  site_url      text        not null,
  voice_config  jsonb       not null default '{}'::jsonb,
  icp_doc       text        not null default '',
  channel_config jsonb      not null default '{}'::jsonb,
  medium_accounts jsonb     not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);

-- ------------------------------------------------------- workspace_members
-- Supporting table for per-user RLS (not one of the 8 core tables).
create table if not exists public.workspace_members (
  workspace_id uuid        not null references public.workspaces (id) on delete cascade,
  user_id      uuid        not null references auth.users (id) on delete cascade,
  role         text        not null default 'member' check (role in ('owner', 'member', 'viewer')),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- ------------------------------------------------------------ opportunities
create table if not exists public.opportunities (
  id            uuid        primary key default gen_random_uuid(),
  workspace_id  uuid        not null references public.workspaces (id) on delete cascade,
  source        text        not null,
  source_url    text        not null default '',
  title         text        not null default '',
  body_excerpt  text        not null default '',
  discovered_at timestamptz not null default now(),
  mercury_score double precision,
  status        text        not null default 'discovered',
  dedupe_hash   text        not null unique
);

-- ------------------------------------------------------------------- drafts
create table if not exists public.drafts (
  id             uuid        primary key default gen_random_uuid(),
  workspace_id   uuid        not null references public.workspaces (id) on delete cascade,
  opportunity_id uuid        references public.opportunities (id) on delete set null,
  platform       text        not null,
  account_ref    text        not null default '',
  content        text        not null default '',
  slop_score     double precision,
  status         text        not null default 'draft',
  copied_at      timestamptz
);

-- ---------------------------------------------------------- published_posts
create table if not exists public.published_posts (
  id            uuid        primary key default gen_random_uuid(),
  workspace_id  uuid        not null references public.workspaces (id) on delete cascade,
  draft_id      uuid        references public.drafts (id) on delete set null,
  platform      text        not null,
  live_url      text        not null default '',
  utm           text        not null default '',
  published_at  timestamptz not null default now()
);

-- ------------------------------------------------------------ post_metrics
-- NOTE: agent spec lists (id, published_post_id, ...) with no workspace_id,
-- but the lane contract requires workspace_id on ALL tables for uniform RLS,
-- so workspace_id is denormalized here (must match the parent post's workspace).
create table if not exists public.post_metrics (
  id                uuid        primary key default gen_random_uuid(),
  workspace_id      uuid        not null references public.workspaces (id) on delete cascade,
  published_post_id uuid        not null references public.published_posts (id) on delete cascade,
  pulled_at         timestamptz not null default now(),
  upvotes           integer     not null default 0,
  comments          integer     not null default 0,
  reactions         integer     not null default 0,
  claps             integer     not null default 0
);

-- ------------------------------------------------------------ site_metrics
create table if not exists public.site_metrics (
  id           uuid        primary key default gen_random_uuid(),
  workspace_id uuid        not null references public.workspaces (id) on delete cascade,
  pulled_at    timestamptz not null default now(),
  clicks       integer     not null default 0,
  impressions  integer     not null default 0,
  ctr          double precision,
  position     double precision,
  referrals    jsonb       not null default '[]'::jsonb,
  signups      integer     not null default 0
);

-- ------------------------------------------------------- attribution_scores
create table if not exists public.attribution_scores (
  id                uuid        primary key default gen_random_uuid(),
  workspace_id      uuid        not null references public.workspaces (id) on delete cascade,
  published_post_id uuid        references public.published_posts (id) on delete set null,
  window_start      timestamptz not null,
  window_end        timestamptz not null,
  traffic_lift      double precision,
  signup_lift       double precision,
  method            text        not null default 'directional'
);

-- -------------------------------------------------------------- failed_jobs
create table if not exists public.failed_jobs (
  id           uuid        primary key default gen_random_uuid(),
  workspace_id uuid        not null references public.workspaces (id) on delete cascade,
  job_type     text        not null,
  payload      jsonb       not null default '{}'::jsonb,
  error        text        not null default '',
  attempts     integer     not null default 0,
  created_at   timestamptz not null default now()
);

-- ------------------------------------------------------------------ indexes
create index if not exists opportunities_workspace_id_idx
  on public.opportunities (workspace_id);
create index if not exists opportunities_status_idx
  on public.opportunities (workspace_id, status);
-- dedupe_hash UNIQUE is enforced by the column constraint above; add an
-- explicit unique index name guard for clarity (no-op if constraint exists).
create unique index if not exists opportunities_dedupe_hash_uidx
  on public.opportunities (dedupe_hash);

create index if not exists drafts_workspace_id_idx
  on public.drafts (workspace_id);
create index if not exists drafts_opportunity_id_idx
  on public.drafts (opportunity_id);
create index if not exists drafts_status_idx
  on public.drafts (workspace_id, status);

create index if not exists published_posts_workspace_id_idx
  on public.published_posts (workspace_id);
create index if not exists published_posts_draft_id_idx
  on public.published_posts (draft_id);

create index if not exists post_metrics_workspace_id_idx
  on public.post_metrics (workspace_id);
create index if not exists post_metrics_post_pulled_idx
  on public.post_metrics (published_post_id, pulled_at desc);

create index if not exists site_metrics_workspace_pulled_idx
  on public.site_metrics (workspace_id, pulled_at desc);

create index if not exists attribution_scores_workspace_id_idx
  on public.attribution_scores (workspace_id);
create index if not exists attribution_scores_post_idx
  on public.attribution_scores (published_post_id);

create index if not exists failed_jobs_workspace_id_idx
  on public.failed_jobs (workspace_id);
create index if not exists failed_jobs_type_idx
  on public.failed_jobs (workspace_id, job_type);

create index if not exists workspace_members_user_idx
  on public.workspace_members (user_id);

-- ---------------------------------------------------------------------- RLS
-- Deny-by-default: RLS enabled, policies granted ONLY to `authenticated`
-- via membership. No policies for `anon` => anon reads/writes denied.

alter table public.workspaces         enable row level security;
alter table public.workspace_members  enable row level security;
alter table public.opportunities      enable row level security;
alter table public.drafts             enable row level security;
alter table public.published_posts    enable row level security;
alter table public.post_metrics       enable row level security;
alter table public.site_metrics       enable row level security;
alter table public.attribution_scores enable row level security;
alter table public.failed_jobs        enable row level security;

-- Membership helper (SECURITY DEFINER so it can read workspace_members
-- under RLS; STABLE; scoped to the calling auth.uid()).
create or replace function public.is_workspace_member(ws_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members m
    where m.workspace_id = ws_id
      and m.user_id = auth.uid()
  );
$$;

-- Users may read their own membership rows only. No insert/update/delete
-- policies => writes denied for anon/authenticated; service_role (server)
-- bypasses RLS and manages memberships.
drop policy if exists "workspace_members_select_own" on public.workspace_members;
create policy "workspace_members_select_own"
  on public.workspace_members
  for select
  to authenticated
  using (user_id = auth.uid());

-- Workspaces: member of that workspace (id-keyed).
drop policy if exists "workspaces_member_all" on public.workspaces;
create policy "workspaces_member_all"
  on public.workspaces
  for all
  to authenticated
  using (public.is_workspace_member(id))
  with check (public.is_workspace_member(id));

-- All workspace-scoped tables: member of the row's workspace.
drop policy if exists "opportunities_member_all" on public.opportunities;
create policy "opportunities_member_all"
  on public.opportunities
  for all
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "drafts_member_all" on public.drafts;
create policy "drafts_member_all"
  on public.drafts
  for all
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "published_posts_member_all" on public.published_posts;
create policy "published_posts_member_all"
  on public.published_posts
  for all
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "post_metrics_member_all" on public.post_metrics;
create policy "post_metrics_member_all"
  on public.post_metrics
  for all
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "site_metrics_member_all" on public.site_metrics;
create policy "site_metrics_member_all"
  on public.site_metrics
  for all
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "attribution_scores_member_all" on public.attribution_scores;
create policy "attribution_scores_member_all"
  on public.attribution_scores
  for all
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

drop policy if exists "failed_jobs_member_all" on public.failed_jobs;
create policy "failed_jobs_member_all"
  on public.failed_jobs
  for all
  to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- ------------------------------------------------- prune helper (free tier)
-- Deletes post_metrics older than retention_days (default 90) to stay
-- within the 500MB free-tier guard. Run nightly via pg_cron or the worker:
--   select public.prune_post_metrics(90);
create or replace function public.prune_post_metrics(retention_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count integer;
begin
  delete from public.post_metrics
  where pulled_at < now() - (retention_days || ' days')::interval;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- ------------------------------------------------------- keep-alive comment
-- Supabase pauses idle projects (~1wk). Ping from GH Actions cron with:
--   select 1;
-- or: select count(*) from public.workspaces;  (service_role / anon-safe)
