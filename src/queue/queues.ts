/**
 * Queue definitions (worker-jobs lane).
 *
 * BullMQ + IORedis. Connection comes from REDIS_URL (docker compose sets
 * `redis://redis:6379`; local default is `redis://localhost:6379`).
 *
 * BullMQ requires `maxRetriesPerRequest: null` on the shared connection.
 * Nothing connects until getConnection()/getQueue() is first called, so
 * importing this module never opens a socket (API route tests stay offline).
 */
import { Redis } from "ioredis";
import { Queue, type JobsOptions } from "bullmq";

/** Canonical queue keys. failed_jobs.job_type values map onto these (see queueForJobType). */
export const QUEUE_NAMES = {
  discover: "chotu-discover",
  triage: "chotu-triage",
  draft: "chotu-draft",
  trackSite: "chotu-track-site",
  trackPost: "chotu-track-post",
  learn: "chotu-learn",
} as const;

export type QueueKey = keyof typeof QUEUE_NAMES;

/** Job names used inside each queue. */
export const JOB_NAMES = {
  discover: "discover-workspace",
  triage: "triage-batch",
  draft: "draft-opportunity",
  trackSite: "track-site-workspace",
  trackPost: "track-post-batch",
  learn: "learn-workspace",
} as const;

export function redisUrl(): string {
  const raw = process.env.REDIS_URL ?? "";
  return raw.trim() !== "" ? raw : "redis://localhost:6379";
}

let connection: Redis | null = null;

/** Shared lazy connection (BullMQ-compatible options). */
export function getConnection(): Redis {
  if (!connection) {
    connection = new Redis(redisUrl(), {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    connection.on("error", (err: Error) => {
      console.warn(`[queue] redis error: ${String((err as Error)?.message ?? err)}`);
    });
  }
  return connection;
}

const queues = new Map<string, Queue>();

/** Lazy per-queue handle. Safe to call at import time (no I/O until used). */
export function getQueue(key: QueueKey): Queue {
  const existing = queues.get(key);
  if (existing) return existing;
  const q = new Queue(QUEUE_NAMES[key], { connection: getConnection() });
  queues.set(key, q);
  return q;
}

/** Map a failed_jobs.job_type (or dashboard `type`) onto a queue key. Null = unknown. */
export function queueKeyForJobType(jobType: string): QueueKey | null {
  const t = jobType.trim().toLowerCase().replace(/_/g, "-");
  if (t === "discover") return "discover";
  if (t === "triage") return "triage";
  if (t === "draft") return "draft";
  if (t === "track-site" || t === "tracksite") return "trackSite";
  if (t === "track-post" || t === "trackpost") return "trackPost";
  if (t === "learn") return "learn";
  return null;
}

/** Default per-attempt policy: 3 tries, exponential backoff (shared retry.ts caps at 5). */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: 100,
  removeOnFail: 500,
};

/**
 * OpenRouter token bucket guard: 20 req/min max across the worker process.
 * Call before every LLM generation call; sleeps just enough to stay in budget.
 */
export const LLM_MIN_INTERVAL_MS = 3000;
let lastLlmAt = 0;

export async function throttleLlm(): Promise<void> {
  const now = Date.now();
  const wait = LLM_MIN_INTERVAL_MS - (now - lastLlmAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastLlmAt = Date.now();
}

/** Best-effort liveness ping (short timeout so /health + /api/doctor never hang). */
export async function pingRedis(timeoutMs = 2000): Promise<boolean> {
  try {
    const pong = await Promise.race([
      getConnection().ping(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("redis ping timeout")), timeoutMs)),
    ]);
    return pong === "PONG";
  } catch {
    return false;
  }
}

/** Close all queues + the shared connection (tests / graceful shutdown). */
export async function closeQueues(): Promise<void> {
  for (const q of queues.values()) {
    try {
      await q.close();
    } catch {
      /* ignore */
    }
  }
  queues.clear();
  if (connection) {
    try {
      connection.disconnect();
    } catch {
      /* ignore */
    }
    connection = null;
  }
}
