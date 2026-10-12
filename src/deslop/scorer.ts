/**
 * Deslop lane: heuristic slop scorer (0..1, higher = more AI-tells).
 *
 * Signals: em-dash runs, banned openers, triplet lists, banned phrases,
 * hedged openers, emoji runs. Pure function — no network, no deps.
 */

export interface SlopSignals {
  emDashRuns: number;
  bannedOpener: boolean;
  tripletLists: number;
  bannedPhraseHits: number;
  hedgedOpener: boolean;
  emojiRuns: number;
}

export interface SlopScore {
  /** 0 (clean) .. 1 (full slop). */
  score: number;
  reasons: string[];
  signals: SlopSignals;
}

export const BANNED_PHRASES = [
  "delve",
  "delves",
  "delving",
  "elevated discourse",
  "game-changer",
  "game changer",
  "tapestry",
  "furthermore",
  "moreover",
  "in conclusion",
  "as a large language model",
  "ever-evolving",
  "it's important to note",
  "it is important to note",
  "embark on",
  "unlock the",
  "unlocking the",
  "in today's digital",
  "fast-paced world",
];

const BANNED_OPENERS = [
  /^in today's\b/i,
  /^in the ever-evolving\b/i,
  /^delve\b/i,
  /^unlock\b/i,
  /^elevat\w*\b/i,
  /^in conclusion\b/i,
  /^as an ai\b/i,
  /^as a large language model\b/i,
  /^in the world of\b/i,
  /^picture this\b/i,
  /^imagine a world\b/i,
  /^great question[!.]?\s/i,
];

const HEDGED_OPENERS = [/^as someone who\b/i, /^i (hope|think) this helps\b/i, /^to be fair[,.]?\s/i];

/** Three parallel chunks ending ", X, and Y" — classic model triplet. */
const TRIPLET_RE = /[^,;:.!?]{3,60},[^,;:.!?]{3,60},\s+and\s+[^,;:.!?]{3,60}/gi;
const EMDASH_RE = /(—|–|--)/g;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scoreSlop(text: string): SlopScore {
  const reasons: string[] = [];
  const signals: SlopSignals = {
    emDashRuns: 0,
    bannedOpener: false,
    tripletLists: 0,
    bannedPhraseHits: 0,
    hedgedOpener: false,
    emojiRuns: 0,
  };
  let score = 0;

  const trimmed = text.trim();
  if (!trimmed) return { score: 0, reasons: ["empty"], signals };
  const words = trimmed.split(/\s+/).length;

  // 1. Em-dash runs (density per 100 words).
  const dashes = (trimmed.match(EMDASH_RE) ?? []).length;
  signals.emDashRuns = dashes;
  if (dashes > 0) {
    const density = dashes / Math.max(1, words / 100);
    const w = Math.min(0.3, density * 0.1);
    score += w;
    if (w >= 0.05) reasons.push(`em-dash runs: ${dashes} in ~${words} words`);
  }

  // 2. Banned openers.
  const head = trimmed.replace(/^["'“‘\s#*]*/, "");
  if (BANNED_OPENERS.some((re) => re.test(head))) {
    signals.bannedOpener = true;
    score += 0.35;
    reasons.push(`banned opener: "${head.slice(0, 48)}..."`);
  } else if (HEDGED_OPENERS.some((re) => re.test(head))) {
    signals.hedgedOpener = true;
    score += 0.1;
    reasons.push("hedged opener");
  }

  // 3. Triplet lists.
  const triplets = trimmed.match(TRIPLET_RE) ?? [];
  signals.tripletLists = triplets.length;
  if (triplets.length > 0) {
    score += Math.min(0.3, triplets.length * 0.15);
    reasons.push(`triplet lists: ${triplets.length}`);
  }

  // 4. Banned phrases.
  let hits = 0;
  const hitPhrases: string[] = [];
  for (const phrase of BANNED_PHRASES) {
    // Word-boundary match: substring includes() double-counts ("delves"
    // hits both "delve" and "delves") and false-positives inside words.
    if (new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "i").test(trimmed)) {
      hits += 1;
      hitPhrases.push(phrase);
    }
  }
  signals.bannedPhraseHits = hits;
  if (hits > 0) {
    score += Math.min(0.36, hits * 0.12);
    reasons.push(`banned phrases: ${hitPhrases.slice(0, 5).join(", ")}${hits > 5 ? ` (+${hits - 5} more)` : ""}`);
  }

  // 5. Emoji runs.
  const emojis = trimmed.match(EMOJI_RE) ?? [];
  if (emojis.length >= 5) {
    signals.emojiRuns = emojis.length;
    score += 0.15;
    reasons.push(`emoji-heavy: ${emojis.length}`);
  }

  return { score: round2(Math.min(1, score)), reasons, signals };
}
