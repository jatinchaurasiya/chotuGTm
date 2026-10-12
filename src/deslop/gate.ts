/**
 * Deslop lane gate: every draft is scored; below-gate drafts get ONE rewrite
 * pass + re-score; still-below-gate drafts are HELD (never shown in queue)
 * and logged with reasons. Per-account banned phrases are enforced here.
 */
import { scoreSlop, type SlopScore } from "./scorer.js";
import { rewriteOnce } from "./rewrite.js";

export type GateStatus = "pass" | "held";

export interface GatedVariant {
  platform: string;
  status: GateStatus;
  scoreBefore: number;
  scoreAfter: number;
  rewritten: boolean;
  reasons: string[];
  text: string;
}

export interface GateOptions {
  /** Max tolerated slop score (0..1). Default from DESLOP_GATE, 0.5. */
  gate?: number;
  bannedPhrases?: string[];
  /** Override the rewrite pass (tests/stubs). Defaults to one Inkling pass. */
  rewrite?: (text: string) => Promise<string>;
}

export function readDeslopGate(): number {
  const n = Number(process.env.DESLOP_GATE ?? 0.5);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

function bannedHits(text: string, banned: string[]): string[] {
  const lower = text.toLowerCase();
  return banned.filter((b) => b && lower.includes(b.toLowerCase()));
}

export async function gateOne(platform: string, text: string, opts: GateOptions = {}): Promise<GatedVariant> {
  const gate = opts.gate ?? readDeslopGate();
  const banned = opts.bannedPhrases ?? [];
  const rewrite = opts.rewrite ?? (async (t: string) => (await rewriteOnce(t, { bannedPhrases: banned })).text);

  const before: SlopScore = scoreSlop(text);
  const beforeBanned = bannedHits(text, banned);
  const reasons = [...before.reasons];
  if (beforeBanned.length) reasons.push(`account-banned phrases: ${beforeBanned.join(", ")}`);

  if (before.score <= gate && beforeBanned.length === 0) {
    return { platform, status: "pass", scoreBefore: before.score, scoreAfter: before.score, rewritten: false, reasons, text };
  }

  // One rewrite pass, then re-score.
  let rewrittenText = text;
  try {
    rewrittenText = await rewrite(text);
  } catch (err) {
    const held: GatedVariant = {
      platform,
      status: "held",
      scoreBefore: before.score,
      scoreAfter: before.score,
      rewritten: false,
      reasons: [...reasons, `rewrite-failed: ${String((err as Error)?.message ?? err)}`],
      text,
    };
    console.info(`[deslop] platform=${platform} HELD score=${before.score} reasons=${held.reasons.join("; ")}`);
    return held;
  }

  const after: SlopScore = scoreSlop(rewrittenText);
  const afterBanned = bannedHits(rewrittenText, banned);
  const finalReasons = [...after.reasons];
  if (afterBanned.length) finalReasons.push(`account-banned phrases persist: ${afterBanned.join(", ")}`);

  const ok = after.score <= gate && afterBanned.length === 0;
  const gated: GatedVariant = {
    platform,
    status: ok ? "pass" : "held",
    scoreBefore: before.score,
    scoreAfter: after.score,
    rewritten: true,
    reasons: ok ? finalReasons : [...finalReasons, `still-below-gate: ${after.score}>${gate}`],
    text: rewrittenText,
  };
  console.info(
    `[deslop] platform=${platform} ${gated.status.toUpperCase()} before=${before.score} after=${after.score} gate=${gate}`,
  );
  return gated;
}

export async function gateDrafts(
  inputs: Array<{ platform: string; text: string }>,
  opts: GateOptions = {},
): Promise<GatedVariant[]> {
  const out: GatedVariant[] = [];
  for (const v of inputs) out.push(await gateOne(v.platform, v.text, opts));
  const held = out.filter((g) => g.status === "held").length;
  console.info(`[deslop] gated n=${out.length} held=${held}`);
  return out;
}
