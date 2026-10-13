/**
 * Draft lane: OpenRouter chat completions client (OpenRouter ONLY, no gateway).
 *
 * Ordered models with failover. Verified live (Oct 2026):
 *   - `nvidia/nemotron-3-ultra-550b-a55b:free` works from plain API calls.
 *   - `thinkingmachines/inkling:free` is gated by OpenRouter to approved
 *     "agentic harnesses" (403 for direct callers) — kept as fallback in
 *     case the gate lifts; a gated-403 fails over instead of aborting.
 * Order via OPENROUTER_MODELS (comma list), else PRIMARY → FALLBACK env.
 * Model used is logged per call. True auth failures (bad key) abort fast;
 * deprecation (404/410) and model-gate (403) fail over to the next model.
 */
import { retry } from "../queue/retry.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GenerateOptions {
  system?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  fetchFn?: FetchLike;
  /** Ordered models to try. Defaults to primary → fallback from env. */
  models?: string[];
}

export interface GenerateResult {
  text: string;
  model: string;
  attempts: number;
}

export class LlmAuthError extends Error {
  constructor(status: number) {
    super(`OpenRouter auth failed (status=${status}). Check OPENROUTER_API_KEY.`);
    this.name = "LlmAuthError";
  }
}

export function readModels(): string[] {
  const list = (process.env.OPENROUTER_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  if (list.length > 0) return [...new Set(list)];
  const primary = process.env.OPENROUTER_PRIMARY_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b:free";
  const fallback = process.env.OPENROUTER_FALLBACK_MODEL ?? "thinkingmachines/inkling:free";
  return [...new Set([primary, fallback].map((m) => m.trim()).filter(Boolean))];
}

function isDeprecation(status: number): boolean {
  return status === 404 || status === 410;
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function toText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .join("");
  }
  return "";
}

async function attemptModel(
  model: string,
  messages: ChatMessage[],
  opts: Required<Pick<GenerateOptions, "maxTokens" | "temperature" | "timeoutMs">> & { fetchFn: FetchLike; apiKey: string },
): Promise<{ text: string; attempts: number }> {
  let usedAttempts = 0;
  const text = await retry(
    async (attempt) => {
      usedAttempts = attempt;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
      try {
        const res = await opts.fetchFn("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: opts.maxTokens,
            temperature: opts.temperature,
          }),
          signal: ctrl.signal,
        });
        if (res.status === 401) throw new LlmAuthError(res.status);
        if (res.status === 403) {
          // Distinguish a bad key (abort) from a per-model gate such as
          // OpenRouter's "only available on agentic harnesses" (fail over).
          const bodyText = await res.text().catch(() => "");
          if (/agentic harness|only available on/i.test(bodyText)) {
            const err = new Error(`Model gated for direct callers: ${model} (status=403).`);
            (err as { status?: number; failover?: boolean }).status = res.status;
            (err as { status?: number; failover?: boolean }).failover = true;
            throw err;
          }
          throw new LlmAuthError(res.status);
        }
        if (isDeprecation(res.status)) {
          const err = new Error(`Model deprecated/unavailable: ${model} (status=${res.status}).`);
          (err as { status?: number; failover?: boolean }).status = res.status;
          (err as { status?: number; failover?: boolean }).failover = true;
          throw err;
        }
        if (!res.ok) {
          const err = new Error(`OpenRouter ${model} failed (status=${res.status}).`);
          (err as { status?: number }).status = res.status;
          throw err;
        }
        const body = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
        const out = toText(body.choices?.[0]?.message?.content).trim();
        if (!out) throw new Error(`OpenRouter ${model} returned empty content.`);
        return out;
      } finally {
        clearTimeout(timer);
      }
    },
    {
      maxAttempts: 3,
      baseMs: 1000,
      retryOn: (err) => {
        if (err instanceof LlmAuthError) return false;
        if ((err as { failover?: boolean }).failover) return false;
        const s = (err as { status?: number }).status;
        if (s !== undefined) return isRetryable(s);
        return true;
      },
    },
  );
  return { text, attempts: usedAttempts };
}

export async function generateCompletion(
  prompt: string | ChatMessage[],
  opts: GenerateOptions = {},
): Promise<GenerateResult> {
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  if (!apiKey) throw new LlmAuthError(401);
  const messages: ChatMessage[] =
    typeof prompt === "string"
      ? [...(opts.system ? [{ role: "system" as const, content: opts.system }] : []), { role: "user" as const, content: prompt }]
      : prompt;
  const fetchFn = opts.fetchFn ?? fetch;
  const models = opts.models?.length ? opts.models : readModels();
  const base = {
    maxTokens: opts.maxTokens ?? 4000,
    temperature: opts.temperature ?? 0.7,
    timeoutMs: opts.timeoutMs ?? 120_000,
    fetchFn,
    apiKey,
  };

  let totalAttempts = 0;
  let lastError: unknown;
  for (const model of models) {
    try {
      const { text, attempts } = await attemptModel(model, messages, base);
      totalAttempts += attempts;
      console.info(`[draft] model=${model} attempts=${attempts}`);
      return { text, model, attempts: totalAttempts };
    } catch (err) {
      lastError = err;
      if (err instanceof LlmAuthError) throw err;
      console.warn(`[draft] model=${model} failed: ${String((err as Error)?.message ?? err)} — failing over.`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All OpenRouter models failed.");
}
