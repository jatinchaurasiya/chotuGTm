/**
 * In-memory lane-error ring buffer (worker-jobs lane).
 *
 * Why this exists: some failure paths cannot reach the `failed_jobs`
 * dead-letter table — scheduled fan-out jobs carry no workspace_id (the
 * column is NOT NULL + FK), and degraded-lane returns are intentional
 * non-throws. Previously those ended as console.warn lines, i.e. silent on
 * the dashboard. Every such path now ALSO records here, and
 * GET /api/doctor exposes `recent_errors`, so nothing fails invisibly.
 *
 * Bounded (50 entries), process-local, no secrets (callers pass prefixes only).
 */

export interface LaneError {
  t: string;
  where: string;
  detail: string;
}

const MAX_ERRORS = 50;
const buf: LaneError[] = [];

function toText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function recordLaneError(where: string, err: unknown): LaneError {
  const entry: LaneError = {
    t: new Date().toISOString(),
    where,
    detail: toText(err).slice(0, 300),
  };
  buf.push(entry);
  if (buf.length > MAX_ERRORS) buf.splice(0, buf.length - MAX_ERRORS);
  console.warn(`[worker:${where}] ${entry.detail}`);
  return entry;
}

export function recentLaneErrors(): LaneError[] {
  return [...buf].reverse();
}

export function clearLaneErrors(): void {
  buf.length = 0;
}
