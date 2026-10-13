import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dedupeHash, normalizeUrl } from "../src/discover/dedupe.js";
import { bandFor, combineScores, decideMercury } from "../src/triage/decide.js";
import { scoreSlop } from "../src/deslop/scorer.js";
import { appendUtm, campaignFor } from "../src/draft/utm.js";
import { retry } from "../src/queue/retry.js";
import { attributePost } from "../src/track/attribution.js";

describe("dedupe", () => {
  it("equal across reddit url forms", () => {
    const a = dedupeHash("https://www.reddit.com/r/SaaS/comments/abc123/good-title/?utm_source=x", "Good Title");
    const b = dedupeHash("https://old.reddit.com/r/SaaS/comments/abc123/", "good title ");
    assert.equal(a, b);
  });
  it("differs on different threads", () => {
    assert.notEqual(dedupeHash("https://example.com/a", "A"), dedupeHash("https://example.com/b", "A"));
  });
  it("normalize strips tracking + fragment", () => {
    assert.equal(normalizeUrl("https://example.com/p?utm_source=x#frag"), "https://example.com/p");
  });
});

describe("triage bands", () => {
  it("0.75+ drafts, 0.5-0.75 maybe, below discards", () => {
    assert.equal(bandFor(0.9), "draft");
    assert.equal(bandFor(0.75), "draft");
    assert.equal(bandFor(0.6), "maybe");
    assert.equal(bandFor(0.2), "discard");
  });
  it("combine weights relevance 0.6 / intent 0.4", () => {
    assert.equal(combineScores(1, 0), 0.6);
  });

  it("parses rubric-scale scores above 1.0 (no 0.5 pinning)", async () => {
    const raw = {
      model: "mercury-decide",
      answers: {
        relevant: { type: "noul", noul: 0.9 },
        intent: { type: "noul", noul: 0.05 },
        relevance_score: { type: "score", score: 1.693 },
        intent_score: { type: "score", score: 1.358 },
      },
      usage: { input_tokens: 100, output_tokens: 2 },
    };
    const stub = (async () => new Response(JSON.stringify(raw), { status: 200 })) as typeof fetch;
    const d = await decideMercury({ title: "T" }, { fetchFn: stub, apiKey: "dummy" });
    assert.ok(Math.abs(d.relevance - 0.8465) < 0.001, `relevance=${d.relevance}`);
    assert.ok(Math.abs(d.intent - 0.679) < 0.001, `intent=${d.intent}`);
    assert.equal(d.band, "draft");
  });
});

describe("deslop scorer", () => {
  it("flags known slop, passes clean copy", () => {
    const slop = scoreSlop("Delve into this game-changing paradigm — unlock synergy — elevate discourse. Firstly, moreover, furthermore, in conclusion, this is the best thing ever.");
    const clean = scoreSlop("I shipped a fix Tuesday. It cut signup time from 4 minutes to 40 seconds. Here is the exact query I changed.");
    assert.ok(slop.score > clean.score, `slop=${slop.score} clean=${clean.score}`);
    assert.ok(slop.score > 0.5);
  });
});

describe("utm", () => {
  it("campaign slug_YYYYMMDD + appended with fragment preserved", () => {
    assert.equal(campaignFor("authormity.space", new Date("2026-10-12T00:00:00Z")), "authormity_space_20261012");
    const out = appendUtm("https://shipsprint.site/p#top", { workspace: "shipsprint.site", platform: "reddit", date: new Date("2026-10-12T00:00:00Z") });
    assert.ok(out.includes("utm_source=reddit") && out.includes("utm_campaign=shipsprint_site_20261012") && out.endsWith("#top"));
  });
});

describe("retry", () => {
  it("succeeds on 3rd attempt", async () => {
    let n = 0;
    const v = await retry(async () => { n++; if (n < 3) { const e: any = new Error("boom"); e.status = 503; throw e; } return "ok"; }, { maxAttempts: 5, baseMs: 1 });
    assert.equal(v, "ok");
    assert.equal(n, 3);
  });
});

describe("attribution", () => {
  it("utm-exact post attributes lift with method=exact", () => {
    const days: string[] = [];
    for (let i = 10; i >= 0; i--) days.push(new Date(Date.UTC(2026, 9, 12 - i)).toISOString());
    const points = days.map((pulled_at, i) => ({ pulled_at, clicks: i >= 7 ? 150 : 80, impressions: i >= 7 ? 50 : 20, signups: i >= 7 ? 10 : 5, referrals: i >= 7 ? ["shipsprint_site_20261010"] : [] }));
    const r = attributePost({ workspace_id: "ws", published_post_id: "p1", live_url: "https://reddit.com/x", utm: "utm_campaign=shipsprint_site_20261010", published_at: "2026-10-10T00:00:00Z" }, points as any);
    assert.equal(r.method, "exact");
    assert.ok(r.traffic_lift > 0);
  });
});
