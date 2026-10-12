/**
 * REST API (backend-api lane).
 *
 *   npm run dev    -> tsx src/api/server.ts   (loads .env.local, then .env)
 *   npm start      -> node dist/src/api/server.js  (env from shell / compose)
 *
 * Serves the dependency-free dashboard as static files and exposes:
 *
 *   GET  /health
 *   GET  /api/opportunities?workspace_id=     (array)
 *   GET  /api/drafts?workspace_id=            (array, held drafts excluded by default)
 *   POST /api/publish                         {workspace_id, draft_id?, live_url?, platform?, action?}
 *   GET  /api/metrics?workspace_id=           {site_metrics, attribution, matrix}
 *   GET  /api/failed-jobs?workspace_id=       (array)
 *   POST /api/retry-job                       {id | job_id, workspace_id?}
 *   GET  /api/workspaces                       {workspaces: [{id, name}]}
 *   GET  /api/doctor                           {checks} (workspace_id optional)
 *
 * Rules:
 * - service_role reaches the DB ONLY through src/db/client.ts (never in
 *   dashboard code — the dashboard only fetches same-origin /api/*).
 * - Every list endpoint REQUIRES workspace_id and filters by it (server-side
 *   scoping; RLS membership is enforced for anon dashboard reads in Supabase).
 * - POST /api/publish validates the URL, appends
 *   utm_source/medium/campaign={workspace}_{date} when missing (via
 *   src/draft/utm.ts), and dedupes on (draft_id, live_url) — a repeat
 *   registration returns the existing row instead of inserting.
 */
import dotenv from "dotenv";
// Local dev env: .env.local first, then .env. dotenv never overrides real
// environment variables, so shell / Docker Compose values always win.
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });
import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { serverClient } from "../db/client.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appendUtm, buildUtmQuery } from "../draft/utm.js";
import { getSchedules } from "../queue/scheduler.js";
import { getQueue, queueKeyForJobType, pingRedis, DEFAULT_JOB_OPTIONS } from "../queue/queues.js";
import { recentLaneErrors } from "../queue/errors.js";

/**
 * Service-role handle with loose table typing. Row/table shapes are owned by
 * the database lane (src/db/types.ts); this lane casts results at the edges
 * so a types-only change there can never break API compilation.
 */
type Db = SupabaseClient<any, "public", any>;

function dbc(): Db {
  return serverClient() as unknown as Db;
}

/* ------------------------------------------------------------------ */
/* app + helpers                                                       */
/* ------------------------------------------------------------------ */

export function createApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "chotu-api", time: new Date().toISOString() });
  });

  app.get("/api/opportunities", handleListOpportunities);
  app.get("/api/drafts", handleListDrafts);
  app.post("/api/publish", handlePublish);
  app.get("/api/metrics", handleMetrics);
  app.get("/api/failed-jobs", handleFailedJobs);
  app.post("/api/retry-job", handleRetryJob);
  app.get("/api/workspaces", handleWorkspaces);
  app.get("/api/doctor", handleDoctor);

  // Dashboard static bundle (index.html + app.js + styles.css).
  app.use(express.static("dashboard"));

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: "not-found" });
  });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.warn(`[api] unhandled: ${String((err as Error)?.message ?? err)}`);
    res.status(500).json({ ok: false, error: "internal-error" });
  });

  return app;
}

/** Lazy service_role client: routes stay up (503) when env is missing instead of crashing boot. */
function requireDb(res: Response): Db | null {
  try {
    return dbc();
  } catch (e) {
    res.status(503).json({ ok: false, error: String((e as Error)?.message ?? e) });
    return null;
  }
}

const workspaceQuerySchema = z.object({
  workspace_id: z.string().min(1, "workspace_id is required"),
});

function readWorkspaceId(req: Request): string | null {
  const parsed = workspaceQuerySchema.safeParse(req.query);
  if (!parsed.success) return null;
  return parsed.data.workspace_id;
}

function workspaceRequired(req: Request, res: Response): string | null {
  const ws = readWorkspaceId(req);
  if (!ws) {
    res.status(400).json({ ok: false, error: "workspace_id query param is required" });
    return null;
  }
  return ws;
}

function clampLimit(raw: unknown, fallback = 200): number {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(500, Math.max(1, Math.floor(n)));
}

/* ------------------------------------------------------------------ */
/* GET /api/opportunities                                              */
/* ------------------------------------------------------------------ */

async function handleListOpportunities(req: Request, res: Response): Promise<void> {
  const ws = workspaceRequired(req, res);
  if (!ws) return;
  const db = requireDb(res);
  if (!db) return;
  const limit = clampLimit((req.query as Record<string, unknown>).limit);
  const { data, error } = await db
    .from("opportunities")
    .select("*")
    .eq("workspace_id", ws)
    .order("discovered_at", { ascending: false })
    .limit(limit);
  if (error) {
    res.status(502).json({ ok: false, error: error.message });
    return;
  }
  // Array shape: the dashboard accepts arrays directly (or {opportunities}/{data}).
  res.json(data ?? []);
}

/* ------------------------------------------------------------------ */
/* GET /api/drafts                                                     */
/* ------------------------------------------------------------------ */

async function handleListDrafts(req: Request, res: Response): Promise<void> {
  const ws = workspaceRequired(req, res);
  if (!ws) return;
  const db = requireDb(res);
  if (!db) return;
  const q = req.query as Record<string, unknown>;
  const limit = clampLimit(q.limit);
  const includeHeld = q.include_held === "1" || q.include_held === "true";
  let query = db.from("drafts").select("*").eq("workspace_id", ws);
  if (!includeHeld) query = query.neq("status", "held"); // deslop: held never shown in queue
  const { data, error } = await query.order("id", { ascending: true }).limit(limit);
  if (error) {
    res.status(502).json({ ok: false, error: error.message });
    return;
  }
  res.json(data ?? []);
}

/* ------------------------------------------------------------------ */
/* POST /api/publish                                                   */
/* ------------------------------------------------------------------ */

const publishSchema = z.object({
  workspace_id: z.string().min(1, "workspace_id is required"),
  draft_id: z.string().min(1).optional(),
  live_url: z.string().min(1).optional(),
  platform: z.string().min(1).optional(),
  // Dashboard copy button posts {action: "copied"} to stamp copied_at.
  action: z.string().optional(),
});

function invalidUrlReason(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "live_url must be an absolute http(s) URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "live_url must be an absolute http(s) URL";
  }
  return null;
}

async function handlePublish(req: Request, res: Response): Promise<void> {
  const parsed = publishSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message ?? "invalid body" });
    return;
  }
  const body = parsed.data;
  const db = requireDb(res);
  if (!db) return;

  // Best-effort "copied" stamp from the dashboard copy button (never blocks copy).
  if (body.action === "copied") {
    if (!body.draft_id) {
      res.status(400).json({ ok: false, error: "draft_id is required for action=copied" });
      return;
    }
    const { data, error } = await db
      .from("drafts")
      .update({ copied_at: new Date().toISOString() })
      .eq("id", body.draft_id)
      .eq("workspace_id", body.workspace_id)
      .select("id");
    if (error) {
      res.status(502).json({ ok: false, error: error.message });
      return;
    }
    if (!data || data.length === 0) {
      res.status(404).json({ ok: false, error: "draft not found in this workspace" });
      return;
    }
    res.json({ ok: true, copied: true, id: body.draft_id });
    return;
  }

  // Live-URL registration (tracking starts here).
  if (!body.live_url) {
    res.status(400).json({ ok: false, error: "live_url is required" });
    return;
  }
  const urlProblem = invalidUrlReason(body.live_url);
  if (urlProblem) {
    res.status(400).json({ ok: false, error: urlProblem });
    return;
  }

  let platform = (body.platform ?? "social").trim().toLowerCase() || "social";
  if (body.draft_id) {
    const { data, error } = await db
      .from("drafts")
      .select("id,platform")
      .eq("id", body.draft_id)
      .eq("workspace_id", body.workspace_id)
      .limit(1);
    if (error) {
      res.status(502).json({ ok: false, error: error.message });
      return;
    }
    const draft = (data ?? [])[0] as { id: string; platform: string } | undefined;
    if (!draft) {
      res.status(404).json({ ok: false, error: "draft not found in this workspace" });
      return;
    }
    if (!body.platform && draft.platform) platform = draft.platform.trim().toLowerCase() || platform;
  }

  // UTM append (utm.ts preserves existing params + fragment automatically).
  let liveUrlWithUtm: string;
  try {
    liveUrlWithUtm = appendUtm(body.live_url, { platform, workspace: body.workspace_id });
  } catch {
    res.status(400).json({ ok: false, error: "live_url must be an absolute http(s) URL" });
    return;
  }
  const utm = buildUtmQuery({ platform, workspace: body.workspace_id });

  // Idempotency: dedupe on (draft_id, live_url).
  let dedupe = db.from("published_posts").select("id,live_url,utm").eq("workspace_id", body.workspace_id);
  dedupe = body.draft_id ? dedupe.eq("draft_id", body.draft_id) : dedupe.eq("live_url", liveUrlWithUtm);
  const { data: dup, error: dupErr } = await dedupe.limit(1);
  if (dupErr) {
    res.status(502).json({ ok: false, error: dupErr.message });
    return;
  }
  const hit = (dup ?? [])[0] as { id: string; live_url: string; utm: string } | undefined;
  if (hit && (!body.draft_id || hit.live_url === liveUrlWithUtm)) {
    res.json({ ok: true, deduped: true, id: hit.id, live_url: hit.live_url, utm: hit.utm });
    return;
  }

  const { data: inserted, error: insErr } = await db
    .from("published_posts")
    .insert({
      workspace_id: body.workspace_id,
      draft_id: body.draft_id ?? null,
      platform,
      live_url: liveUrlWithUtm,
      utm,
    })
    .select("id,live_url,utm")
    .limit(1);
  if (insErr) {
    res.status(502).json({ ok: false, error: insErr.message });
    return;
  }
  const row = (inserted ?? [])[0] as { id: string; live_url: string; utm: string } | undefined;
  if (!row) {
    res.status(502).json({ ok: false, error: "publish insert returned no row" });
    return;
  }
  // Best-effort: mark the source draft published (publish still succeeds if this fails).
  if (body.draft_id) {
    const { error: markErr } = await db
      .from("drafts")
      .update({ status: "published" })
      .eq("id", body.draft_id)
      .eq("workspace_id", body.workspace_id);
    if (markErr) console.warn(`[api] publish mark-draft failed: ${markErr.message}`);
  }
  res.status(201).json({ ok: true, deduped: false, id: row.id, live_url: row.live_url, utm: row.utm });
}

/* ------------------------------------------------------------------ */
/* GET /api/metrics                                                    */
/* ------------------------------------------------------------------ */

interface MatrixRow {
  channel: string;
  angle: string;
  hook: string;
  n: number;
  avg_lift: number;
  avg_signup_lift: number;
  method_mix: string;
  thin: boolean;
}

async function handleMetrics(req: Request, res: Response): Promise<void> {
  const ws = workspaceRequired(req, res);
  if (!ws) return;
  const db = requireDb(res);
  if (!db) return;

  const [siteRes, attrRes, postsRes] = await Promise.all([
    db.from("site_metrics").select("*").eq("workspace_id", ws).order("pulled_at", { ascending: false }).limit(90),
    db
      .from("attribution_scores")
      .select("*")
      .eq("workspace_id", ws)
      .order("window_end", { ascending: false })
      .limit(200),
    db.from("published_posts").select("id,live_url,platform").eq("workspace_id", ws).limit(500),
  ]);
  if (siteRes.error) {
    res.status(502).json({ ok: false, error: siteRes.error.message });
    return;
  }
  if (attrRes.error) {
    res.status(502).json({ ok: false, error: attrRes.error.message });
    return;
  }
  if (postsRes.error) {
    res.status(502).json({ ok: false, error: postsRes.error.message });
    return;
  }

  const siteMetrics = (siteRes.data ?? []) as unknown as Array<Record<string, unknown>>;
  const rawAttr = (attrRes.data ?? []) as unknown as Array<Record<string, unknown>>;
  const postById = new Map(
    ((postsRes.data ?? []) as unknown as Array<{ id: string; live_url: string; platform: string }>).map((p) => [
      p.id,
      p,
    ]),
  );

  // Enrich attribution rows with live_url + channel so the scorecard can
  // render without a second round-trip (dashboard falls back to
  // published_post_id when live_url is absent).
  const attribution = rawAttr.map((r) => {
    const post = typeof r.published_post_id === "string" ? postById.get(r.published_post_id) : undefined;
    return {
      ...r,
      live_url: post?.live_url ?? null,
      channel: post?.platform ?? "?",
      platform: post?.platform ?? "?",
    };
  });

  // Channel x angle x hook matrix (angle/hook tags default until the
  // draft lane stores them; dashboard also derives a fallback client-side).
  const groups = new Map<string, { channel: string; lifts: number[]; signups: number[]; exact: number }>();
  for (const r of attribution) {
    const channel = String((r as Record<string, unknown>).channel ?? "?");
    const key = `${channel}|—|—`;
    const g = groups.get(key) ?? { channel, lifts: [], signups: [], exact: 0 };
    const t = Number((r as Record<string, unknown>).traffic_lift);
    const s = Number((r as Record<string, unknown>).signup_lift);
    g.lifts.push(Number.isFinite(t) ? t : 0);
    g.signups.push(Number.isFinite(s) ? s : 0);
    if ((r as Record<string, unknown>).method === "exact") g.exact += 1;
    groups.set(key, g);
  }
  const matrix: MatrixRow[] = [...groups.values()]
    .map((g) => {
      const n = g.lifts.length;
      const avg = n > 0 ? g.lifts.reduce((a, b) => a + b, 0) / n : 0;
      const avgS = n > 0 ? g.signups.reduce((a, b) => a + b, 0) / n : 0;
      return {
        channel: g.channel,
        angle: "—",
        hook: "—",
        n,
        avg_lift: Number(avg.toFixed(4)),
        avg_signup_lift: Number(avgS.toFixed(4)),
        method_mix: `${n > 0 ? Math.round((g.exact / n) * 100) : 0}% exact`,
        thin: n < 3,
      };
    })
    .sort((a, b) => b.avg_lift - a.avg_lift);

  res.json({ workspace_id: ws, site_metrics: siteMetrics, attribution, matrix });
}

/* ------------------------------------------------------------------ */
/* GET /api/failed-jobs + POST /api/retry-job                          */
/* ------------------------------------------------------------------ */

async function handleFailedJobs(req: Request, res: Response): Promise<void> {
  const ws = workspaceRequired(req, res);
  if (!ws) return;
  const db = requireDb(res);
  if (!db) return;
  const limit = clampLimit((req.query as Record<string, unknown>).limit, 100);
  const { data, error } = await db
    .from("failed_jobs")
    .select("*")
    .eq("workspace_id", ws)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    res.status(502).json({ ok: false, error: error.message });
    return;
  }
  res.json(data ?? []);
}

const retryJobSchema = z
  .object({
    id: z.string().min(1).optional(),
    job_id: z.string().min(1).optional(), // dashboard sends job_id
    workspace_id: z.string().min(1).optional(),
  })
  .refine((b) => b.id ?? b.job_id, { message: "id (or job_id) is required" });

async function handleRetryJob(req: Request, res: Response): Promise<void> {
  const parsed = retryJobSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.issues[0]?.message ?? "invalid body" });
    return;
  }
  const targetId = (parsed.data.id ?? parsed.data.job_id) as string;
  const db = requireDb(res);
  if (!db) return;

  const { data, error } = await db.from("failed_jobs").select("*").eq("id", targetId).limit(1);
  if (error) {
    res.status(502).json({ ok: false, error: error.message });
    return;
  }
  const row = (data ?? [])[0] as
    | { id: string; workspace_id: string; job_type: string; payload: Record<string, unknown>; attempts: number }
    | undefined;
  if (!row) {
    res.status(404).json({ ok: false, error: "failed job not found" });
    return;
  }
  if (parsed.data.workspace_id && parsed.data.workspace_id !== row.workspace_id) {
    res.status(404).json({ ok: false, error: "failed job not found in this workspace" });
    return;
  }

  const queueKey = queueKeyForJobType(row.job_type);
  if (!queueKey) {
    // Unknown type: nothing to requeue into — clear the row and report.
    const { error: delErr } = await db.from("failed_jobs").delete().eq("id", row.id);
    if (delErr) {
      res.status(502).json({ ok: false, error: delErr.message });
      return;
    }
    res.json({ ok: true, requeued: false, note: `unknown job_type ${row.job_type}, row cleared` });
    return;
  }

  try {
    await getQueue(queueKey).add(row.job_type, { ...(row.payload ?? {}), workspace_id: row.workspace_id, retried_from: row.id }, { ...DEFAULT_JOB_OPTIONS });
  } catch (e) {
    // Redis down: keep the row so the retry is not lost.
    res.status(502).json({ ok: false, error: `queue unavailable, row retained: ${String((e as Error)?.message ?? e)}` });
    return;
  }
  const { error: delErr } = await db.from("failed_jobs").delete().eq("id", row.id);
  if (delErr) {
    res.status(502).json({ ok: false, error: delErr.message });
    return;
  }
  res.json({ ok: true, requeued: true, id: row.id, queue: queueKey });
}

/* ------------------------------------------------------------------ */
/* GET /api/workspaces + GET /api/doctor                               */
/* ------------------------------------------------------------------ */

async function handleWorkspaces(_req: Request, res: Response): Promise<void> {
  const db = requireDb(res);
  if (!db) return;
  const { data, error } = await db.from("workspaces").select("id,name,site_url").order("name").limit(100);
  if (error) {
    res.status(502).json({ ok: false, error: error.message });
    return;
  }
  const workspaces = ((data ?? []) as unknown as Array<{ id: string; name: string; site_url: string }>).map((w) => ({
    id: w.id,
    name: w.name || w.site_url || w.id,
    site_url: w.site_url,
  }));
  res.json({ workspaces });
}

async function handleDoctor(req: Request, res: Response): Promise<void> {
  const q = req.query as Record<string, unknown>;
  const ws = typeof q.workspace_id === "string" ? q.workspace_id : null;

  const env = {
    supabase_url: (process.env.SUPABASE_URL ?? "").trim() !== "",
    supabase_service_role: (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim() !== "",
    redis_url: (process.env.REDIS_URL ?? "").trim() !== "",
    openrouter: (process.env.OPENROUTER_API_KEY ?? "").trim() !== "",
    inception: (process.env.INCEPTION_API_KEY ?? "").trim() !== "",
    tinyfish: (process.env.TINYFISH_API_KEY ?? "").trim() !== "",
  };

  let supabase: string;
  try {
    const db = dbc();
    const { error } = await db.from("workspaces").select("id").limit(1);
    supabase = error ? `error: ${error.message.slice(0, 160)}` : "ok";
  } catch (e) {
    supabase = `error: ${String((e as Error)?.message ?? e).slice(0, 160)}`;
  }

  const redis = await pingRedis(1500).then(
    (ok) => (ok ? "ok" : "unreachable"),
    () => "unreachable",
  );

  res.json({
    api: "ok",
    time: new Date().toISOString(),
    workspace_id: ws,
    env,
    supabase,
    redis,
    queues: getSchedules().map((s) => ({ queue: s.queue, name: s.name, pattern: s.pattern })),
    // Failures that could not reach failed_jobs (no workspace context) or
    // degraded-lane skips. Empty array = nothing silent. Bounded to 50.
    recent_errors: recentLaneErrors(),
  });
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

export function start(port?: number): ReturnType<express.Express["listen"]> {
  const app = createApp();
  const listenPort = port ?? Number(process.env.PORT ?? 3000);
  return app.listen(listenPort, () => {
    console.info(`[api] listening on :${listenPort}`);
  });
}

const invokedAsMain =
  typeof process.argv[1] === "string" && /(^|[\\/])server\.(ts|js)$/.test(process.argv[1]);

if (invokedAsMain) {
  start();
}
