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

export async function runDiscover(
  workspaceId: string,
  queries: Array<string | DiscoverQueryPlan>,
  deps: DiscoverDeps,
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
      const hash = dedupeHash(r.url, r.title);
      if (seenThisRun.has(hash)) {
        stats.duplicates += 1;
        continue;
      }
      seenThisRun.add(hash);

      const fetched = await deps.fetchPage(r.url);
      if (fetched.skipped) {
        noteSkip(r.url, fetched.reason);
        continue;
      }
      stats.fetched += 1;

      const opp: PreparedOpportunity = {
        workspaceId,
        url: r.url,
        finalUrl: fetched.finalUrl,
        title: r.title,
        snippet: r.snippet,
        source: r.source ?? "web",
        dedupeHash: hash,
        htmlLength: fetched.html.length,
        fetchedAt: new Date().toISOString(),
      };
      let inserted = false;
      try {
        inserted = await deps.insertOpportunity(opp);
      } catch (err) {
        console.warn(`[discover] insert failed hash=${hash.slice(0, 12)} err=${String(err)}`);
        continue;
      }
      if (inserted) stats.inserted += 1;
      else stats.duplicates += 1;
    }
  }

  console.info(
    `[discover] workspace=${workspaceId} queries=${stats.queries} candidates=${stats.candidates} ` +
      `fetched=${stats.fetched} inserted=${stats.inserted} duplicates=${stats.duplicates} ` +
      `skipped=${JSON.stringify(stats.skipped)}`,
  );
  return stats;
}
