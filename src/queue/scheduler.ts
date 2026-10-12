/**
 * Repeatable schedules (worker-jobs lane).
 *
 *   discover   2x/day   (08:00 + 20:00 UTC)
 *   track-site hourly    (top of the hour)
 *   track-post daily     (02:00 UTC)
 *   learn      weekly    (Sunday 03:00 UTC)
 *
 * triage + draft are event-driven (enqueued by the discover/triage
 * processors), never cron — they must stay keyed to fresh batches.
 *
 * Registration is idempotent: every entry uses a stable jobId so
 * re-running registerSchedules() upserts instead of duplicating.
 * Fan-out jobs carry no workspace_id; processors list workspaces from
 * the DB and dead-letter per workspace on failure.
 */
import { getQueue, DEFAULT_JOB_OPTIONS, type QueueKey } from "./queues.js";

export interface ScheduleDef {
  queue: QueueKey;
  /** Name inside the queue (BullMQ repeat key derives from name + jobId). */
  name: string;
  /** Stable id so re-registration upserts. */
  jobId: string;
  /** Cron pattern (UTC). */
  pattern: string;
  describe: string;
}

export const SCHEDULES: ScheduleDef[] = [
  {
    queue: "discover",
    name: "discover-all",
    jobId: "repeat-discover",
    pattern: "0 8,20 * * *",
    describe: "discover 2x/day",
  },
  {
    queue: "trackSite",
    name: "track-site-all",
    jobId: "repeat-track-site",
    pattern: "0 * * * *",
    describe: "track-site hourly",
  },
  {
    queue: "trackPost",
    name: "track-post-all",
    jobId: "repeat-track-post",
    pattern: "0 2 * * *",
    describe: "track-post daily",
  },
  {
    queue: "learn",
    name: "learn-all",
    jobId: "repeat-learn",
    pattern: "0 3 * * 0",
    describe: "learn weekly",
  },
];

export interface ScheduleResult {
  queue: QueueKey;
  name: string;
  jobId: string;
  pattern: string;
  scheduledId: string | undefined;
}

/** Register (upsert) every repeatable. Safe to call on every boot. */
export async function registerSchedules(): Promise<ScheduleResult[]> {
  const out: ScheduleResult[] = [];
  for (const s of SCHEDULES) {
    const q = getQueue(s.queue);
    const job = await q.add(
      s.name,
      { scheduled: true, enqueued_at: new Date().toISOString() },
      { ...DEFAULT_JOB_OPTIONS, repeat: { pattern: s.pattern }, jobId: s.jobId },
    );
    console.info(`[scheduler] ${s.describe} -> queue=${s.queue} pattern=${s.pattern} id=${job.id ?? "repeat"}`);
    out.push({ queue: s.queue, name: s.name, jobId: s.jobId, pattern: s.pattern, scheduledId: job.id });
  }
  return out;
}

/** Read-only view for /api/doctor + tests (no I/O). */
export function getSchedules(): ScheduleDef[] {
  return [...SCHEDULES];
}
