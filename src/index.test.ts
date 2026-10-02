import assert from "node:assert/strict";
import test from "node:test";
import { MemoryKv } from "./memory-kv.ts";
import { handleRequest, refreshFeed } from "./index.ts";
import type { Env } from "./types.ts";

const rawActivity = {
  id: "i99",
  name: "Morning\nloop",
  distance: 5000.4,
  moving_time: 1500,
  total_elevation_gain: 12.2,
  type: "Run",
  start_date_local: "2026-10-01T06:00:00",
  average_heartrate: 150,
  start_latlng: [52.83, -1.18],
};

function env(): Env {
  return {
    FEED: new MemoryKv(),
    ALLOWED_ORIGINS: "https://sradams.co.uk",
  };
}

function accountJson() {
  return JSON.stringify({ apiKey: "intervals-key", athleteId: "i2049151", athleteName: "Scott Adams" });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

test("public feed is empty and does not call Intervals.icu", async () => {
  let called = 0;
  const response = await handleRequest(
    new Request("https://activities.sradams.co.uk/feed.json"),
    env(),
    async () => {
      called += 1;
      return jsonResponse({});
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    source: "empty",
    updatedAt: null,
    stale: false,
    activities: [],
  });
  assert.equal(called, 0);
});

test("sanitize keeps a homepage row and drops gps and heart rate", async () => {
  const store = env();
  await store.FEED.put("intervals", accountJson());
  const feed = await refreshFeed(store, async (input) => {
    const url = String(input);
    if (url.includes("/athlete/i2049151/activities")) {
      return jsonResponse([
        rawActivity,
        { ...rawActivity, id: "i100", private: true, name: "Hidden" },
        { ...rawActivity, id: "i101", type: "VirtualRide", name: "Turbo", start_date_local: "2026-10-02T06:00:00" },
      ]);
    }
    throw new Error(`unexpected ${url}`);
  });

  assert.equal(feed.activities.length, 2);
  assert.equal(feed.activities[0]?.sport, "Ride");
  assert.equal(feed.activities[0]?.name, "Turbo");
  assert.equal(feed.activities[1]?.name, "Morning loop");
  assert.equal(feed.activities[1]?.distanceM, 5000);
  assert.equal(feed.activities[1]?.url, "https://intervals.icu/activities/i99");
  const saved = JSON.stringify(feed);
  assert.equal(saved.includes("heartrate"), false);
  assert.equal(saved.includes("52.83"), false);
  assert.equal(saved.includes("latlng"), false);
});

test("a failed refresh keeps the last good cache and marks it stale", async () => {
  const store = env();
  await store.FEED.put("intervals", accountJson());
  await store.FEED.put(
    "feed",
    JSON.stringify({
      source: "intervals",
      updatedAt: "2026-10-01T06:00:00Z",
      stale: false,
      activities: [
        {
          id: "i1",
          name: "Kept",
          sport: "Run",
          start: "2026-10-01T06:00:00",
          distanceM: 1000,
          movingS: 300,
          elevationM: 0,
          location: "",
          url: "https://intervals.icu/activities/i1",
        },
      ],
    }),
  );
  const feed = await refreshFeed(store, async () => jsonResponse({ message: "no" }, 500));
  assert.equal(feed.stale, true);
  assert.equal(feed.activities[0]?.name, "Kept");
});

test("saving a key stores the athlete and does not echo the key", async () => {
  const store = env();
  const response = await handleRequest(
    new Request("https://activities.sradams.co.uk/connect", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "apiKey=intervals-key",
    }),
    store,
    async (input) => {
      const url = String(input);
      if (url.endsWith("/athlete")) {
        return jsonResponse({ id: "i2049151", name: "Scott Adams" });
      }
      if (url.includes("/activities")) return jsonResponse([rawActivity]);
      throw new Error(`unexpected ${url}`);
    },
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("Location"), "https://activities.sradams.co.uk/?connected=1");
  const page = await handleRequest(new Request("https://activities.sradams.co.uk/"), store);
  const html = await page.text();
  assert.equal(html.includes("intervals-key"), false);
  assert.equal(html.includes("Scott Adams"), true);
  const stored = JSON.parse((await store.FEED.get("intervals")) ?? "{}") as { apiKey?: string };
  assert.equal(stored.apiKey, "intervals-key");
});

test("public feed fills from a stored key when the cache is empty", async () => {
  const store = env();
  await store.FEED.put("intervals", accountJson());
  const response = await handleRequest(
    new Request("https://activities.sradams.co.uk/feed.json"),
    store,
    async (input) => {
      const url = String(input);
      if (url.includes("/activities")) return jsonResponse([rawActivity]);
      throw new Error(`unexpected ${url}`);
    },
  );
  const body = (await response.json()) as { source: string; activities: unknown[] };
  assert.equal(body.source, "intervals");
  assert.equal(body.activities.length, 1);
});

test("a refused activity pull stays empty and does not leak the key", async () => {
  const store = env();
  await store.FEED.put("intervals", accountJson());
  const response = await handleRequest(
    new Request("https://activities.sradams.co.uk/feed.json"),
    store,
    async () => jsonResponse({ message: "Unauthorized" }, 401),
  );
  const body = (await response.json()) as { source: string };
  assert.equal(body.source, "empty");
  const sync = JSON.parse((await store.FEED.get("sync")) ?? "{}") as { message?: string };
  assert.match(sync.message ?? "", /401/);
  assert.equal((sync.message ?? "").includes("intervals-key"), false);
});

test("cors allows the site and ignores other origins", async () => {
  const store = env();
  const allowed = await handleRequest(
    new Request("https://activities.sradams.co.uk/feed.json", {
      headers: { Origin: "https://sradams.co.uk" },
    }),
    store,
  );
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://sradams.co.uk");
  const blocked = await handleRequest(
    new Request("https://activities.sradams.co.uk/feed.json", {
      headers: { Origin: "https://evil.example" },
    }),
    store,
  );
  assert.equal(blocked.headers.get("Access-Control-Allow-Origin"), null);
});
