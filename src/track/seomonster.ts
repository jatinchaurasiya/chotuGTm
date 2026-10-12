/**
 * seomonster.ts — track-site runner (hourly per workspace, independent of posting).
 *
 * Runs seo-monster as a reader (never writer) via `uvx seo-monster`, parses the
 * JSON envelope, and maps it to `site_metrics` rows.
 *
 * Auth: Desktop-app OAuth `token.json` with scopes
 *   `webmasters.readonly` + `analytics.readonly`.
 *   - token.json MUST be chmod 0600 (user read/write only). This module checks
 *     with fs.stat and refuses to run if group/other have access.
 *   - Never commit token.json (gitignored). New workspace = add the SAME
 *     Google account as Viewer on the new GSC + GA4 properties (no new OAuth).
 *
 * Idempotent: caller should dedupe on (workspace_id, pulled_at::date, source).
 * Retry: subprocess spawn wrapped in retry-with-backoff; parse errors go to
 * failed_jobs (no silent drop).
 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

export interface SeoMonsterConfig {
  workspaceId: string;
  /** e.g. https://authormity.space */
  siteUrl: string;
  /** GSC property URI, defaults to siteUrl */
  propertyUri?: string;
  /** GA4 property id (numeric), optional but needed for signups/referrals */
  ga4PropertyId?: string;
  /** Absolute path to Desktop-app OAuth token.json (0600). */
  tokenPath?: string;
  /** Extra CLI args passthrough (kept minimal for 1GB box). */
  extraArgs?: string[];
  /** Subprocess timeout. Default 60s. */
  timeoutMs?: number;
  /** Override binary for tests. Default ['uvx', 'seo-monster']. */
  command?: string[];
}

export interface SeoEnvelope {
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
  referrals?: Record<string, number>;
  signups?: number;
  queries?: Array<{ query: string; clicks: number; impressions: number; position: number }>;
  pages?: Array<{ page: string; clicks: number; impressions: number }>;
  siteSearch?: Array<{ term: string; searches: number }>;
  [k: string]: unknown;
}

export interface SiteMetricRow {
  workspace_id: string;
  pulled_at: string; // ISO
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  referrals: Record<string, number>;
  signups: number;
}

export interface TopicSignal {
  kind: 'striking-distance' | 'content-opportunity' | 'site-search-gap';
  label: string;
  clicks: number;
  impressions: number;
  position: number | null;
}

const DEFAULT_CMD = ['uvx', 'seo-monster'];

export async function assertTokenPermissions(tokenPath: string): Promise<void> {
  const st = await stat(tokenPath);
  // 0o077 = group/other bits; any set => too open.
  if ((st.mode & 0o077) !== 0) {
    throw new Error(
      `refusing to use OAuth token at ${tokenPath}: mode ${(
        st.mode & 0o777
      ).toString(8)} is not 0600. Run: chmod 0600 ${tokenPath}`,
    );
  }
}

export function buildSeoMonsterArgs(cfg: SeoMonsterConfig): string[] {
  const property = cfg.propertyUri ?? cfg.siteUrl;
  const args = ['--format', 'json', '--site', property];
  if (cfg.ga4PropertyId) args.push('--ga4', cfg.ga4PropertyId);
  if (cfg.tokenPath) args.push('--token', cfg.tokenPath);
  if (cfg.extraArgs) args.push(...cfg.extraArgs);
  return args;
}

function runOnce(cmd: string[], args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], [...cmd.slice(1), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`seo-monster timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += String(d);
      if (stdout.length > 4_000_000) child.kill('SIGKILL');
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`seo-monster exit ${code}: ${stderr.slice(0, 1000)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Retry-with-backoff: 3 tries, exponential, no retry shaping needed (local proc). */
export async function runSeoMonsterRaw(
  cfg: SeoMonsterConfig,
  tries = 3,
): Promise<string> {
  if (cfg.tokenPath) await assertTokenPermissions(cfg.tokenPath);
  const cmd = cfg.command ?? DEFAULT_CMD;
  const args = buildSeoMonsterArgs(cfg);
  const timeoutMs = cfg.timeoutMs ?? 60_000;
  let delay = 1000;
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await runOnce(cmd, args, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (i === tries - 1) break;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
  throw lastErr;
}

/** Parse tolerant JSON envelope: bare object, {data:{...}}, or {result:{...}}. */
export function parseSeoEnvelope(raw: string): SeoEnvelope {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('seo-monster returned empty output');
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Some CLIs print log lines before JSON — recover last {...} block.
    const start = trimmed.lastIndexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('seo-monster output is not JSON');
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  }
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (o['data'] && typeof o['data'] === 'object') return o['data'] as SeoEnvelope;
    if (o['result'] && typeof o['result'] === 'object') return o['result'] as SeoEnvelope;
  }
  return parsed as SeoEnvelope;
}

export function envelopeToSiteMetric(
  workspaceId: string,
  env: SeoEnvelope,
  pulledAt: Date = new Date(),
): SiteMetricRow {
  const num = (v: unknown, fb = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
  };
  let referrals: Record<string, number> = {};
  const rawRef = env.referrals;
  if (rawRef && typeof rawRef === 'object') {
    for (const [k, v] of Object.entries(rawRef as Record<string, unknown>)) {
      referrals[k] = num(v, 0);
    }
  }
  return {
    workspace_id: workspaceId,
    pulled_at: pulledAt.toISOString(),
    clicks: num(env.clicks, 0),
    impressions: num(env.impressions, 0),
    ctr: num(env.ctr, 0),
    position: num(env.position, 0),
    referrals,
    signups: num(env.signups, 0),
  };
}

/**
 * Topic signals fed back as Medium/SEO draft themes:
 * - striking-distance: GSC queries ranking 8–20 (cheap wins)
 * - content-opportunity: high-impression / low-CTR queries
 * - site-search-gap: GA4 site-search terms with no ranking page
 */
export function extractTopicSignals(env: SeoEnvelope): TopicSignal[] {
  const out: TopicSignal[] = [];
  for (const q of env.queries ?? []) {
    const pos = Number(q.position);
    if (Number.isFinite(pos) && pos >= 8 && pos <= 20) {
      out.push({
        kind: 'striking-distance',
        label: q.query,
        clicks: Number(q.clicks) || 0,
        impressions: Number(q.impressions) || 0,
        position: pos,
      });
    } else if ((Number(q.impressions) || 0) > 500 && (Number(q.clicks) || 0) / Math.max(Number(q.impressions) || 1, 1) < 0.02) {
      out.push({
        kind: 'content-opportunity',
        label: q.query,
        clicks: Number(q.clicks) || 0,
        impressions: Number(q.impressions) || 0,
        position: Number.isFinite(pos) ? pos : null,
      });
    }
  }
  for (const s of env.siteSearch ?? []) {
    out.push({
      kind: 'site-search-gap',
      label: s.term,
      clicks: 0,
      impressions: Number(s.searches) || 0,
      position: null,
    });
  }
  return out;
}

export type SiteMetricsSink = (rows: SiteMetricRow[]) => Promise<void>;

/** Full track-site step for one workspace: run → parse → map → sink. */
export async function trackSiteWorkspace(
  cfg: SeoMonsterConfig,
  sink: SiteMetricsSink,
): Promise<{ row: SiteMetricRow; signals: TopicSignal[] }> {
  const raw = await runSeoMonsterRaw(cfg);
  const env = parseSeoEnvelope(raw);
  const row = envelopeToSiteMetric(cfg.workspaceId, env);
  await sink([row]); // caller inserts into site_metrics (dedupe on workspace+day)
  return { row, signals: extractTopicSignals(env) };
}
