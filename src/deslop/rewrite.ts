/**
 * Deslop lane: one Inkling rewrite pass for flagged drafts.
 * Single pass only — the gate re-scores; no rewrite loops here.
 */
import { generateCompletion } from "../draft/client.js";

export interface RewriteOptions {
  bannedPhrases?: string[];
  voiceBlock?: string;
  model?: string;
  fetchFn?: FetchLike;
  maxTokens?: number;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RewriteResult {
  text: string;
  model: string;
}

export function buildRewritePrompt(
  draft: string,
  banned: string[] = [],
): { system: string; user: string } {
  return {
    system:
      "You are a ruthless de-slop editor. Rewrite the draft to sound human: kill em-dash flourishes, " +
      "triplet lists, hedged openers, and filler. Keep every fact and the author's voice. " +
      "Reply with ONLY the rewritten text, same format/length class." +
      (banned.length ? `\nABSOLUTELY FORBIDDEN words/phrases: ${banned.map((b) => `"${b}"`).join(", ")}.` : ""),
    user: `Draft to rewrite:\n\n${draft}`,
  };
}

export async function rewriteOnce(draft: string, opts: RewriteOptions = {}): Promise<RewriteResult> {
  const banned = opts.bannedPhrases ?? [];
  const { system, user } = buildRewritePrompt(draft, banned);
  const voiceSuffix = opts.voiceBlock ? `\n\nVoice to preserve:\n${opts.voiceBlock}` : "";
  const { text, model } = await generateCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: user + voiceSuffix },
    ],
    {
      maxTokens: opts.maxTokens ?? 4000,
      temperature: 0.5,
      ...(opts.model ? { models: [opts.model] } : {}),
      ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    },
  );
  console.info(`[deslop] rewrite model=${model}`);
  return { text, model };
}
