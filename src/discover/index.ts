/**
 * Discover lane orchestrator: search → fetch → dedupe → insert opportunities.
 *
 * - NEW queries → TinyFish (budget-guarded). REPEAT queries → api-anything cache.
 * - Scrapling fetch: 403/login-wall/429 → log + SKIP (never escalate).
 * - Dedupe by sha256(normalized_url + normalized_title); duplicates ignored.
 * - Inserts are idempotent: `insertOpportunity` returns false for duplicates.
 *
 * Reddit + general web + Medium public pages only. X/LinkedIn out of scope.
 */
import { dedupeHash } from "./dedupe.js";
import type { TinyFishResult } from "./tinyfish.js";
import type { ScraplingResult } from "./scrapling.js";
import type { DirectCandidate } from "./reddit-rss.js";

export interface DiscoverQueryPlan {
  query: string;
  /** Repeat source → serve from api-anything cache instead of TinyFish. */
  isRepeat: boolean;
}

export interface PreparedOpportunity {
  workspaceId: string;
  url: string;
  finalUrl: string;
  title: string;
  snippet?: string;
  source: string;
  dedupeHash: string;
  htmlLength: number;
  fetchedAt: string;
}

export interface DiscoverDeps {
  /** NEW-source search (TinyFish). Must track its own budget/calls. */
  searchNew: (query: string) => Promise<TinyFishResult[]>;
  /** REPEAT-source search (api-anything cached queries). */
  searchRepeat: (query: string) => Promise<TinyFishResult[]>;
  fetchPage: (url: string) => Promise<ScraplingResult>;
  /** Insert; return true when a new row was created, false on duplicate. */
  insertOpportunity: (opp: PreparedOpportunity) => Promise<boolean>;
  onSkip?: (url: string, reason: string) => void;
}

export interface DiscoverRunStats {
  queries: number;
  candidates: number;
  fetched: number;
  skipped: Record<string, number>;
  inserted: number;
  duplicates: number;
}

function toPlan(queries: Array<string | DiscoverQueryPlan>): DiscoverQueryPlan[] {
  return queries.map((q) => (typeof q === "string" ? { query: q, isRepeat: false } : q));
}

async function ingestCandidate(
  workspaceId: string,
  c: { url: string; title: string; snippet?: string; source: string; skipFetch?: boolean },
  deps: DiscoverDeps,
  stats: DiscoverRunStats,
  seenThisRun: Set<string>,
  noteSkip: (url: string, reason: string) => void,
): Promise<void> {
  const hash = dedupeHash(c.url, c.title);
  if (seenThisRun.has(hash)) {
    stats.duplicates += 1;
    return;
  }
  seenThisRun.add(hash);

  let finalUrl = c.url;
  let htmlLength = (c.snippet ?? "").length;
  if (!c.skipFetch) {
    const fetched = await deps.fetchPage(c.url);
    if (fetched.skipped) {
      noteSkip(c.url, fetched.reason);
      return;
    }
    stats.fetched += 1;
    finalUrl = fetched.finalUrl;
    htmlLength = fetched.html.length;
  }

  const opp: PreparedOpportunity = {
    workspaceId,
    url: c.url,
    finalUrl,
    title: c.title,
    snippet: c.snippet,
    source: c.source,
    dedupeHash: hash,
    htmlLength,
    fetchedAt: new Date().toISOString(),
  };
  let inserted = false;
  try {
    inserted = await deps.insertOpportunity(opp);
  } catch (err) {
    console.warn(`[discover] insert failed hash=${hash.slice(0, 12)} err=${String(err)}`);
    return;
  }
  if (inserted) stats.inserted += 1;
  else stats.duplicates += 1;
}

export async function runDiscover(
  workspaceId: string,
  queries: Array<string | DiscoverQueryPlan>,
  deps: DiscoverDeps,
  direct: DirectCandidate[] = [],
): Promise<DiscoverRunStats> {
  const plans = toPlan(queries);
  const stats: DiscoverRunStats = {
    queries: plans.length,
    candidates: 0,
    fetched: 0,
    skipped: {},
    inserted: 0,
    duplicates: 0,
  };
  const seenThisRun = new Set<string>();
  const noteSkip = (url: string, reason: string): void => {
    stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
    deps.onSkip?.(url, reason);
  };

  for (const plan of plans) {
    let results: TinyFishResult[];
    try {
      results = plan.isRepeat ? await deps.searchRepeat(plan.query) : await deps.searchNew(plan.query);
    } catch (err) {
      // A failed search must not kill the run; other queries continue.
      console.warn(`[discover] search failed query=${JSON.stringify(plan.query)} err=${String(err)}`);
      continue;
    }

    for (const r of results) {
      stats.candidates += 1;
      await ingestCandidate(workspaceId, { url: r.url, title: r.title, snippet: r.snippet, source: r.source ?? "web" }, deps, stats, seenThisRun, noteSkip);
    }
  }

  // Prefetched candidates (e.g. Reddit RSS): same dedupe → fetch-or-skip →
  // insert path. skipFetch entries insert straight from feed content.
  for (const d of direct) {
    stats.candidates += 1;
    await ingestCandidate(workspaceId, d, deps, stats, seenThisRun, noteSkip);
  }

  console.info(
    `[discover] workspace=${workspaceId} queries=${stats.queries} candidates=${stats.candidates} ` +
      `fetched=${stats.fetched} inserted=${stats.inserted} duplicates=${stats.duplicates} ` +
      `skipped=${JSON.stringify(stats.skipped)}`,
  );
  return stats;
}
