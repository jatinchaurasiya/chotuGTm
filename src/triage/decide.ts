/**
 * Triage lane (primary): Inception Labs DIRECT API — SystemOne Decisions.
 *
 * Never via OpenRouter. Scores relevance + intent → mercury_score 0..1.
 * Bands: >= high (0.75) draft-eligible, [low, high) maybe-queue (dashboard
 * skim, no auto-draft), < low discard. Thresholds from env.
 * Cost: ~$0.021/1M input tokens, output free; tokens + cost logged per batch.
 */
import { retry, isRetryableStatus } from "../queue/retry.js";

export type TriageBand = "draft" | "maybe" | "discard";

export interface TriageDecision {
  score: number;
  band: TriageBand;
  relevance: number;
  intent: number;
  model: string;
  inputTokens?: number;
  costUsd?: number;
  backstop: false;
}

export interface DecideInput {
  title: string;
  snippet?: string;
  url?: string;
  workspaceContext?: string;
}

export interface DecideOptions {
  apiKey?: string;
  apiUrl?: string;
  model?: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  high?: number;
  low?: number;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function readThresholds(): { high: number; low: number } {
  const high = Number(process.env.TRIAGE_THRESHOLD ?? 0.75);
  const low = Number(process.env.MAYBE_MIN ?? 0.5);
  return {
    high: Number.isFinite(high) ? high : 0.75,
    low: Number.isFinite(low) ? low : 0.5,
  };
}

export function bandFor(score: number, high?: number, low?: number): TriageBand {
  const t = { high: high ?? 0.75, low: low ?? 0.5 };
  if (score >= t.high) return "draft";
  if (score >= t.low) return "maybe";
  return "discard";
}

/** relevance 60% + intent 40%, clamped + rounded to 3dp. Shared with the backstop. */
export function combineScores(relevance: number, intent: number): number {
  const clamp = (n: number): number => Math.min(1, Math.max(0, n));
  return Math.round((0.6 * clamp(relevance) + 0.4 * clamp(intent)) * 1000) / 1000;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** SystemOne-style decisions payload: state + typed yes/no + score questions. */
function buildDecisionsPayload(model: string, input: DecideInput): Record<string, unknown> {
  return {
    model,
    state: {
      title: input.title,
      snippet: input.snippet ?? "",
      url: input.url ?? "",
      workspace_context: input.workspaceContext ?? "",
    },
    questions: [
      { id: "relevant", type: "yes_no", text: "Is this opportunity relevant to the workspace offering?" },
      { id: "intent", type: "yes_no", text: "Does the author show active buying, switching, or research intent?" },
      {
        id: "relevance_score",
        type: "score",
        text: "Calibrated probability 0..1 that this opportunity is relevant to the workspace offering.",
      },
      {
        id: "intent_score",
        type: "score",
        text: "Calibrated probability 0..1 that the author will act (reply/click/convert) if engaged well.",
      },
    ],
    response_format: { type: "json_object" },
  };
}

/** Pull the first JSON object out of a model text blob (tolerates fences/prose). */
function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return clamp01(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return clamp01(Number(v));
  return undefined;
}

function yesNo(v: unknown, fallback: number): number {
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["yes", "true", "y"].includes(s)) return 0.85;
    if (["no", "false", "n"].includes(s)) return 0.15;
  }
  if (typeof v === "boolean") return v ? 0.85 : 0.15;
  return fallback;
}

function answersFrom(body: unknown): { relevance: number; intent: number; inputTokens?: number } {
  let node: unknown = body;
  if (typeof body === "object" && body !== null) {
    const b = body as Record<string, unknown>;
    // Accept several envelope shapes; fall back to the body itself.
    node = b.answers ?? b.decisions ?? b.result ?? b.data ?? body;
    if (typeof node === "object" && node !== null && !("relevant" in node) && !("relevance_score" in node)) {
      const inner = node as Record<string, unknown>;
      const choices = (body as Record<string, unknown>).choices as Array<{ message?: { content?: unknown } }> | undefined;
      const content = choices?.[0]?.message?.content;
      if (typeof content === "string") {
        const parsed = extractJson(content);
        if (parsed) node = parsed;
      } else if (typeof inner.output_text === "string") {
        const parsed = extractJson(inner.output_text);
        if (parsed) node = parsed;
      }
    }
  }
  if (typeof node === "string") node = extractJson(node) ?? {};
  const a = (typeof node === "object" && node !== null ? node : {}) as Record<string, unknown>;
  const relevance = num(a.relevance_score ?? a.relevance) ?? yesNo(a.relevant, 0.5);
  const intent = num(a.intent_score ?? a.intent) ?? yesNo(a.intent, 0.5);
  let inputTokens: number | undefined;
  const usage = (body as Record<string, unknown> | null)?.usage as Record<string, unknown> | undefined;
  if (usage && typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
  else if (usage && typeof usage.prompt_tokens === "number") inputTokens = usage.prompt_tokens;
  return { relevance, intent, inputTokens };
}

export class TriageAuthError extends Error {
  constructor() {
    super("Inception Labs auth failed. Check INCEPTION_API_KEY.");
    this.name = "TriageAuthError";
  }
}

export async function decideMercury(input: DecideInput, opts: DecideOptions = {}): Promise<TriageDecision> {
  const apiKey = opts.apiKey ?? process.env.INCEPTION_API_KEY ?? "";
  if (!apiKey) throw new TriageAuthError();
  const apiUrl = opts.apiUrl ?? process.env.INCEPTION_API_URL ?? "https://api.inceptionlabs.ai";
  const model = opts.model ?? process.env.INCEPTION_MODEL ?? "mercury-system-one";
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const { high, low } = { high: opts.high ?? readThresholds().high, low: opts.low ?? readThresholds().low };

  const res = await retry(
    async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetchFn(`${apiUrl}/v1/decisions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(buildDecisionsPayload(model, input)),
          signal: ctrl.signal,
        });
        if (r.status === 401 || r.status === 403) throw new TriageAuthError();
        if (!r.ok) {
          const err = new Error(`Inception decisions failed (status=${r.status}).`);
          (err as { status?: number }).status = r.status;
          throw err;
        }
        return r;
      } finally {
        clearTimeout(t);
      }
    },
    { maxAttempts: 3, baseMs: 1000, retryOn: (err) => isRetryableStatus((err as { status?: number }).status ?? 0) },
  );

  const body = (await res.json()) as unknown;
  const { relevance, intent, inputTokens } = answersFrom(body);
  const score = combineScores(relevance, intent);
  const costPerMtok = Number(process.env.INCEPTION_INPUT_COST_PER_MTOK ?? 0.021);
  const costUsd = inputTokens !== undefined ? Math.round((inputTokens / 1_000_000) * costPerMtok * 1e6) / 1e6 : undefined;
  return { score, band: bandFor(score, high, low), relevance, intent, model, inputTokens, costUsd, backstop: false };
}

/** Batch path: scores N inputs, logs tokens + cost per batch. */
export async function decideMercuryBatch(
  inputs: DecideInput[],
  opts: DecideOptions = {},
): Promise<TriageDecision[]> {
  const out: TriageDecision[] = [];
  for (const input of inputs) out.push(await decideMercury(input, opts));
  const tokens = out.reduce((s, d) => s + (d.inputTokens ?? 0), 0);
  const cost = out.reduce((s, d) => s + (d.costUsd ?? 0), 0);
  const bands = out.reduce<Record<string, number>>((m, d) => ({ ...m, [d.band]: (m[d.band] ?? 0) + 1 }), {});
  console.info(
    `[triage] batch n=${out.length} tokens=${tokens} cost_usd=${cost.toFixed(6)} bands=${JSON.stringify(bands)}`,
  );
  return out;
}
