/**
 * Discover lane: opportunity dedupe via sha256(normalized_url + normalized_title).
 * Duplicate inserts are ignored by the caller (idempotent jobs).
 */
import { createHash } from "node:crypto";

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "ref_url",
  "igshid",
]);

/** Lowercase host, drop www/fragment/tracking params, sort query, trim slashes. */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const u = new URL(trimmed);
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    // Reddit UI hosts are the same threads (old/new/np/shreddit).
    if (u.hostname.endsWith("reddit.com")) {
      u.hostname = "reddit.com";
    }
    u.hash = "";
    const kept: Array<[string, string]> = [];
    u.searchParams.forEach((value, key) => {
      const k = key.toLowerCase();
      if (!TRACKING_PARAMS.has(k) && !k.startsWith("utm_")) kept.push([k, value]);
    });
    kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    u.search = "";
    for (const [k, v] of kept) u.searchParams.append(k, v);
    let path = u.pathname.replace(/\/+$/, "");
    if (path === "") path = "/";
    // Reddit: old + www + new UI are the same thread; subreddit names are
    // case-insensitive, thread IDs are case-sensitive (keep ID case).
    path = path.replace(/^\/r\/([^/]+)\/comments\/([^/]+)\/.*$/, (_, sub: string, id: string) => `/r/${sub.toLowerCase()}/comments/${id}`);
    path = path.replace(/^\/r\/([^/]+)(\/.*)?$/, (_, sub: string, rest: string = "") => `/r/${sub.toLowerCase()}${rest}`);
    u.pathname = path;
    return u.toString();
  } catch {
    return trimmed.toLowerCase();
  }
}

/** Trim, lowercase, collapse internal whitespace. */
export function normalizeTitle(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Stable idempotency key: sha256 hex of normalized_url + "\n" + normalized_title. */
export function dedupeHash(url: string, title: string): string {
  return createHash("sha256").update(`${normalizeUrl(url)}\n${normalizeTitle(title)}`, "utf8").digest("hex");
}
