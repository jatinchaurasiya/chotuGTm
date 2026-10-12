/**
 * Worker entry (worker-jobs lane).
 *
 *   npm run worker      -> node dist/src/worker.js  (env from shell / compose)
 *   npm run dev:worker  -> tsx src/worker.ts           (loads .env.local, then .env)
 *
 * Registers the repeatable schedules, starts all BullMQ workers, and parks
 * the process. SIGTERM/SIGINT close workers + queues gracefully.
 *
 * Liveness: the API's GET /health + GET /api/doctor report queue/redis
 * state. When WORKER_HEALTH_PORT is set, this process additionally serves
 * a dependency-free GET /health endpoint for container healthchecks.
 */
import dotenv from "dotenv";
// Same env precedence as the API entry: .env.local, then .env. Real env wins.
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { registerSchedules } from "./queue/scheduler.js";
import { startWorkers } from "./queue/workers.js";
import { closeQueues } from "./queue/queues.js";
import type { Worker } from "bullmq";

function serveHealth(port: number): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, worker: "alive", time: new Date().toISOString() }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not-found" }));
  });
  server.listen(port, () => {
    console.info(`[worker] health on :${port}/health`);
  });
}

export async function main(): Promise<Worker[]> {
  try {
    await registerSchedules();
  } catch (e) {
    // Redis down at boot: workers still start and serve; the next boot
    // re-registers (upsert by stable jobId), so nothing is lost.
    console.warn(`[worker] scheduler registration failed (will retry next boot): ${String((e as Error)?.message ?? e)}`);
  }
  const workers = startWorkers();

  const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? "");
  if (Number.isFinite(healthPort) && healthPort > 0) serveHealth(healthPort);

  const shutdown = async (signal: string): Promise<void> => {
    console.info(`[worker] ${signal}, draining...`);
    await Promise.all(workers.map((w) => w.close().catch(() => undefined)));
    await closeQueues();
    console.info("[worker] drained, exit");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Heartbeat so `docker logs` shows liveness without a port.
  const beat = setInterval(() => {
    console.info(`[worker] alive workers=${workers.length} time=${new Date().toISOString()}`);
  }, 60_000);
  beat.unref();

  return workers;
}

const invokedAsMain =
  typeof process.argv[1] === "string" && /(^|[\\/])worker\.(ts|js)$/.test(process.argv[1]);

if (invokedAsMain) {
  main().catch((e) => {
    console.error(`[worker] fatal: ${String((e as Error)?.message ?? e)}`);
    process.exit(1);
  });
}
