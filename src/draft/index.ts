/**
 * Draft lane orchestrator: generate 4 platform variants per opportunity.
 *
 * Hard rules:
 * - Drafts fire ONLY for mercury_score >= threshold (env TRIAGE_THRESHOLD, default 0.75).
 * - Keyed by opportunity_id: pre-check the drafts table per platform, skip existing.
 * - UTM-tagged CTA is passed into prompts (tags materialize at copy/publish time).
 */
import { generateCompletion } from "./client.js";
import { PROMPT_BUILDERS, type DraftPlatform } from "./prompts.js";
import { formatVoiceBlock, getVoice } from "./voices.js";
import { appendUtm } from "./utm.js";

export type { DraftPlatform };

export interface DraftOpportunity {
  id: string;
  workspaceId: string;
  title: string;
  summary?: string;
  url?: string;
  mercuryScore: number;
}

export interface DraftRecord {
  opportunityId: string;
  platform: DraftPlatform;
  body: string;
  model: string;
  voiceId: string;
}

export interface DraftDeps {
  /** True when a draft already exists for (opportunity, platform). */
  hasDraft: (opportunityId: string, platform: DraftPlatform) => Promise<boolean>;
  saveDraft: (draft: DraftRecord) => Promise<void>;
  generate?: typeof generateCompletion;
  voiceId?: string;
  /** Base product URL; per-platform UTM variants are derived from it. */
  ctaUrl?: string;
  platforms?: DraftPlatform[];
  workspaceSlug?: string;
}

export interface DraftRunResult {
  skipped: boolean;
  skipReason?: string;
  generated: Array<{ platform: DraftPlatform; model: string }>;
  existing: DraftPlatform[];
}

export const DEFAULT_PLATFORMS: DraftPlatform[] = ["reddit", "twitter", "linkedin", "medium"];

export function readDraftThreshold(): number {
  const n = Number(process.env.TRIAGE_THRESHOLD ?? 0.75);
  return Number.isFinite(n) ? n : 0.75;
}

export async function draftForOpportunity(
  opp: DraftOpportunity,
  deps: DraftDeps,
): Promise<DraftRunResult> {
  const threshold = readDraftThreshold();
  if (opp.mercuryScore < threshold) {
    return { skipped: true, skipReason: `below-threshold:${opp.mercuryScore}<${threshold}`, generated: [], existing: [] };
  }

  const generate = deps.generate ?? generateCompletion;
  const platforms = deps.platforms ?? DEFAULT_PLATFORMS;
  const voice = getVoice(deps.voiceId);
  const voiceBlock = formatVoiceBlock(voice);
  const workspace = deps.workspaceSlug ?? opp.workspaceId;

  const result: DraftRunResult = { skipped: false, generated: [], existing: [] };
  for (const platform of platforms) {
    if (await deps.hasDraft(opp.id, platform)) {
      result.existing.push(platform);
      continue;
    }
    const build = PROMPT_BUILDERS[platform];
    const ctaUrl = deps.ctaUrl ? appendUtm(deps.ctaUrl, { platform, workspace }) : undefined;
    const { system, user } = build({
      title: opp.title,
      summary: opp.summary,
      context: opp.url ? `Source: ${opp.url}` : undefined,
      ctaUrl,
      voiceBlock,
      bannedPhrases: voice.bannedPhrases,
    });
    const { text, model } = await generate(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { maxTokens: platform === "medium" ? 8000 : 2000 },
    );
    await deps.saveDraft({ opportunityId: opp.id, platform, body: text, model, voiceId: voice.id });
    console.info(`[draft] opp=${opp.id} platform=${platform} model=${model}`);
    result.generated.push({ platform, model });
  }
  return result;
}
