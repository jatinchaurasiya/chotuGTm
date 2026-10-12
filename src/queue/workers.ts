/**
 * BullMQ processors (worker-jobs lane).
 *
 * Every job is idempotent: crash-retry never double-inserts (dedupe
 * pre-checks on dedupe_hash / (opportunity_id, platform) / day-buckets).
 * Exhausted retries land in `failed_jobs` (dashboard-visible dead letter),
 * never silently dropped. Walls/paywalls resolve to skip, never retry.
 *
 * Lane modules (discover/triage/draft/deslop/track/learn) are loaded via
 * dynamic import inside each processor so a missing lane file degrades to
 * a logged skip (track/learn) instead of crashing the worker at boot.
 * Only hard failures (DB down, real exceptions after retries) throw and
 * therefore dead-letter via the `failed` listener below.
 */
import { Worker, type Job } from "bullmq";
import {
  getConnection,
  getQueue,
  QUEUE_NAMES,
  DEFAULT_JOB_OPTIONS,
  throttleLlm,
  type QueueKey,
} from "./queues.js";
import { serverClient } from "../db/client.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { retry } from "./retry.js";
import { recordLaneError } from "./errors.js";
import type {
  ChannelConfig,
} from "../learn/reweight.js";
import type { MatrixInput } from "../learn/scorecard.js";

/**
 * Service-role handle with loose table typing. Row/table shapes are owned by
 * the database lane (src/db/types.ts); this lane casts results at the edges
 * so a types-only change there can never break worker compilation.
 */
type Db = SupabaseClient<any, "public", any>;

function dbc(): Db {
  return serverClient() as unknown as Db;
}

/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Max attempts for a job (BullMQ default when unset is treated as 3 here). */
function maxAttemptsOf(job: Job): number {
  const n = job.opts.attempts;
  return typeof n === "number" && n > 0 ? n : 3;
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return msg.slice(0, 2000);
}

function dayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * Dead-letter one failure. failed_jobs.workspace_id is NOT NULL + FK, so a
 * caller without a real workspace cannot dead-letter — it must log instead.
 */
export async function deadLetter(opts: {
  workspaceId: string;
  jobType: string;
  payload: Record<string, unknown>;
  error: unknown;
  attempts: number;
}): Promise<void> {
  try {
    const db = dbc();
    const { error } = await retry(
      async () =>
        db.from("failed_jobs").insert({
          workspace_id: opts.workspaceId,
          job_type: opts.jobType,
          payload: opts.payload,
          error: errText(opts.error),
          attempts: opts.attempts,
        }),
      { maxAttempts: 3, baseMs: 500 },
    );
    if (error) {
      recordLaneError("dead-letter:insert", `insert failed: ${error.message}`);
      return;
    }
    console.info(
      `[worker] dead-lettered job_type=${opts.jobType} workspace=${opts.workspaceId} attempts=${opts.attempts}`,
    );
  } catch (e) {
    recordLaneError("dead-letter:insert", `insert threw: ${errText(e)}`);
  }
}

function payloadOf(job: Job): Record<string, unknown> {
  const d = job.data as unknown;
  return typeof d === "object" && d !== null ? (d as Record<string, unknown>) : {};
}

function workspaceOf(job: Job): string | null {
  const d = payloadOf(job);
  const w = d.workspace_id ?? d.workspaceId;
  return typeof w === "string" && w.trim() !== "" ? w : null;
}

/**
 * `failed` listener shared by all workers: only dead-letter once attempts
 * are exhausted; intermediate failures just log (BullMQ will retry).
 */
export async function maybeDeadLetter(job: Job | undefined, err: unknown): Promise<void> {
  if (!job) return;
  if (job.attemptsMade < maxAttemptsOf(job)) {
    console.warn(
      `[worker] job ${job.queueName}/${job.id} attempt ${job.attemptsMade} failed (will retry): ${errText(err).slice(0, 300)}`,
    );
    return;
  }
  const ws = workspaceOf(job);
  if (!ws) {
    // No workspace_id → cannot FK into failed_jobs. Record in the ring
    // buffer (surfaced via GET /api/doctor `recent_errors`) instead of
    // dropping to a log line nobody reads.
    recordLaneError(
      "dead-letter:no-workspace",
      `job ${job.queueName}/${job.id} exhausted with no workspace_id: ${errText(err).slice(0, 260)}`,
    );
    return;
  }
  await deadLetter({
    workspaceId: ws,
    jobType: job.name,
    payload: payloadOf(job),
    error: err,
    attempts: job.attemptsMade,
  });
}

interface WorkspaceRow {
  id: string;
  name: string;
  site_url: string;
  channel_config: unknown;
  voice_config: unknown;
}

/** List all workspaces (fan-out source for repeatable jobs). Retried, throws on failure. */
export async function listWorkspaces(db: Db): Promise<WorkspaceRow[]> {
  const { data, error } = await retry(
    async () => db.from("workspaces").select("id,name,site_url,channel_config,voice_config"),
    { maxAttempts: 3, baseMs: 500 },
  );
  if (error) throw new Error(`list workspaces failed: ${error.message}`);
  return (data ?? []) as unknown as WorkspaceRow[];
}

/** Default discover queries when channel_config carries no explicit list. */
function queriesForWorkspace(ws: WorkspaceRow): string[] {
  const cfg = (ws.channel_config ?? {}) as Record<string, unknown>;
  const explicit = cfg.discover_queries;
  if (Array.isArray(explicit) && explicit.length > 0) {
    return explicit.filter((q): q is string => typeof q === "string" && q.trim() !== "").slice(0, 10);
  }
  const seeds = [ws.name, ws.site_url].filter(
    (s): s is string => typeof s === "string" && s.trim() !== "",
  );
  return seeds.length > 0 ? seeds : [];
}

/** Subreddits to poll via no-auth RSS.
 * Top-level `reddit_subreddits` wins; falls back to nested `reddit.subreddits`
 * (the shape seeds use). */
function redditSubsForWorkspace(ws: WorkspaceRow): string[] {
  const cfg = (ws.channel_config ?? {}) as Record<string, unknown>;
  const top = cfg.reddit_subreddits;
  const nested = (cfg.reddit as Record<string, unknown> | undefined)?.subreddits;
  const subs = (Array.isArray(top) && top.length > 0 ? top : Array.isArray(nested) ? nested : []);
  if (!Array.isArray(subs)) return [];
  return subs
    .filter((s): s is string => typeof s === "string" && s.trim() !== "")
    .map((s) => s.replace(/^r\//i, "").trim())
    .filter((s) => /^[A-Za-z0-9_]+$/.test(s))
    .slice(0, 25);
}

/* ------------------------------------------------------------------ */
/* discover                                                            */
/* ------------------------------------------------------------------ */

export interface DiscoverJobData {
  workspace_id?: string;
  queries?: string[];
}

export async function discoverProcessor(job: Job): Promise<Record<string, unknown>> {
  const data = payloadOf(job) as DiscoverJobData;
  const db = dbc();
  const workspaces = data.workspace_id
    ? [{ id: data.workspace_id, name: data.workspace_id, site_url: "", channel_config: {}, voice_config: {} } as WorkspaceRow]
    : await listWorkspaces(db);
  if (workspaces.length === 0) {
    console.info("[discover] no workspaces, nothing to do");
    return { workspaces: 0 };
  }

  let mod: typeof import("../discover/index.js");
  try {
    mod = await import("../discover/index.js");
  } catch (e) {
    throw new Error(`discover lane missing: ${errText(e)}`);
  }
  const { runDiscover } = mod;

  const summary: Record<string, unknown> = {};
  const failures: string[] = [];
  for (const ws of workspaces) {
    try {
      // Per-workspace clients so budgets/caches never leak across tenants.
      const { TinyFishClient } = await import("../discover/tinyfish.js");
      const { ApiAnythingClient } = await import("../discover/apianything.js");
      const { fetchWithScrapling } = await import("../discover/scrapling.js");
      const tiny = new TinyFishClient();
      const cache = new ApiAnythingClient();
      const queries = data.workspace_id && data.queries?.length ? data.queries : queriesForWorkspace(ws);
      // No-auth Reddit RSS: polled when the oauth tier is unavailable
      // (Responsible Builder gate). Sequential + throttled inside; a throttle
      // is a skip, never fatal to the run.
      let direct: Array<{ url: string; title: string; snippet?: string; source: string; skipFetch?: boolean }> = [];
      try {
        const { pollSubreddits, redditTier } = await import("../discover/reddit-rss.js");
        if (redditTier() === "rss") {
          const subs = redditSubsForWorkspace(ws);
          if (subs.length > 0) {
            const rss = await pollSubreddits(subs, ["hot"]);
            direct = rss.candidates;
            for (const [reason, n] of Object.entries(rss.skipped)) {
              console.info(`[discover] reddit-rss skip reason=${reason} n=${n}`);
            }
          }
        }
      } catch (e) {
        console.warn(`[discover] reddit-rss unavailable, continuing without: ${errText(e).slice(0, 160)}`);
      }
      if (queries.length === 0 && direct.length === 0) {
        summary[ws.id] = { skipped: "no-queries" };
        continue;
      }
      const stats = await runDiscover(ws.id, queries, {
        searchNew: (q) => tiny.search({ query: q }),
        searchRepeat: async (q) => {
          const out = await cache.query(`tinyfish|${q.trim().toLowerCase()}`, () => tiny.search({ query: q }));
          return out.data as Awaited<ReturnType<typeof tiny.search>>;
        },
        fetchPage: (url) => fetchWithScrapling(url),
        insertOpportunity: async (opp) => {
          const seen = await db.from("opportunities").select("id").eq("dedupe_hash", opp.dedupeHash).limit(1);
          if (!seen.error && seen.data && seen.data.length > 0) return false;
          const { error } = await db.from("opportunities").insert({
            workspace_id: opp.workspaceId,
            source: opp.source,
            source_url: opp.finalUrl || opp.url,
            title: opp.title,
            body_excerpt: (opp.snippet ?? "").slice(0, 500),
            status: "discovered",
            dedupe_hash: opp.dedupeHash,
          });
          if (error) {
            if (error.code === "23505") return false; // lost the race: still idempotent
            throw new Error(`insert opportunity failed: ${error.message}`);
          }
          return true;
        },
      }, direct);
      summary[ws.id] = stats;
      // Event-driven fan-out: fresh batch -> triage (stable hourly jobId = dedupe on re-fire).
      const hourBucket = new Date().toISOString().slice(0, 13).replace(/[^0-9]/g, "");
      await getQueue("triage").add(
        "triage-batch",
        { workspace_id: ws.id, enqueued_at: new Date().toISOString() },
        { ...DEFAULT_JOB_OPTIONS, jobId: `triage-batch-${ws.id}-${hourBucket}` },
      );
    } catch (e) {
      failures.push(`${ws.id}: ${errText(e).slice(0, 200)}`);
      await deadLetter({
        workspaceId: ws.id,
        jobType: "discover",
        payload: { workspace_id: ws.id },
        error: e,
        attempts: maxAttemptsOf(job),
      });
    }
  }
  if (failures.length > 0 && Object.keys(summary).length === 0) {
    throw new Error(`discover failed for all workspaces: ${failures.join("; ")}`);
  }
  return { ...summary, failures };
}

/* ------------------------------------------------------------------ */
/* triage                                                              */
/* ------------------------------------------------------------------ */

export async function triageProcessor(job: Job): Promise<Record<string, unknown>> {
  const ws = workspaceOf(job);
  const db = dbc();
  const targets: WorkspaceRow[] = ws
    ? [{ id: ws, name: ws, site_url: "", channel_config: {}, voice_config: {} } as WorkspaceRow]
    : await listWorkspaces(db);

  let decide: typeof import("../triage/decide.js");
  let backstop: typeof import("../triage/backstop.js") | null = null;
  try {
    decide = await import("../triage/decide.js");
  } catch (e) {
    throw new Error(`triage lane missing: ${errText(e)}`);
  }
  try {
    backstop = await import("../triage/backstop.js");
  } catch {
    backstop = null;
  }

  const out: Record<string, unknown> = {};
  const failures: string[] = [];
  for (const w of targets) {
    try {
      const { data, error } = await db
        .from("opportunities")
        .select("id,title,body_excerpt,source_url")
        .eq("workspace_id", w.id)
        .is("mercury_score", null)
        .limit(50);
      if (error) throw new Error(`select opportunities failed: ${error.message}`);
      const rows = (data ?? []) as Array<{ id: string; title: string; body_excerpt: string; source_url: string }>;
      if (rows.length === 0) {
        out[w.id] = { scored: 0 };
        continue;
      }
      let scored = 0;
      for (const row of rows) {
        let score: number;
        try {
          await throttleLlm();
          const d = await decide.decideMercury({
            title: row.title,
            snippet: row.body_excerpt,
            url: row.source_url,
          });
          score = d.score;
        } catch (primaryErr) {
          // Inception-only failure -> OpenRouter backstop (triage lane contract).
          if (!backstop || !process.env.OPENROUTER_API_KEY) throw primaryErr;
          await throttleLlm();
          const b = await backstop.classifyBackstop({ title: row.title, snippet: row.body_excerpt, url: row.source_url });
          score = b.score;
        }
        const band = decide.bandFor(score);
        const status = band === "draft" ? "triaged" : band === "maybe" ? "maybe" : "discarded";
        const { error: upErr } = await db
          .from("opportunities")
          .update({ mercury_score: score, status })
          .eq("id", row.id);
        if (upErr) throw new Error(`update mercury_score failed: ${upErr.message}`);
        scored += 1;
        if (band === "draft") {
          await getQueue("draft").add(
            "draft-opportunity",
            { workspace_id: w.id, opportunity_id: row.id },
            { ...DEFAULT_JOB_OPTIONS, jobId: `draft-${row.id}` },
          );
        }
      }
      out[w.id] = { scored };
    } catch (e) {
      failures.push(`${w.id}: ${errText(e).slice(0, 200)}`);
      await deadLetter({
        workspaceId: w.id,
        jobType: "triage",
        payload: { workspace_id: w.id },
        error: e,
        attempts: maxAttemptsOf(job),
      });
    }
  }
  if (failures.length > 0 && Object.keys(out).length === 0) {
    throw new Error(`triage failed for all workspaces: ${failures.join("; ")}`);
  }
  return { ...out, failures };
}

/* ------------------------------------------------------------------ */
/* draft (+ deslop gate)                                                */
/* ------------------------------------------------------------------ */

export interface DraftJobData {
  workspace_id?: string;
  opportunity_id?: string;
}

export async function draftProcessor(job: Job): Promise<Record<string, unknown>> {
  const data = payloadOf(job) as DraftJobData;
  if (!data.workspace_id || !data.opportunity_id) {
    throw new Error("draft job needs {workspace_id, opportunity_id}");
  }
  const db = dbc();

  const { data: oppRows, error: oppErr } = await db
    .from("opportunities")
    .select("id,workspace_id,title,body_excerpt,source_url,mercury_score")
    .eq("id", data.opportunity_id)
    .limit(1);
  if (oppErr) throw new Error(`select opportunity failed: ${oppErr.message}`);
  const opp = (oppRows ?? [])[0] as
    | { id: string; workspace_id: string; title: string; body_excerpt: string; source_url: string; mercury_score: number | null }
    | undefined;
  if (!opp) throw new Error(`opportunity ${data.opportunity_id} not found`);
  if (opp.workspace_id !== data.workspace_id) throw new Error("opportunity/workspace mismatch");

  let draftMod: typeof import("../draft/index.js");
  let gateMod: typeof import("../deslop/gate.js");
  try {
    draftMod = await import("../draft/index.js");
  } catch (e) {
    throw new Error(`draft lane missing: ${errText(e)}`);
  }
  try {
    gateMod = await import("../deslop/gate.js");
  } catch (e) {
    throw new Error(`deslop lane missing: ${errText(e)}`);
  }

  // Idempotency pre-check: seed the existing-platform set from the DB first
  // so a double-fired job inserts zero rows the second time.
  const { data: existingRows, error: exErr } = await db
    .from("drafts")
    .select("platform")
    .eq("opportunity_id", opp.id);
  if (exErr) throw new Error(`select drafts failed: ${exErr.message}`);
  const existing = new Set((existingRows ?? []).map((r) => String((r as { platform: string }).platform)));

  const threshold = draftMod.readDraftThreshold();
  if ((opp.mercury_score ?? 0) < threshold) {
    return { skipped: `below-threshold:${opp.mercury_score}<${threshold}` };
  }

  await throttleLlm();
  const result = await draftMod.draftForOpportunity(
    {
      id: opp.id,
      workspaceId: opp.workspace_id,
      title: opp.title,
      summary: opp.body_excerpt,
      url: opp.source_url,
      mercuryScore: opp.mercury_score ?? 0,
    },
    {
      hasDraft: async (_id, platform) => existing.has(platform),
      saveDraft: async (draft) => {
        // Narrow the race: re-check right before insert.
        const re = await db
          .from("drafts")
          .select("id")
          .eq("opportunity_id", draft.opportunityId)
          .eq("platform", draft.platform)
          .limit(1);
        if (!re.error && re.data && re.data.length > 0) {
          existing.add(draft.platform);
          return;
        }
        const { data: inserted, error } = await db
          .from("drafts")
          .insert({
            workspace_id: data.workspace_id as string,
            opportunity_id: draft.opportunityId,
            platform: draft.platform,
            account_ref: "",
            content: draft.body,
            status: "draft",
          })
          .select("id,content")
          .limit(1);
        if (error) {
          if (error.code === "23505") {
            existing.add(draft.platform);
            return;
          }
          throw new Error(`insert draft failed: ${error.message}`);
        }
        existing.add(draft.platform);
        // Deslop gate: score + one rewrite pass; held drafts stay out of the queue.
        const row = (inserted ?? [])[0] as { id: string; content: string } | undefined;
        if (row) {
          const [gated] = await gateMod.gateDrafts([{ platform: draft.platform, text: draft.body }]);
          const { error: gErr } = await db
            .from("drafts")
            .update({ slop_score: gated.scoreAfter, status: gated.status === "pass" ? "draft" : "held" })
            .eq("id", row.id);
          if (gErr) console.warn(`[draft] gate update failed draft=${row.id}: ${gErr.message}`);
        }
      },
    },
  );
  return { opportunity_id: opp.id, generated: result.generated, existing: result.existing };
}

/* ------------------------------------------------------------------ */
/* track-site                                                          */
/* ------------------------------------------------------------------ */

export async function trackSiteProcessor(job: Job): Promise<Record<string, unknown>> {
  const ws = workspaceOf(job);
  const db = dbc();
  const targets: WorkspaceRow[] = ws
    ? [{ id: ws, name: ws, site_url: "", channel_config: {}, voice_config: {} } as WorkspaceRow]
    : await listWorkspaces(db);

  let seo: typeof import("../track/seomonster.js") | null = null;
  try {
    seo = await import("../track/seomonster.js");
  } catch (e) {
    console.warn(`[track-site] track lane missing, degrading: ${errText(e).slice(0, 200)}`);
    recordLaneError("track-site:degraded", e);
    return { degraded: "track-lane-missing" };
  }

  const out: Record<string, unknown> = {};
  const failures: string[] = [];
  for (const w of targets) {
    try {
      const siteUrl = w.site_url && w.site_url.trim() !== "" ? w.site_url : null;
      if (!siteUrl && !ws) {
        // Fan-out rows carry full workspace data; single-workspace jobs may
        // only have the id — fetch the missing site_url.
        const { data } = await db.from("workspaces").select("site_url").eq("id", w.id).limit(1);
        const row = (data ?? [])[0] as { site_url: string } | undefined;
        if (row?.site_url) w.site_url = row.site_url;
      }
      if (!w.site_url) {
        out[w.id] = { skipped: "no-site-url" };
        continue;
      }
      const { row } = await seo.trackSiteWorkspace({ workspaceId: w.id, siteUrl: w.site_url }, async (rows) => {
        for (const r of rows) {
          const day = dayKey(r.pulled_at);
          const { data: dup } = await db
            .from("site_metrics")
            .select("id")
            .eq("workspace_id", r.workspace_id)
            .gte("pulled_at", `${day}T00:00:00.000Z`)
            .lt("pulled_at", `${day}T23:59:59.999Z`)
            .limit(1);
          if (dup && dup.length > 0) continue; // idempotent day bucket
          const { error } = await db.from("site_metrics").insert({
            workspace_id: r.workspace_id,
            pulled_at: r.pulled_at,
            clicks: r.clicks,
            impressions: r.impressions,
            ctr: r.ctr,
            position: r.position,
            referrals: r.referrals as unknown as unknown[],
            signups: r.signups,
          });
          if (error && error.code !== "23505") throw new Error(`insert site_metrics failed: ${error.message}`);
        }
      });
      out[w.id] = { clicks: row.clicks, impressions: row.impressions };
    } catch (e) {
      failures.push(`${w.id}: ${errText(e).slice(0, 200)}`);
      await deadLetter({
        workspaceId: w.id,
        jobType: "track-site",
        payload: { workspace_id: w.id },
        error: e,
        attempts: maxAttemptsOf(job),
      });
    }
  }
  if (failures.length > 0 && Object.keys(out).length === 0) {
    throw new Error(`track-site failed for all workspaces: ${failures.join("; ")}`);
  }
  return { ...out, failures };
}

/* ------------------------------------------------------------------ */
/* track-post                                                          */
/* ------------------------------------------------------------------ */

export interface TrackPostJobData {
  workspace_id?: string;
  published_post_id?: string;
}

export async function trackPostProcessor(job: Job): Promise<Record<string, unknown>> {
  const data = payloadOf(job) as TrackPostJobData;
  const db = dbc();

  let postfetch: typeof import("../track/postfetch.js") | null = null;
  try {
    postfetch = await import("../track/postfetch.js");
  } catch (e) {
    console.warn(`[track-post] track lane missing, degrading: ${errText(e).slice(0, 200)}`);
    recordLaneError("track-post:degraded", e);
    return { degraded: "track-lane-missing" };
  }

  let q = db.from("published_posts").select("id,workspace_id,draft_id,platform,live_url");
  if (data.published_post_id) q = q.eq("id", data.published_post_id);
  if (data.workspace_id) q = q.eq("workspace_id", data.workspace_id);
  const { data: posts, error } = await q.limit(500);
  if (error) throw new Error(`select published_posts failed: ${error.message}`);
  const rows = (posts ?? []) as Array<{
    id: string;
    workspace_id: string;
    draft_id: string | null;
    platform: string;
    live_url: string;
  }>;
  if (rows.length === 0) return { tracked: 0 };

  let tracked = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const post of rows) {
    try {
      const res = await postfetch.trackPost(post, async (metric) => {
        const day = dayKey(metric.pulled_at);
        const { data: dup } = await db
          .from("post_metrics")
          .select("id")
          .eq("published_post_id", metric.published_post_id)
          .gte("pulled_at", `${day}T00:00:00.000Z`)
          .lt("pulled_at", `${day}T23:59:59.999Z`)
          .limit(1);
        if (dup && dup.length > 0) return; // idempotent day bucket
        const { error: insErr } = await db.from("post_metrics").insert({
          workspace_id: post.workspace_id,
          published_post_id: metric.published_post_id,
          pulled_at: metric.pulled_at,
          upvotes: metric.upvotes ?? 0,
          comments: metric.comments ?? 0,
          reactions: metric.reactions ?? 0,
          claps: metric.claps ?? 0,
        });
        if (insErr && insErr.code !== "23505") throw new Error(`insert post_metrics failed: ${insErr.message}`);
      });
      if ("skipped" in res) skipped += 1;
      else tracked += 1;
    } catch (e) {
      // Walls resolve to skip inside the lane; anything reaching here is
      // transient/unknown -> per-post dead letter, batch continues.
      failures.push(`${post.id}: ${errText(e).slice(0, 200)}`);
      await deadLetter({
        workspaceId: post.workspace_id,
        jobType: "track-post",
        payload: { workspace_id: post.workspace_id, published_post_id: post.id },
        error: e,
        attempts: maxAttemptsOf(job),
      });
    }
  }
  return { tracked, skipped, failures };
}

/* ------------------------------------------------------------------ */
/* learn                                                               */
/* ------------------------------------------------------------------ */

export async function learnProcessor(job: Job): Promise<Record<string, unknown>> {
  const ws = workspaceOf(job);
  const db = dbc();
  const targets: WorkspaceRow[] = ws
    ? [{ id: ws, name: ws, site_url: "", channel_config: {}, voice_config: {} } as WorkspaceRow]
    : await listWorkspaces(db);

  let attribution: typeof import("../track/attribution.js") | null = null;
  let scorecard: typeof import("../learn/scorecard.js") | null = null;
  let reweight: typeof import("../learn/reweight.js") | null = null;
  try {
    [attribution, scorecard, reweight] = await Promise.all([
      import("../track/attribution.js"),
      import("../learn/scorecard.js"),
      import("../learn/reweight.js"),
    ]);
  } catch (e) {
    console.warn(`[learn] track/learn lane missing, degrading: ${errText(e).slice(0, 200)}`);
    recordLaneError("learn:degraded", e);
    return { degraded: "learn-lane-missing" };
  }

  const out: Record<string, unknown> = {};
  const failures: string[] = [];
  for (const w of targets) {
    try {
      const [postsRes, siteRes] = await Promise.all([
        db.from("published_posts").select("id,workspace_id,platform,live_url,utm,published_at").eq("workspace_id", w.id).limit(500),
        db.from("site_metrics").select("pulled_at,clicks,impressions,signups,referrals").eq("workspace_id", w.id).order("pulled_at", { ascending: true }).limit(1000),
      ]);
      if (postsRes.error) throw new Error(`select published_posts failed: ${postsRes.error.message}`);
      if (siteRes.error) throw new Error(`select site_metrics failed: ${siteRes.error.message}`);
      const posts = (postsRes.data ?? []) as Array<{
        id: string;
        workspace_id: string;
        platform: string;
        live_url: string;
        utm: string;
        published_at: string;
      }>;
      const points = ((siteRes.data ?? []) as Array<{
        pulled_at: string;
        clicks: number;
        impressions: number;
        signups: number;
        referrals: unknown;
      }>).map((p) => ({
        pulled_at: p.pulled_at,
        clicks: Number(p.clicks) || 0,
        impressions: Number(p.impressions) || 0,
        signups: Number(p.signups) || 0,
        referrals: (p.referrals ?? {}) as Record<string, number>,
      }));
      if (posts.length === 0 || points.length === 0) {
        out[w.id] = { scored: 0, reason: "no-posts-or-no-site-points" };
        continue;
      }
      const scores = attribution.buildAttributionScores(
        posts.map((p) => ({
          published_post_id: p.id,
          workspace_id: p.workspace_id,
          published_at: p.published_at,
          live_url: p.live_url,
          utm: p.utm,
          platform: p.platform,
        })),
        points,
      );
      let inserted = 0;
      for (const s of scores) {
        const { data: dup } = await db
          .from("attribution_scores")
          .select("id")
          .eq("published_post_id", s.published_post_id)
          .eq("window_start", s.window_start)
          .eq("window_end", s.window_end)
          .limit(1);
        if (dup && dup.length > 0) continue; // idempotent window
        const { error } = await db.from("attribution_scores").insert({
          workspace_id: s.workspace_id,
          published_post_id: s.published_post_id,
          window_start: s.window_start,
          window_end: s.window_end,
          traffic_lift: s.traffic_lift,
          signup_lift: s.signup_lift,
          method: s.method,
        });
        if (error && error.code !== "23505") throw new Error(`insert attribution_scores failed: ${error.message}`);
        inserted += 1;
      }
      // Channel matrix + channel_config reweight (directional priors).
      const byPost = new Map(posts.map((p) => [p.id, p]));
      const matrixInputs: MatrixInput[] = scores.map((s) => ({
        ...s,
        channel: byPost.get(s.published_post_id)?.platform ?? "?",
        angle: "—",
        hook: "—",
      }));
      const cells = scorecard.buildChannelMatrix(matrixInputs);
      const current = (w.channel_config ?? {}) as ChannelConfig;
      const safeCurrent: ChannelConfig = {};
      for (const [k, v] of Object.entries(current)) {
        const prior = v as Partial<ChannelConfig[string]>;
        if (prior && typeof prior.weight === "number" && typeof prior.trials === "number") {
          safeCurrent[k] = { weight: prior.weight, trials: prior.trials };
        }
      }
      // Refresh channel_config from the DB row when fanning out with stubs.
      let baseConfig = safeCurrent;
      if (Object.keys(baseConfig).length === 0 && !ws) {
        const { data } = await db.from("workspaces").select("channel_config").eq("id", w.id).limit(1);
        const row = (data ?? [])[0] as { channel_config: unknown } | undefined;
        if (row && typeof row.channel_config === "object" && row.channel_config !== null) {
          baseConfig = row.channel_config as ChannelConfig;
        }
      }
      const next = reweight.reweightChannelConfig(baseConfig, cells);
      const { error: wsErr } = await db.from("workspaces").update({ channel_config: next as Record<string, unknown> }).eq("id", w.id);
      if (wsErr) throw new Error(`update channel_config failed: ${wsErr.message}`);
      out[w.id] = { scored: scores.length, inserted, cells: cells.length };
    } catch (e) {
      failures.push(`${w.id}: ${errText(e).slice(0, 200)}`);
      await deadLetter({
        workspaceId: w.id,
        jobType: "learn",
        payload: { workspace_id: w.id },
        error: e,
        attempts: maxAttemptsOf(job),
      });
    }
  }
  if (failures.length > 0 && Object.keys(out).length === 0) {
    throw new Error(`learn failed for all workspaces: ${failures.join("; ")}`);
  }
  return { ...out, failures };
}

/* ------------------------------------------------------------------ */
/* worker set                                                          */
/* ------------------------------------------------------------------ */

export type Processor = (job: Job) => Promise<unknown>;

export const PROCESSORS: Record<QueueKey, { processor: Processor; concurrency: number }> = {
  discover: { processor: discoverProcessor, concurrency: 1 },
  triage: { processor: triageProcessor, concurrency: 2 },
  draft: { processor: draftProcessor, concurrency: 2 },
  trackSite: { processor: trackSiteProcessor, concurrency: 2 },
  trackPost: { processor: trackPostProcessor, concurrency: 2 },
  learn: { processor: learnProcessor, concurrency: 1 },
};

export function queueKeyForQueueName(queueName: string): QueueKey | null {
  const entry = (Object.keys(QUEUE_NAMES) as QueueKey[]).find((k) => QUEUE_NAMES[k] === queueName);
  return entry ?? null;
}

/** Start all six workers. Call once from src/worker.ts. */
export function startWorkers(): Worker[] {
  const connection = getConnection();
  const workers: Worker[] = [];
  for (const [key, def] of Object.entries(PROCESSORS) as Array<[QueueKey, (typeof PROCESSORS)[QueueKey]]>) {
    const worker = new Worker(QUEUE_NAMES[key], def.processor as (job: Job) => Promise<unknown>, {
      connection,
      concurrency: def.concurrency,
    });
    worker.on("completed", (job) => {
      console.info(`[worker] ${key} completed job=${job?.id ?? "?"}`);
    });
    worker.on("failed", (job, err) => {
      void maybeDeadLetter(job, err);
    });
    worker.on("error", (err) => {
      console.warn(`[worker] ${key} error: ${errText(err).slice(0, 300)}`);
    });
    workers.push(worker);
  }
  console.info(`[worker] started ${workers.length} workers (discover x1, draft x2, track x2+2, triage x2, learn x1)`);
  return workers;
}
