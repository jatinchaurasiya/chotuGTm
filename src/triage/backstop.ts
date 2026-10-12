/**
 * Triage lane (backstop): OpenRouter Inkling few-shot classifier.
 *
 * Used ONLY when Inception errors/surges. Same output shape and same
 * thresholds as the primary (score 0..1, bands draft/maybe/discard).
 */
import { retry } from "../queue/retry.js";
import { bandFor, combineScores, readThresholds, type TriageBand, type TriageDecision } from "./decide.js";

export type { TriageBand };
export interface BackstopDecision extends Omit<TriageDecision, "backstop"> {
  backstop: true;
}

export interface BackstopInput {
  title: string;
  snippet?: string;
  url?: string;
}

export interface BackstopOptions {
  apiKey?: string;
  model?: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  high?: number;
  low?: number;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const FEWSHOTS = [
  {
    title: "Looking for an invoicing tool that handles GST — tired of spreadsheets",
    snippet: "Freelancer asking for recommendations, wants to switch this month.",
    relevance: 0.9,
    intent: 0.85,
  },
  {
    title: "What CRM do agencies actually use in 2026?",
    snippet: "Broad research thread, no buying signal, just collecting names.",
    relevance: 0.7,
    intent: 0.35,
  },
  {
    title: "My cat knocked over my mechanical keyboard",
    snippet: "Unrelated personal anecdote, no commercial intent.",
    relevance: 0.05,
    intent: 0.02,
  },
];

function buildMessages(input: BackstopInput): Array<{ role: string; content: string }> {
  const examples = FEWSHOTS.map(
    (f) =>
      `Title: ${f.title}\nSnippet: ${f.snippet}\n=> {"relevance": ${f.relevance}, "intent": ${f.intent}}`,
  ).join("\n\n");
  return [
    {
      role: "system",
      content:
        "You are a relevance+intent classifier for a distribution engine. " +
        "Score relevance (fit to the workspace offering) and intent (author will act if engaged well) " +
        "as calibrated probabilities 0..1. Reply with ONLY a JSON object: {\"relevance\": <0..1>, \"intent\": <0..1>}.\n\n" +
        `Examples:\n${examples}`,
    },
    {
      role: "user",
      content:
        `Title: ${input.title}\nSnippet: ${input.snippet ?? ""}\nURL: ${input.url ?? ""}\n=> `,
    },
  ];
}

function parseScores(text: string): { relevance: number; intent: number } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Backstop returned non-JSON.");
  const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  const num = (v: unknown): number => {
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) throw new Error("Backstop returned non-numeric scores.");
    return Math.min(1, Math.max(0, n));
  };
  return { relevance: num(obj.relevance), intent: num(obj.intent) };
}

export async function classifyBackstop(input: BackstopInput, opts: BackstopOptions = {}): Promise<BackstopDecision> {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is missing (backstop).");
  const model = opts.model ?? process.env.OPENROUTER_BACKSTOP_MODEL ?? "thinkingmachines/inkling:free";
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const t = readThresholds();
  const high = opts.high ?? t.high;
  const low = opts.low ?? t.low;

  const res = await retry(
    async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetchFn("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages: buildMessages(input), temperature: 0 }),
          signal: ctrl.signal,
        });
        if (!r.ok) {
          const err = new Error(`Backstop classifier failed (status=${r.status}).`);
          (err as { status?: number }).status = r.status;
          throw err;
        }
        return r;
      } finally {
        clearTimeout(timer);
      }
    },
    {
      maxAttempts: 3,
      baseMs: 1000,
      retryOn: (err) => {
        const s = (err as { status?: number }).status ?? 0;
        return s === 429 || (s >= 500 && s <= 599);
      },
    },
  );

  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
  const { relevance, intent } = parseScores(text);
  const score = combineScores(relevance, intent);
  console.info(`[triage] backstop model=${model} score=${score}`);
  return { score, band: bandFor(score, high, low), relevance, intent, model, backstop: true };
}
