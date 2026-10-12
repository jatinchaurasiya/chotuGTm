/**
 * Row types for all chotu tables (migrations/001_init.sql).
 * Keep in sync with the migrations — types are manual, no codegen.
 */

export interface Workspace {
  id: string;
  name: string;
  site_url: string;
  voice_config: Record<string, unknown>;
  icp_doc: string;
  channel_config: Record<string, unknown>;
  medium_accounts: unknown[];
  created_at: string;
}

export interface WorkspaceMember {
  workspace_id: string;
  user_id: string;
  role: "owner" | "member" | "viewer";
  created_at: string;
}

export interface Opportunity {
  id: string;
  workspace_id: string;
  source: string;
  source_url: string;
  title: string;
  body_excerpt: string;
  discovered_at: string;
  mercury_score: number | null;
  status: string;
  dedupe_hash: string;
}

export interface Draft {
  id: string;
  workspace_id: string;
  opportunity_id: string | null;
  platform: string;
  account_ref: string;
  content: string;
  slop_score: number | null;
  status: string;
  copied_at: string | null;
}

export interface PublishedPost {
  id: string;
  workspace_id: string;
  draft_id: string | null;
  platform: string;
  live_url: string;
  utm: string;
  published_at: string;
}

export interface PostMetric {
  id: string;
  workspace_id: string;
  published_post_id: string;
  pulled_at: string;
  upvotes: number;
  comments: number;
  reactions: number;
  claps: number;
}

export interface SiteMetric {
  id: string;
  workspace_id: string;
  pulled_at: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  referrals: unknown[];
  signups: number;
}

export interface AttributionScore {
  id: string;
  workspace_id: string;
  published_post_id: string | null;
  window_start: string;
  window_end: string;
  traffic_lift: number | null;
  signup_lift: number | null;
  /** Always 'directional' per build contract — never causal. */
  method: string;
}

export interface FailedJob {
  id: string;
  workspace_id: string;
  job_type: string;
  payload: Record<string, unknown>;
  error: string;
  attempts: number;
  created_at: string;
}

/** supabase-js Database generic so the server client is typed. */
export interface Database {
  public: {
    Tables: {
      workspaces: { Row: Workspace; Insert: Partial<Workspace>; Update: Partial<Workspace> };
      workspace_members: { Row: WorkspaceMember; Insert: Partial<WorkspaceMember>; Update: Partial<WorkspaceMember> };
      opportunities: { Row: Opportunity; Insert: Partial<Opportunity>; Update: Partial<Opportunity> };
      drafts: { Row: Draft; Insert: Partial<Draft>; Update: Partial<Draft> };
      published_posts: { Row: PublishedPost; Insert: Partial<PublishedPost>; Update: Partial<PublishedPost> };
      post_metrics: { Row: PostMetric; Insert: Partial<PostMetric>; Update: Partial<PostMetric> };
      site_metrics: { Row: SiteMetric; Insert: Partial<SiteMetric>; Update: Partial<SiteMetric> };
      attribution_scores: { Row: AttributionScore; Insert: Partial<AttributionScore>; Update: Partial<AttributionScore> };
      failed_jobs: { Row: FailedJob; Insert: Partial<FailedJob>; Update: Partial<FailedJob> };
    };
  };
}

export type TableName = keyof Database["public"]["Tables"];
