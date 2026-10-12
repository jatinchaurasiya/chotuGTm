/**
 * scorecard.ts — channel × angle × hook matrix (the PMF signal).
 *
 * Aggregates attribution_scores joined with post metadata into a directional
 * table. Directional, not accounting: small-n cells are flagged, never hidden.
 */
import type { AttributionScore } from '../track/attribution.js';

export interface MatrixInput extends AttributionScore {
  channel: string; // platform/channel, e.g. 'reddit' | 'linkedin' | 'medium'
  angle: string; // positioning angle tag from draft/opportunity
  hook: string; // hook archetype tag, e.g. 'story' | 'howto' | 'contrarian'
}

export interface MatrixCell {
  channel: string;
  angle: string;
  hook: string;
  n: number;
  avg_traffic_lift: number;
  avg_signup_lift: number;
  exact_share: number; // 0..1 fraction of rows with method='exact'
  thin: boolean; // true when n < minN (directional warning)
}

export function buildChannelMatrix(rows: MatrixInput[], minN = 3): MatrixCell[] {
  const groups = new Map<string, MatrixInput[]>();
  for (const r of rows) {
    const k = [r.channel ?? '?', r.angle ?? '—', r.hook ?? '—'].join('‖');
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const cells: MatrixCell[] = [];
  for (const g of groups.values()) {
    const n = g.length;
    const avgT = g.reduce((s, r) => s + (Number(r.traffic_lift) || 0), 0) / n;
    const avgS = g.reduce((s, r) => s + (Number(r.signup_lift) || 0), 0) / n;
    const exact = g.filter((r) => r.method === 'exact').length / n;
    cells.push({
      channel: g[0].channel,
      angle: g[0].angle,
      hook: g[0].hook,
      n,
      avg_traffic_lift: Number(avgT.toFixed(4)),
      avg_signup_lift: Number(avgS.toFixed(4)),
      exact_share: Number(exact.toFixed(3)),
      thin: n < minN,
    });
  }
  // Highest traffic lift first; thin cells sink below equal solid ones on ties.
  cells.sort((a, b) => b.avg_traffic_lift - a.avg_traffic_lift || Number(a.thin) - Number(b.thin));
  return cells;
}

/** Render helper for the dependency-free dashboard (plain table rows). */
export function matrixToRows(cells: MatrixCell[]): Array<Record<string, string | number | boolean>> {
  return cells.map((c) => ({
    channel: c.channel,
    angle: c.angle,
    hook: c.hook,
    n: c.n,
    avg_lift: c.avg_traffic_lift,
    avg_signup_lift: c.avg_signup_lift,
    method_mix: `${Math.round(c.exact_share * 100)}% exact`,
    thin: c.thin,
  }));
}
