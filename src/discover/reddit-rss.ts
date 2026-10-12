/**
 * Reddit discovery WITHOUT OAuth (discover-scraper lane).
 *
 * Context: Reddit closed self-service API access (Responsible Builder
 * Policy, Nov 2025) — new script-app credentials need a manual approval
 * with multi-week waits. This module is the production path until then.
 *
 * Verified live (Oct 2026, from a server IP):
 * - subreddit public RSS (/r/{sub}/{hot,new}/.rss) WORKS, no auth.
 * - old.reddit .json is blocked (empty). Jina anonymous is 403 for
 *   reddit.com. Arctic Shift unreachable. search.rss throttled to zero.
 *
 * Hard limit: Reddit throttles RSS per IP (~1 uncached req / 25-60s, then
 * empty 200s). So: sequential fetches, 45s default spacing, max ~10
 * subreddits per run, 2x/day. A full run takes ~8 min — fine for a cron
 * worker, fatal for anything interactive. Never parallelize, never retry
 * aggressively: a throttle is a SKIP, not an error.
 */

export interface RssEntry {
  title: string;
  url: string;
  updated: string;
  author: string;
  excerpt: string;
}

export interface DirectCandidate {
  url: string;
  title: string;
  snippet?: string;
  source: string;
  /** True → insert from feed content, skip the thread fetch entirely. */
  skipFetch?: boolean;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#[a-zA-Z0-9]+;/g, " ");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function tagContent(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
}

/** Parse an Atom feed (Reddit RSS) into entries. Pure — fully unit-testable. */
export function parseRssFeed(xml: string): RssEntry[] {
  const out: RssEntry[] = [];
  const blocks = xml.match(/<entry>([\s\S]*?)<\/entry>/g) ?? [];
  for (const b of blocks) {
    const rawTitle = tagContent(b, "title");
    if (!rawTitle) continue;
    const linkMatch = b.match(/<link\s[^>]*href="([^"]+)"/);
    const rawContent = tagContent(b, "content") ?? "";
    const authorBlock = tagContent(b, "author") ?? "";
    const authorMatch = authorBlock.match(/<name>([\s\S]*?)<\/name>/);
    const url = (linkMatch?.[1] ?? "").trim();
    if (!url) continue;
    out.push({
      title: stripTags(decodeEntities(rawTitle)).slice(0, 300),
      url,
      updated: (tagContent(b, "updated") ?? "").trim(),
      author: authorMatch ? stripTags(decodeEntities(authorMatch[1])) : "",
      excerpt: stripTags(decodeEntities(rawContent)).slice(0, 500),
    });
  }
  return out;
}

export interface RedditRssOptions {
  minIntervalMs?: number;
  userAgent?: string;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
}

const DEFAULT_UA = "chotu/0.1 (no-auth reddit research poller; 1 req/45s; contact: local)";
let lastFetchAt = 0;

/** For tests: reset the module-level throttle clock. */
export function resetRssThrottle(): void {
  lastFetchAt = 0;
}

export function readRssIntervalMs(): number {
  const raw = Number(process.env.REDDIT_RSS_MIN_INTERVAL_MS ?? 45000);
  return Number.isFinite(raw) && raw >= 10000 ? raw : 45000;
}

export function readRssMaxSubs(): number {
  const raw = Number(process.env.REDDIT_RSS_MAX_SUBS ?? 10);
  return Number.isFinite(raw) && raw >= 1 && raw <= 25 ? Math.floor(raw) : 10;
}

async function fetchFeedText(url: string, opts: RedditRssOptions): Promise<{ ok: true; xml: string } | { ok: false; reason: string }> {
  const minInterval = opts.minIntervalMs ?? readRssIntervalMs();
  const now = opts.nowFn ?? Date.now;
  const sleep = opts.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const wait = lastFetchAt + minInterval - now();
  if (wait > 0) await sleep(wait);
  const fetchFn = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    lastFetchAt = now();
    res = await fetchFn(url, { headers: { "user-agent": opts.userAgent ?? DEFAULT_UA } });
  } catch (e) {
    return { ok: false, reason: "rss-network-error" };
  }
  if (res.status === 429) return { ok: false, reason: "rss-throttled" };
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "rss-blocked" };
  if (!res.ok) return { ok: false, reason: `rss-http-${res.status}` };
  const xml = await res.text();
  // Throttled RSS returns 200 with an empty/gutted body — treat as skip.
  if (xml.length < 500 || !xml.includes("<entry>")) return { ok: false, reason: "rss-throttled" };
  return { ok: true, xml };
}

export interface RssPollResult {
  candidates: DirectCandidate[];
  skipped: Record<string, number>;
}

/**
 * Poll subreddits (sequential, throttled). Entries become skipFetch
 * candidates: the feed carries title + body, so no thread fetch is needed
 * (thread pages are login-walled from servers anyway).
 */
export async function pollSubreddits(
  subs: string[],
  sorts: Array<"hot" | "new"> = ["hot"],
  opts: RedditRssOptions = {},
): Promise<RssPollResult> {
  const candidates: DirectCandidate[] = [];
  const skipped: Record<string, number> = {};
  const max = readRssMaxSubs();
  for (const sub of subs.slice(0, max)) {
    for (const sort of sorts) {
      const url = `https://www.reddit.com/r/${sub}/${sort}/.rss`;
      const res = await fetchFeedText(url, opts);
      if (!res.ok) {
        skipped[res.reason] = (skipped[res.reason] ?? 0) + 1;
        continue;
      }
      for (const e of parseRssFeed(res.xml)) {
        candidates.push({
          url: e.url,
          title: e.title,
          snippet: e.excerpt,
          source: "reddit-rss",
          skipFetch: true,
        });
      }
    }
  }
  return { candidates, skipped };
}

/** Which Reddit tier is active. 'oauth' is reserved for approved credentials. */
export function redditTier(): "oauth" | "rss" {
  const forced = (process.env.REDDIT_SOURCE ?? "auto").trim().toLowerCase();
  if (forced === "rss") return "rss";
  if (forced === "oauth") return "oauth";
  const hasCreds =
    (process.env.REDDIT_CLIENT_ID ?? "").trim() !== "" &&
    (process.env.REDDIT_CLIENT_SECRET ?? "").trim() !== "";
  return hasCreds ? "oauth" : "rss";
}
