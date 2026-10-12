/**
 * Discover lane: api-anything cached-query wrapper.
 *
 * REPEAT sources (subreddit polls, keyword monitors, URL re-checks) go through
 * here so we don't burn TinyFish budget. In-memory TTL cache + single-flight
 * (concurrent callers share one loader promise). Swap for Redis later without
 * changing call sites.
 */

export interface CachedOutcome<T> {
  data: T;
  cached: boolean;
  /** ms since the entry was stored (0 on a fresh miss). */
  ageMs: number;
}

interface Entry<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
}

export class MemoryTtlCache<T = unknown> {
  private store = new Map<string, Entry<T>>();

  constructor(private defaultTtlMs: number = 15 * 60 * 1000) {}

  get(key: string): { value: T; ageMs: number } | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() >= e.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return { value: e.value, ageMs: Date.now() - e.storedAt };
  }

  set(key: string, value: T, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTtlMs;
    const now = Date.now();
    this.store.set(key, { value, storedAt: now, expiresAt: now + ttl });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    this.prune();
    return this.store.size;
  }

  prune(): void {
    const now = Date.now();
    for (const [k, e] of this.store) {
      if (now >= e.expiresAt) this.store.delete(k);
    }
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ApiAnythingClientOptions {
  /** Default TTL for cached queries. Default 15 min. */
  ttlMs?: number;
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: FetchLike;
  /** Inject a shared cache (e.g. one per worker process). */
  cache?: MemoryTtlCache<unknown>;
  timeoutMs?: number;
}

export class ApiAnythingClient {
  readonly cache: MemoryTtlCache<unknown>;
  private readonly ttlMs: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private inflight = new Map<string, Promise<unknown>>();
  private hits = 0;
  private misses = 0;

  constructor(opts: ApiAnythingClientOptions = {}) {
    this.ttlMs = opts.ttlMs ?? Number(process.env.APIANYTHING_TTL_MS ?? 15 * 60 * 1000);
    this.apiKey = opts.apiKey ?? process.env.APIANYTHING_API_KEY ?? "";
    this.baseUrl = opts.baseUrl ?? process.env.APIANYTHING_API_URL ?? "https://api.api-anything.dev/v1";
    this.fetchFn = opts.fetchFn ?? fetch;
    this.cache = opts.cache ?? new MemoryTtlCache<unknown>(this.ttlMs);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Stable cache key from query parts (source + params). */
  static buildKey(parts: Array<string | number | boolean>): string {
    return parts.map((p) => String(p).trim().toLowerCase()).join("|");
  }

  /**
   * Return the cached value when fresh; otherwise run `loader` once even under
   * concurrency (single-flight), cache it, and return with cached=false.
   */
  async query<T>(cacheKey: string, loader: () => Promise<T>, ttlMs?: number): Promise<CachedOutcome<T>> {
    const hit = this.cache.get(cacheKey) as { value: T; ageMs: number } | undefined;
    if (hit) {
      this.hits += 1;
      return { data: hit.value, cached: true, ageMs: hit.ageMs };
    }
    const running = this.inflight.get(cacheKey) as Promise<T> | undefined;
    if (running) {
      const data = await running;
      return { data, cached: true, ageMs: 0 };
    }
    this.misses += 1;
    const p = loader();
    this.inflight.set(cacheKey, p);
    try {
      const data = await p;
      this.cache.set(cacheKey, data, ttlMs ?? this.ttlMs);
      return { data, cached: false, ageMs: 0 };
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  /** Convenience: cached GET returning parsed JSON. */
  async cachedFetchJson<T>(cacheKey: string, path: string, ttlMs?: number): Promise<CachedOutcome<T>> {
    return this.query<T>(
      cacheKey,
      async () => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
        try {
          const res = await this.fetchFn(`${this.baseUrl}${path}`, {
            headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
            signal: ctrl.signal,
          });
          if (!res.ok) throw new Error(`api-anything fetch failed (status=${res.status}).`);
          return (await res.json()) as T;
        } finally {
          clearTimeout(t);
        }
      },
      ttlMs,
    );
  }

  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.cache.size };
  }
}
