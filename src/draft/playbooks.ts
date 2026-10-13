/**
 * Draft lane: per-platform playbooks + angle/hook vocabularies.
 * Single source of truth for structure/length/tone/CTA rules.
 * Triage (decide.ts) imports ANGLES/HOOKS as choice criteria so the
 * classifier and the generators never drift apart.
 */

import type { DraftPlatform } from "./prompts.js";

export interface Playbook {
  platform: DraftPlatform;
  structure: string[];
  targetLength: string;
  tone: string;
  ctaPolicy: string;
  hardDonts: string[];
  hookHandling: string;
}

export const ANGLES: string[] = [
  "problem",
  "story",
  "howto",
  "contrarian",
  "build-log",
  "comparison",
  "lesson",
];

export const HOOKS: string[] = [
  "story-open",
  "question",
  "stat",
  "contrarian-take",
  "howto-promise",
];

export const PLAYBOOKS: Record<DraftPlatform, Playbook> = {
  reddit: {
    platform: "reddit",
    structure: [
      "answer the OP's actual question first",
      "concrete personal experience or exact steps",
      "caveats / what didn't work",
      "optional resource mention only if it answers",
    ],
    targetLength: "150-300 words, short paragraphs",
    tone: "peer-to-peer, plainspoken; mirror the thread's language, not marketing copy",
    ctaPolicy:
      "Mention the product/link at most once and only if it directly answers the OP. Never as a sign-off pitch.",
    hardDonts: [
      "no pitch tone",
      "no hype adjectives",
      "no filler openers ('Great question!')",
      "no hashtags",
      "no em-dash flourishes",
    ],
    hookHandling:
      "No clickbait hook — open with the answer itself, not a tease. The first sentence must help the OP.",
  },
  twitter: {
    platform: "twitter",
    structure: [
      "one sharp claim up front",
      "concrete number or specific proof",
      "optional punchline or next step",
    ],
    targetLength: "Single post ≤240 characters, or a max 3-post thread separated by '---'",
    tone: "punchy, concrete, zero fluff; one idea only",
    ctaPolicy:
      "Link only if load-bearing to the claim. No CTA on every post; never end with engagement bait.",
    hardDonts: [
      "no hashtags unless load-bearing",
      "no thread longer than 3 posts",
      "no vague motivational filler",
      "no triplet lists",
    ],
    hookHandling:
      "The first line IS the hook and must stand alone in the feed. Lead with the number or the contrarian claim.",
  },
  linkedin: {
    platform: "linkedin",
    structure: [
      "insight or observation",
      "concrete example with specifics",
      "single grounded takeaway",
    ],
    targetLength: "120-220 words, one post",
    tone: "professional register, measured, insight-first; no broetry",
    ctaPolicy:
      "Link only if genuinely helpful to a professional reader. No lead-magnet or engagement-bait CTA.",
    hardDonts: [
      "no broetry one-line-per-paragraph stacks",
      "no engagement bait ('Agree? Comment below')",
      "no hype adjectives",
      "no hedged openers",
    ],
    hookHandling:
      "Open with the insight, not a personal-story cliffhanger. No 'I was fired 3 years ago...' fake suspense.",
  },
  medium: {
    platform: "medium",
    structure: [
      "problem — who hurts and why now",
      "approach — the method or mental model",
      "specifics — exact steps, numbers, examples",
      "takeaway — what the reader can use this week",
    ],
    targetLength: "800-1500 words in markdown with subheads",
    tone: "teacherly, concrete examples over abstractions; strong hook up top",
    ctaPolicy:
      "Resource link where it helps the reader act this week. Teach first; no hard pitch, no gated-content tease.",
    hardDonts: [
      "no listicle filler",
      "no hedged openers",
      "no triplet lists",
      "no em-dash flourishes",
    ],
    hookHandling:
      "Strong hook in the first 2-3 sentences promising a usable outcome. Deliver on it in the specifics section.",
  },
  "reddit-post": {
    platform: "reddit-post",
    structure: [
      "value-first standalone insight (no thread context assumed)",
      "concrete steps, numbers, or worked example",
      "discussion prompt that invites subreddit expertise",
    ],
    targetLength: "200-400 words standalone post: title + body",
    tone: "helpful poster, subreddit-native language; target-subreddit aware, no self-promo tone",
    ctaPolicy:
      "No product link unless the subreddit rules allow it and it directly answers. Max 2 standalone posts per day per account.",
    hardDonts: [
      "no sales pitch",
      "no cross-post spam",
      "no karma-bait title",
      "no more than 2 standalone posts per day per account",
      "no hashtags",
    ],
    hookHandling:
      "The title IS the hook and must work with zero context. Body opens by restating the payoff, then teaches.",
  },
};
