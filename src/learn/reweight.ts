/**
 * reweight.ts — weekly channel_config prior update for Discover/Draft.
 *
 * workspaces.channel_config shape (jsonb), e.g.:
 *   { "reddit": {"weight": 1.0, "trials": 5}, "linkedin": {"weight": 1.2, "trials": 3} }
 *
 * Update = smoothed pull toward observed mean lift per channel:
 *   w' = clamp((w * priorN + meanLift01 * n) / (priorN + n), MIN, MAX)
 * where meanLift01 maps avg lift (-1..+3 → 0..1-ish) so good channels grow.
 * Unknown channels in the matrix are added with a conservative seed.
 * Channels with zero new evidence decay slightly toward 1.0 (no wild swings).
 */
import type { MatrixCell } from './scorecard.js';

export interface ChannelPrior {
  weight: number;
  trials: number;
}
export type ChannelConfig = Record<string, ChannelPrior>;

const MIN_W = 0.05;
const MAX_W = 3.0;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Map avg traffic lift (-1..+3) to a 0..~1.5 multiplier target. +20% lift ≈ 1.2. */
export function liftToTarget(avgLift: number): number {
  return clamp(1 + avgLift, 0, 4);
}

export interface ReweightOpts {
  priorN?: number; // stickiness of old weight. Default 5.
  decay?: number; // pull toward 1.0 for channels with no new data. Default 0.02.
}

export function reweightChannelConfig(
  current: ChannelConfig,
  cells: MatrixCell[],
  opts: ReweightOpts = {},
): ChannelConfig {
  const priorN = opts.priorN ?? 5;
  const decay = opts.decay ?? 0.02;
  const next: ChannelConfig = {};

  // Aggregate cells per channel (weighted by n).
  const byChannel = new Map<string, { sum: number; n: number }>();
  for (const c of cells) {
    // Down-weight thin + fully-inferred cells: directional, not accounting.
    const quality = (c.thin ? 0.5 : 1) * (0.5 + 0.5 * c.exact_share);
    const e = byChannel.get(c.channel) ?? { sum: 0, n: 0 };
    e.sum += c.avg_traffic_lift * c.n * quality;
    e.n += c.n * quality;
    byChannel.set(c.channel, e);
  }

  const seen = new Set<string>();
  for (const [channel, prior] of Object.entries(current)) {
    seen.add(channel);
    const ev = byChannel.get(channel);
    if (!ev || ev.n <= 0) {
      const w = prior.weight + (1.0 - prior.weight) * decay;
      next[channel] = { weight: Number(clamp(w, MIN_W, MAX_W).toFixed(3)), trials: prior.trials };
      continue;
    }
    const meanLift = ev.sum / ev.n;
    const target = liftToTarget(meanLift);
    const w = (prior.weight * priorN + target * ev.n) / (priorN + ev.n);
    next[channel] = {
      weight: Number(clamp(w, MIN_W, MAX_W).toFixed(3)),
      trials: prior.trials + Math.round(ev.n),
    };
  }
  // New channels observed in the wild: conservative seed.
  for (const [channel, ev] of byChannel) {
    if (seen.has(channel) || ev.n <= 0) continue;
    const target = liftToTarget(ev.sum / ev.n);
    next[channel] = {
      weight: Number(clamp(0.5 * 1.0 + 0.5 * target, MIN_W, MAX_W).toFixed(3)),
      trials: Math.round(ev.n),
    };
  }
  return next;
}
