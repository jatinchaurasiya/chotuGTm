/**
 * Draft lane: platform prompt builders (4 variants per opportunity).
 * Reddit = value-first reply, no pitch tone. Voice block appended by caller.
 */

export type DraftPlatform = "reddit" | "twitter" | "linkedin" | "medium";

export interface PromptInput {
  title: string;
  summary?: string;
  context?: string;
  /** CTA link (already UTM-tagged by the caller) to weave in where native. */
  ctaUrl?: string;
  voiceBlock?: string;
  bannedPhrases?: string[];
}

export interface BuiltPrompt {
  system: string;
  user: string;
}

function bannedLine(banned?: string[]): string {
  if (!banned?.length) return "";
  return `\nNEVER use these words/phrases: ${banned.map((b) => `"${b}"`).join(", ")}.`;
}

function base(input: PromptInput): string {
  return [
    input.summary ? `Opportunity summary: ${input.summary}` : "",
    input.context ? `Background context: ${input.context}` : "",
    input.ctaUrl ? `Relevant link (use at most once, only if genuinely helpful): ${input.ctaUrl}` : "",
    input.voiceBlock ? `Voice to match:\n${input.voiceBlock}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const NO_SLOP = "Write like a human, not a model. No em-dash flourishes, no triplet lists, no hedged openers.";

export function buildRedditReplyPrompt(input: PromptInput): BuiltPrompt {
  return {
    system:
      "You write Reddit replies that lead with genuine value. Answer the OP's actual question first, " +
      "from real experience. No pitch tone, no hype, no filler openers. Short paragraphs. " +
      NO_SLOP +
      bannedLine(input.bannedPhrases),
    user:
      `Thread title: ${input.title}\n${base(input)}\n\n` +
      "Write ONE reply (150-300 words) that directly helps the OP. " +
      "Only mention the linked resource if it truly answers their question — never as a sign-off pitch.",
  };
}

export function buildTweetPrompt(input: PromptInput): BuiltPrompt {
  return {
    system:
      "You write punchy X/Twitter posts: one sharp idea, concrete numbers or specifics, zero fluff. " +
      "Under 240 characters unless a 3-post thread is clearly warranted. " +
      NO_SLOP +
      bannedLine(input.bannedPhrases),
    user:
      `Topic: ${input.title}\n${base(input)}\n\n` +
      "Write the post (or a max-3-post thread, separated by '---'). No hashtags unless load-bearing.",
  };
}

export function buildLinkedinPrompt(input: PromptInput): BuiltPrompt {
  return {
    system:
      "You write LinkedIn posts in a professional register: insight-first, one concrete takeaway, " +
      "measured tone, no broetry line-breaks, no engagement bait. " +
      NO_SLOP +
      bannedLine(input.bannedPhrases),
    user:
      `Topic: ${input.title}\n${base(input)}\n\n` +
      "Write ONE post (120-220 words) ending with a single grounded takeaway.",
  };
}

export function buildMediumPrompt(input: PromptInput): BuiltPrompt {
  return {
    system:
      "You write long-form Medium articles: strong hook, real structure (problem → approach → specifics → takeaway), " +
      "concrete examples over abstractions. 800-1500 words with markdown subheads. " +
      NO_SLOP +
      bannedLine(input.bannedPhrases),
    user:
      `Topic: ${input.title}\n${base(input)}\n\n` +
      "Write the full article in markdown. Teach something the reader can use this week.",
  };
}

export const PROMPT_BUILDERS: Record<DraftPlatform, (input: PromptInput) => BuiltPrompt> = {
  reddit: buildRedditReplyPrompt,
  twitter: buildTweetPrompt,
  linkedin: buildLinkedinPrompt,
  medium: buildMediumPrompt,
};
