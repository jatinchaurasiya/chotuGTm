/**
 * attribution.ts — learn join (weekly).
 *
 * Joins each published post's ±3d window against site traffic vs a pre-window
 * baseline to produce `attribution_scores` rows:
 *   attribution_scores(workspace_id, published_post_id, window_start, window_end,
 *                      traffic_lift, signup_lift, method)
 *
 * Method labeling:
 * - 'exact'  — UTM-exact: the post's utm_campaign (or live_url UTM params)
 *              appears in the window's referral/signup UTMs. Stronger claim.
 * - 'inferred' — window lift only, no UTM evidence. Directional, not accounting.
 *
 * Everything here is labeled directional per build contract.
 */
export interface SitePoint {
  pulled_at: string; // ISO
  clicks: number;
  impressions: number;
  signups: number;
  referrals?: Record<string, number> | string;
}

export interface AttributedPost {
  published_post_id: string;
  workspace_id: string;
  published_at: string; // ISO
  live_url?: string;
  /** Stored utm string or campaign, e.g. "utm_campaign=ws_2026-01-04" or raw querystring. */
  utm?: string;
  platform?: string;
  angle?: string;
  hook?: string;
  channel?: string;
}

export type AttributionMethod = 'exact' | 'inferred';

export interface AttributionScore {
  workspace_id: string;
  published_post_id: string;
  window_start: string; // ISO date
  window_end: string; // ISO date
  traffic_lift: number;
  signup_lift: number;
  method: AttributionMethod;
}

export const WINDOW_DAYS = 3;
export const BASELINE_DAYS = 7;

export function addDays(d: Date, n: number): Date {
  const c = new Date(d);
  c.setUTCDate(c.getUTCDate() + n);
  return c;
}

function dayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function avg(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** Collapse site points to per-day totals (clicks+impressions as traffic, signups). */
export function dailySeries(points: SitePoint[]): Map<string, { traffic: number; signups: number }> {
  const m = new Map<string, { traffic: number; signups: number }>();
  for (const p of points) {
    const k = dayKey(p.pulled_at);
    const cur = m.get(k) ?? { traffic: 0, signups: 0 };
    cur.traffic += (Number(p.clicks) || 0) + (Number(p.impressions) || 0);
    cur.signups += Number(p.signups) || 0;
    m.set(k, cur);
  }
  return m;
}

/** UTM-exact check: does the post campaign token appear in window referral keys/values? */
export function hasUtmEvidence(post: AttributedPost, windowPoints: SitePoint[]): boolean {
  const utm = (post.utm || post.live_url || '').toLowerCase();
  const m = utm.match(/utm_campaign=([^&#\s]+)/);
  const token = (m?.[1] ?? '').toLowerCase();
  if (!token) return false;
  for (const p of windowPoints) {
    let ref = p.referrals;
    if (typeof ref === 'string') {
      if (ref.toLowerCase().includes(token)) return true;
      continue;
    }
    if (ref && typeof ref === 'object') {
      const blob = JSON.stringify(ref).toLowerCase();
      if (blob.includes(token)) return true;
    }
  }
  return false;
}

function lift(windowAvg: number, baseAvg: number): number {
  if (baseAvg <= 0) return windowAvg > 0 ? 1 : 0; // from-zero launch counts as +1.0
  return (windowAvg - baseAvg) / baseAvg;
}

export function attributePost(
  post: AttributedPost,
  points: SitePoint[],
  windowDays: number = WINDOW_DAYS,
  baselineDays: number = BASELINE_DAYS,
): AttributionScore {
  const pub = new Date(post.published_at);
  const windowStart = addDays(pub, -windowDays);
  const windowEnd = addDays(pub, windowDays);
  const baselineStart = addDays(pub, -(windowDays + baselineDays));

  const inWindow: SitePoint[] = [];
  const inBaseline: SitePoint[] = [];
  for (const p of points) {
    const t = new Date(p.pulled_at);
    if (t >= windowStart && t <= windowEnd) inWindow.push(p);
    else if (t >= baselineStart && t < windowStart) inBaseline.push(p);
  }

  const byDay = dailySeries(inWindow);
  const byBase = dailySeries(inBaseline);
  const wTraffic = avg([...byDay.values()].map((d) => d.traffic));
  const bTraffic = avg([...byBase.values()].map((d) => d.traffic));
  const wSign = avg([...byDay.values()].map((d) => d.signups));
  const bSign = avg([...byBase.values()].map((d) => d.signups));

  return {
    workspace_id: post.workspace_id,
    published_post_id: post.published_post_id,
    window_start: windowStart.toISOString().slice(0, 10),
    window_end: windowEnd.toISOString().slice(0, 10),
    traffic_lift: Number(lift(wTraffic, bTraffic).toFixed(4)),
    signup_lift: Number(lift(wSign, bSign).toFixed(4)),
    method: hasUtmEvidence(post, inWindow) ? 'exact' : 'inferred',
  };
}

/** Batch: one score row per post with site points already scoped to the workspace. */
export function buildAttributionScores(
  posts: AttributedPost[],
  points: SitePoint[],
): AttributionScore[] {
  return posts.map((p) => attributePost(p, points));
}
