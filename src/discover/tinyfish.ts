/**
 * Discover lane: TinyFish Search API client.
 *
 * Used for NEW sources/keywords only (preserve the free cap). Repeat polls go
 * through the api-anything cache (apianything.ts). Stub-friendly: inject
 * `fetchFn` + a fake key in tests; no network needed.
 */
import { retry, isRetryableStatus } from "../queue/retry.js";

export interface TinyFishResult {
  url: string;
  title: string;
  snippet?: string;
  publishedAt?: string;
  source?: string;
  score?: number;
}

export interface TinyFishSearchInput {
  query: string;
  count?: number;
  country?: string;
  safeSearch?: boolean;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class TinyFishMissingKeyError extends Error {
  constructor() {
    super("TINYFISH_API_KEY is missing. Set it in env or pass apiKey explicitly.");
    this.name = "TinyFishMissingKeyError";
  }
}

export class TinyFishBudgetExhaustedError extends Error {
  constructor(limit: number) {
    super(`TinyFish budget exhausted (limit=${limit}). Skipping NEW-source search this run.`);
    this.name = "TinyFishBudgetExhaustedError";
  }
}

export class TinyFishRateLimitError extends Error {
  constructor() {
    super("TinyFish API rate-limited (429) after retries. Backing off; repeat queries continue via cache.");
    this.name = "TinyFishRateLimitError";
  }
}

/** Per-run counter so a run never blows the free cap. */
export class TinyFishBudget {
  private used = 0;

  constructor(public readonly limit: number = 100) {}

  get calls(): number {
    return this.used;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  canSpend(n = 1): boolean {
    return this.used + n <= this.limit;
  }

  record(n = 1): void {
    if (!this.canSpend(n)) throw new TinyFishBudgetExhaustedError(this.limit);
    this.used += n;
  }
}

export interface TinyFishClientOptions {
  apiKey?: string;
  baseUrl?: string;
  budget?: TinyFishBudget;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

interface RawResult {
  url?: string;
  link?: string;
  title?: string;
  snippet?: string;
  description?: string;
  publishedAt?: string;
  published?: string;
  source?: string;
  score?: number;
}

function toResult(r: RawResult): TinyFishResult | null {
  const url = (r.url ?? r.link ?? "").trim();
  const title = (r.title ?? "").trim();
  if (!url || !title) return null;
  return {
    url,
    title,
    snippet: r.snippet ?? r.description,
    publishedAt: r.publishedAt ?? r.published,
    source: r.source,
    score: typeof r.score === "number" ? r.score : undefined,
  };
}

function extractResults(body: unknown): RawResult[] {
  if (typeof body !== "object" || body === null) return [];
  const b = body as Record<string, unknown>;
  const candidates = [b.results, b.items, b.data, (b.web as Record<string, unknown> | undefined)?.results];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as RawResult[];
  }
  return [];
}

export class TinyFishClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  readonly budget: TinyFishBudget;
  private totalCalls = 0;

  constructor(opts: TinyFishClientOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.TINYFISH_API_KEY ?? "";
    this.baseUrl =
      opts.baseUrl ?? process.env.TINYFISH_API_URL ?? "https://api.tinyfish.ai/v1/search";
    this.budget = opts.budget ?? new TinyFishBudget(Number(process.env.TINYFISH_BUDGET ?? 100));
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Lifetime call count for per-run logging ("TinyFish calls: N"). */
  get callCount(): number {
    return this.totalCalls;
  }

  async search(input: TinyFishSearchInput): Promise<TinyFishResult[]> {
    if (!this.apiKey) throw new TinyFishMissingKeyError();
    const query = input.query.trim();
    if (!query) return [];
    this.budget.record(1);

    const body = {
      query,
      count: input.count ?? 10,
      ...(input.country ? { country: input.country } : {}),
      ...(input.safeSearch !== undefined ? { safe_search: input.safeSearch } : {}),
    };

    const res = await retry(
      async () => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
        try {
          const r = await this.fetchFn(this.baseUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });
          if (r.status === 429) throw new TinyFishRateLimitError();
          if (r.status === 401 || r.status === 403) {
            throw new Error(`TinyFish auth failed (status=${r.status}). Check TINYFISH_API_KEY.`);
          }
          if (!r.ok && !isRetryableStatus(r.status)) {
            throw new Error(`TinyFish search failed (status=${r.status}).`);
          }
          if (!r.ok) throw new Error(`TinyFish search failed (status=${r.status}).`);
          return r;
        } finally {
          clearTimeout(t);
        }
      },
      {
        maxAttempts: 3,
        baseMs: 1000,
        retryOn: (err) =>
          err instanceof TinyFishRateLimitError || /status=5\d\d/.test(String((err as Error)?.message ?? "")),
      },
    );

    this.totalCalls += 1;
    const json = (await res.json()) as unknown;
    return extractResults(json).map(toResult).filter((r): r is TinyFishResult => r !== null);
  }
}
