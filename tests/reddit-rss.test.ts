import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseRssFeed,
  pollSubreddits,
  redditTier,
  resetRssThrottle,
} from "../src/discover/reddit-rss.js";

const FEED = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><title>How do you price your SaaS?</title>
<link href="https://www.reddit.com/r/SaaS/comments/abc123/how_do_you_price/"/>
<updated>2026-10-12T10:00:00+00:00</updated>
<author><name>/u/founder_anna</name><uri>https://www.reddit.com/user/founder_anna</uri></author>
<content type="html">&lt;div class=&quot;md&quot;&gt;&lt;p&gt;We charge &lt;em&gt;$29&lt;/em&gt; per seat.&lt;/p&gt;&lt;/div&gt; submitted by &lt;a href=&quot;https://www.reddit.com/user/founder_anna&quot;&gt; founder_anna &lt;/a&gt;</content>
<id>t3_abc123</id></entry>
<entry><title>No link here</title><updated>2026-10-12T11:00:00+00:00</updated><id>t3_nope</id></entry>
</feed>`;

const okFeed = (xml: string) =>
  new Response(xml, { status: 200, headers: { "content-type": "application/atom+xml" } });

describe("reddit-rss parser", () => {
  it("parses title/url/author/excerpt, skips linkless entries", () => {
    const entries = parseRssFeed(FEED);
    assert.equal(entries.length, 1);
    const [e] = entries;
    assert.equal(e.title, "How do you price your SaaS?");
    assert.equal(e.url, "https://www.reddit.com/r/SaaS/comments/abc123/how_do_you_price/");
    assert.equal(e.author, "/u/founder_anna");
    assert.ok(e.excerpt.includes("We charge $29 per seat."));
    assert.ok(!e.excerpt.includes("<"), "tags stripped");
  });

  it("empty/gutted feed yields zero entries", () => {
    assert.equal(parseRssFeed("").length, 0);
    assert.equal(parseRssFeed("<feed></feed>").length, 0);
  });
});

describe("reddit-rss throttle + fetch", () => {
  it("enforces min spacing between requests (injected clock, no real waiting)", async () => {
    resetRssThrottle();
    const sleeps: number[] = [];
    let now = 1_000_000;
    const opts = {
      minIntervalMs: 45_000,
      fetchFn: (async () => okFeed(FEED)) as typeof fetch,
      sleepFn: async (ms: number) => { sleeps.push(ms); now += ms; },
      nowFn: () => now,
    };
    const r1 = await pollSubreddits(["SaaS"], ["hot"], opts);
    assert.equal(r1.candidates.length, 1);
    assert.equal(sleeps.length, 0, "first request goes immediately");
    now += 5_000; // only 5s later
    const r2 = await pollSubreddits(["SaaS"], ["hot"], opts);
    assert.equal(r2.candidates.length, 1);
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0] >= 39_000 && sleeps[0] <= 45_000, `slept ${sleeps[0]}`);
  });

  it("429 and empty bodies become skips, never throws", async () => {
    resetRssThrottle();
    const opts429 = {
      minIntervalMs: 10_000,
      fetchFn: (async () => new Response("slow down", { status: 429 })) as typeof fetch,
      sleepFn: async () => {},
      nowFn: (() => { let t = 0; return () => (t += 60_000); })(),
    };
    const r = await pollSubreddits(["SaaS"], ["hot"], opts429);
    assert.equal(r.candidates.length, 0);
    assert.equal(r.skipped["rss-throttled"], 1);

    const optsEmpty = {
      ...opts429,
      fetchFn: (async () => okFeed("<feed></feed>")) as typeof fetch,
    };
    const r2 = await pollSubreddits(["SaaS"], ["hot"], optsEmpty);
    assert.equal(r2.candidates.length, 0);
    assert.equal(r2.skipped["rss-throttled"], 1);
  });

  it("candidates are skipFetch inserts from feed content", async () => {
    resetRssThrottle();
    const r = await pollSubreddits(["SaaS"], ["hot"], {
      minIntervalMs: 10_000,
      fetchFn: (async () => okFeed(FEED)) as typeof fetch,
      sleepFn: async () => {},
      nowFn: (() => { let t = 0; return () => (t += 60_000); })(),
    });
    assert.equal(r.candidates[0].source, "reddit-rss");
    assert.equal(r.candidates[0].skipFetch, true);
  });
});

describe("redditTier", () => {
  it("auto without creds → rss; with creds → oauth; forced respected", () => {
    const keep = { ...process.env };
    try {
      delete process.env.REDDIT_CLIENT_ID;
      delete process.env.REDDIT_CLIENT_SECRET;
      delete process.env.REDDIT_SOURCE;
      assert.equal(redditTier(), "rss");
      process.env.REDDIT_CLIENT_ID = "x";
      process.env.REDDIT_CLIENT_SECRET = "y";
      assert.equal(redditTier(), "oauth");
      process.env.REDDIT_SOURCE = "rss";
      assert.equal(redditTier(), "rss");
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
      Object.assign(process.env, keep);
    }
  });
});
