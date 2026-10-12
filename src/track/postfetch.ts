/**
 * postfetch.ts — track-post (daily per published_posts URL).
 *
 * Re-fetches PUBLIC engagement only and writes `post_metrics` rows:
 *   post_metrics(published_post_id, pulled_at, upvotes, comments, reactions, claps)
 *
 * Rules (hard):
 * - skip-on-wall: never defeat login walls, paywalls, or CAPTCHAs. On 401/403,
 *   login redirect, or JS-wall marker, record { skipped: true, reason } and move
 *   on. No retries against walls, no credential tricks.
 * - retry-with-backoff for transient network/5xx/429 only.
 * - idempotent: one row per (published_post_id, pulled_at::date) — dedupe in sink.
 */
export interface PublishedPost {
  id: string;
  workspace_id: string;
  draft_id: string | null;
  platform: string; // 'reddit' | 'medium' | 'linkedin' | 'x' | ...
  live_url: string;
}

export interface PostMetric {
  published_post_id: string;
  pulled_at: string; // ISO
  upvotes: number | null;
  comments: number | null;
  reactions: number | null;
  claps: number | null;
}

export interface Skipped {
  skipped: true;
  reason: string;
}

export class WallBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WallBlockedError';
  }
}

const WALL_MARKERS = [
  'sign in to continue',
  'log in to continue',
  'login to continue',
  'create an account to continue',
  'cloudflare',
  'cf-challenge',
  'captcha',
  'just a moment',
];

export function looksLikeWall(status: number, body: string, finalUrl?: string): boolean {
  if (status === 401 || status === 403) return true;
  if (finalUrl && /\/log-?in\b|\/sign-?in\b|\/auth\b/i.test(finalUrl)) return true;
  const low = body.slice(0, 20_000).toLowerCase();
  return WALL_MARKERS.some((m) => low.includes(m));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** GET with backoff for transient faults; throws WallBlockedError immediately on walls. */
export async function publicGet(
  url: string,
  opts: { timeoutMs?: number; tries?: number } = {},
): Promise<{ status: number; body: string; finalUrl: string }> {
  const tries = opts.tries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let delay = 800;
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'user-agent': 'chotu-track/0.1 (+public read-only; respects robots)',
          accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        },
      });
      const body = await res.text().catch(() => '');
      if (looksLikeWall(res.status, body, res.url)) {
        throw new WallBlockedError(`wall at ${url} (status ${res.status})`);
      }
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`transient HTTP ${res.status} for ${url}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return { status: res.status, body, finalUrl: res.url };
    } catch (e) {
      if (e instanceof WallBlockedError) throw e; // never retry walls
      lastErr = e;
      if (i === tries - 1) break;
      await sleep(delay);
      delay *= 2;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Reddit: public .json endpoint is wall-free for public subs; private/quarantined → skip. */
export async function fetchReddit(url: string): Promise<Omit<PostMetric, 'published_post_id' | 'pulled_at'>> {
  const jsonUrl = url.replace(/\/$/, '') + '.json';
  let raw: string;
  try {
    const r = await publicGet(jsonUrl);
    raw = r.body;
  } catch (e) {
    if (e instanceof WallBlockedError) throw e;
    throw e;
  }
  try {
    const data = JSON.parse(raw);
    const post = Array.isArray(data) ? data[0]?.data?.children?.[0]?.data : data?.data?.children?.[0]?.data;
    const comments = Array.isArray(data) ? data[1]?.data?.children?.length : null;
    return {
      upvotes: numOrNull(post?.score ?? post?.ups),
      comments: numOrNull(comments ?? post?.num_comments),
      reactions: null,
      claps: null,
    };
  } catch {
    throw new WallBlockedError(`reddit response not public JSON for ${url}`);
  }
}

/** Medium: public pages may render; member-only/login wall → skip. Claps parsed best-effort. */
export async function fetchMedium(url: string): Promise<Omit<PostMetric, 'published_post_id' | 'pulled_at'>> {
  const { body } = await publicGet(url);
  // Best-effort clap extraction from embedded JSON; null when absent.
  const m = body.match(/"clapCount":\s*(\d+)/) ?? body.match(/claps?["']?\s*:\s*(\d+)/i);
  const responses = body.match(/"responseCount":\s*(\d+)/) ?? body.match(/"responsesCount":\s*(\d+)/);
  return {
    upvotes: null,
    comments: numOrNull(responses?.[1]),
    reactions: null,
    claps: numOrNull(m?.[1]),
  };
}

/** LinkedIn / X / others: no reliable public counts without login → skip-on-wall by policy. */
export function skipNoPublicApi(platform: string): Skipped {
  return {
    skipped: true,
    reason: `${platform}: no public engagement endpoint without login; skip-on-wall (never defeat login walls)`,
  };
}

export async function fetchPostEngagement(
  post: PublishedPost,
): Promise<PostMetric | Skipped> {
  const platform = (post.platform || '').toLowerCase();
  const pulled_at = new Date().toISOString();
  try {
    if (platform === 'reddit') {
      const m = await fetchReddit(post.live_url);
      return { published_post_id: post.id, pulled_at, ...m };
    }
    if (platform === 'medium') {
      const m = await fetchMedium(post.live_url);
      return { published_post_id: post.id, pulled_at, ...m };
    }
    return skipNoPublicApi(post.platform || 'unknown');
  } catch (e) {
    if (e instanceof WallBlockedError) {
      return { skipped: true, reason: e.message };
    }
    throw e; // transient/unknown → caller dead-letters to failed_jobs
  }
}

export type PostMetricsSink = (row: PostMetric) => Promise<void>;

/** Daily track-post step for one published post. Walls resolve to skip (no row). */
export async function trackPost(
  post: PublishedPost,
  sink: PostMetricsSink,
): Promise<PostMetric | Skipped> {
  const res = await fetchPostEngagement(post);
  if (!('skipped' in res)) await sink(res);
  return res;
}
