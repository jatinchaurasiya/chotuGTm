/**
 * Draft lane: voice profiles — per-workspace default + per-Medium-account override.
 * Two starter voices ship in; workspaces add their own via the dashboard/API lane.
 */

export interface VoiceProfile {
  id: string;
  label: string;
  tone: string;
  examples: string[];
  bannedPhrases: string[];
}

export interface WorkspaceVoiceConfig {
  workspaceId: string;
  defaultVoiceId: string;
  /** Medium account handle → voice id (cross-account fingerprint separation). */
  mediumAccounts: Record<string, string>;
}

export const STARTER_VOICES: VoiceProfile[] = [
  {
    id: "pragmatic-builder",
    label: "Pragmatic Builder",
    tone: "Direct, engineering-minded, allergic to hype. Short sentences. Shows working, not promises.",
    examples: [
      "We cut onboarding from 20 min to 3 by deleting two screens, not by adding a tour.",
      "Tried three invoicing tools. Kept the boring one — it exports clean CSVs.",
    ],
    bannedPhrases: ["game-changer", "unlock", "delve", "elevate", "supercharge"],
  },
  {
    id: "friendly-operator",
    label: "Friendly Operator",
    tone: "Warm, practical, peer-to-peer. Explains trade-offs, admits what didn't work.",
    examples: [
      "Honest take: the first week with any scheduler is messy. Here's what smoothed ours out.",
      "We got this wrong twice before it clicked — happy to share the messy middle.",
    ],
    bannedPhrases: ["revolutionize", "unlock", "delve", "tapestry", "furthermore"],
  },
];

export const VOICE_BY_ID: Record<string, VoiceProfile> = Object.fromEntries(
  STARTER_VOICES.map((v) => [v.id, v]),
);

export function getVoice(voiceId?: string): VoiceProfile {
  if (voiceId && VOICE_BY_ID[voiceId]) return VOICE_BY_ID[voiceId];
  return STARTER_VOICES[0];
}

/** Resolve the voice for a workspace, with per-Medium-account override. */
export function voiceForWorkspace(cfg: WorkspaceVoiceConfig, mediumAccount?: string): VoiceProfile {
  if (mediumAccount && cfg.mediumAccounts[mediumAccount]) {
    return getVoice(cfg.mediumAccounts[mediumAccount]);
  }
  return getVoice(cfg.defaultVoiceId);
}

/** Render a voice as a prompt block (also used by the deslop rewrite pass). */
export function formatVoiceBlock(voice: VoiceProfile): string {
  const lines = [
    `Voice: ${voice.label} — ${voice.tone}`,
    ...voice.examples.map((e) => `Example: "${e}"`),
  ];
  if (voice.bannedPhrases.length) {
    lines.push(`Banned phrases for this voice: ${voice.bannedPhrases.map((b) => `"${b}"`).join(", ")}`);
  }
  return lines.join("\n");
}
