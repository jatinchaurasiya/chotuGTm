/**
 * Shared retry-with-backoff wrapper (capped attempts).
 *
 * Used by every pipeline lane for 429/5xx retries. Pure + dependency-free
 * (node builtins only). Idempotent jobs call this; dead-lettering stays
 * with the caller (worker-jobs lane).
 */

/** Hard cap so no lane can retry forever. */
export const MAX_ATTEMPTS_CAP = 5;
/** Default total attempts (first try + retries). */
export const DEFAULT_MAX_ATTEMPTS = 3;

export interface RetryOptions {
  /** Total attempts including the first try. Default 3, hard-capped at 5. */
  maxAttempts?: number;
  /** Base delay in ms before retry #1. Doubles each attempt. Default 500. */
  baseMs?: number;
  /** Ceiling for any single delay. Default 10_000. */
  maxMs?: number;
  /** Add +/-25% jitter to spread thundering herds. Default true. */
  jitter?: boolean;
  /** Return false to stop retrying (e.g. non-retryable 4xx). Default: retry everything. */
  retryOn?: (err: unknown, attempt: number) => boolean;
  /** Hook for logging each scheduled retry. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** AbortSignal to cancel waiting between attempts. */
  signal?: AbortSignal;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("retry sleep aborted"));
      return;
    }
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, ms));
    const onAbort = (): void => {
      clearTimeout(t);
      cleanup();
      reject(new Error("retry sleep aborted"));
    };
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 429 and 5xx are retryable; everything else is caller-decided. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Error carrying an HTTP status (fetch wrappers, API clients). */
export interface StatusCarrier {
  status?: number;
  statusCode?: number;
  code?: string;
}

export function getErrorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as StatusCarrier;
  if (typeof e.status === "number") return e.status;
  if (typeof e.statusCode === "number") return e.statusCode;
  return undefined;
}

/** Network-level failures (DNS, reset, timeout) are retryable; aborts are not. */
export function isRetryableError(err: unknown): boolean {
  const status = getErrorStatus(err);
  if (status !== undefined) return isRetryableStatus(status);
  if (err instanceof Error) {
    if (err.name === "AbortError") return false;
    const code = (err as StatusCarrier).code;
    if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return true;
    }
    // Undifferentiated fetch failures default to retryable (bounded by cap).
    if (err.name === "TypeError") return true;
  }
  return false;
}

function computeDelay(attempt: number, baseMs: number, maxMs: number, jitter: boolean): number {
  let delay = baseMs * 2 ** (attempt - 1);
  if (jitter) {
    const swing = delay * 0.25;
    delay = delay - swing + Math.random() * swing * 2;
  }
  return Math.min(maxMs, Math.max(0, Math.round(delay)));
}

/**
 * Run `fn` with exponential backoff. `fn` receives the 1-based attempt number.
 * Throws the last error after exhausting attempts.
 */
export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = Math.min(Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS), MAX_ATTEMPTS_CAP);
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 10_000;
  const jitter = opts.jitter ?? true;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) break;
      if (opts.retryOn && !opts.retryOn(err, attempt)) break;
      const delayMs = computeDelay(attempt, baseMs, maxMs, jitter);
      opts.onRetry?.(err, attempt, delayMs);
      await sleep(delayMs, opts.signal);
    }
  }
  throw lastError;
}
