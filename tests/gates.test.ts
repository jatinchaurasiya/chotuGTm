import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/api/server.js";
import { SCHEDULES } from "../src/queue/scheduler.js";
import { queueKeyForJobType, closeQueues } from "../src/queue/queues.js";
import { recordLaneError, recentLaneErrors, clearLaneErrors } from "../src/queue/errors.js";

// Dummy env so requireDb() succeeds and URL validation runs before any DB I/O.
// No live DB needed: invalid payloads return 400 before any query.
if (!process.env.SUPABASE_URL) process.env.SUPABASE_URL = "https://example.supabase.co";
if (!process.env.SUPABASE_SERVICE_ROLE_KEY)
  process.env.SUPABASE_SERVICE_ROLE_KEY = "dummy-service-role-key-for-tests";

let server: Server;
let base = "";

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((e) => (e ? reject(e) : resolve()));
  });
  // Doctor tests open the shared redis handle (pingRedis); disconnect it or
  // the runner hangs on ioredis reconnect retries.
  await closeQueues();
});

describe("gates: health", () => {
  it("GET /health returns {ok:true}", async () => {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
  });
});

describe("gates: publish validation (no DB I/O)", () => {
  it("missing workspace_id → 400", async () => {
    const r = await fetch(`${base}/api/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ live_url: "https://example.com/p" }),
    });
    assert.equal(r.status, 400);
    const body = (await r.json()) as Record<string, unknown>;
    assert.equal(body.ok, false);
  });

  it("garbage live_url → 400", async () => {
    const r = await fetch(`${base}/api/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: "ws-test", live_url: "not-a-url" }),
    });
    assert.equal(r.status, 400);
    const body = (await r.json()) as Record<string, unknown>;
    assert.equal(body.ok, false);
  });

  it("non-http(s) live_url → 400", async () => {
    const r = await fetch(`${base}/api/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: "ws-test", live_url: "ftp://example.com/x" }),
    });
    assert.equal(r.status, 400);
  });

  it("missing live_url → 400", async () => {
    const r = await fetch(`${base}/api/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: "ws-test" }),
    });
    assert.equal(r.status, 400);
  });
});

describe("gates: scheduler", () => {
  it("SCHEDULES contains discover/track-site/track-post/learn crons", () => {
    const byQueue = new Map(SCHEDULES.map((s) => [s.queue, s]));
    assert.equal(SCHEDULES.length, 4);
    assert.equal(byQueue.get("discover")?.pattern, "0 8,20 * * *");
    assert.equal(byQueue.get("trackSite")?.pattern, "0 * * * *");
    assert.equal(byQueue.get("trackPost")?.pattern, "0 2 * * *");
    assert.equal(byQueue.get("learn")?.pattern, "0 3 * * 0");
    const names = SCHEDULES.map((s) => s.name).join(",");
    assert.ok(names.includes("discover") && names.includes("track-site") && names.includes("track-post") && names.includes("learn"));
  });
});

describe("gates: queueKeyForJobType", () => {
  it("maps track-site/track_site aliases (and track-post)", () => {
    assert.equal(queueKeyForJobType("track-site"), "trackSite");
    assert.equal(queueKeyForJobType("track_site"), "trackSite");
    assert.equal(queueKeyForJobType("track-post"), "trackPost");
    assert.equal(queueKeyForJobType("track_post"), "trackPost");
  });

  it("maps core types, null on unknown", () => {
    assert.equal(queueKeyForJobType("discover"), "discover");
    assert.equal(queueKeyForJobType("learn"), "learn");
    assert.equal(queueKeyForJobType("nope-unknown"), null);
  });
});

describe("gates: lane-error ring buffer", () => {
  it("records newest-first and caps at 50", () => {
    clearLaneErrors();
    for (let i = 0; i < 55; i++) recordLaneError("test", `err-${i}`);
    const recent = recentLaneErrors();
    assert.equal(recent.length, 50);
    assert.equal(recent[0].detail, "err-54");
    assert.equal(recent[49].detail, "err-5");
    assert.ok(recent.every((e) => e.where === "test" && typeof e.t === "string"));
    clearLaneErrors();
    assert.equal(recentLaneErrors().length, 0);
  });
});

describe("gates: doctor", () => {
  it("exposes recent_errors array (empty when nothing silent)", async () => {
    clearLaneErrors();
    const r = await fetch(`${base}/api/doctor?workspace_id=ws-test`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as Record<string, unknown>;
    assert.equal(body.api, "ok");
    assert.ok(Array.isArray(body.recent_errors));
    assert.equal((body.recent_errors as unknown[]).length, 0);
  });

  it("surfaces a recorded silent failure", async () => {
    clearLaneErrors();
    recordLaneError("dead-letter:no-workspace", "boom-test");
    const r = await fetch(`${base}/api/doctor`);
    const body = (await r.json()) as Record<string, unknown>;
    const errs = body.recent_errors as Array<{ where: string; detail: string }>;
    assert.equal(errs.length, 1);
    assert.equal(errs[0].where, "dead-letter:no-workspace");
    clearLaneErrors();
  });
});
