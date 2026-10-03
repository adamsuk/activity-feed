import assert from "node:assert/strict";
import test from "node:test";
import { MemoryKv } from "./memory-kv.ts";
import { handleRequest, refresh } from "./index.ts";
import { intervalsProvider } from "./intervals.ts";
import type { Env, Feed } from "./types.ts";

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

function env(apiKey?: string): Env {
  return {
    FEED: new MemoryKv(),
    ALLOWED_ORIGINS: "https://sradams.co.uk",
    INTERVALS_API_KEY: apiKey,
  };
}

const knownKey = "intervals-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

test("public feed is empty and does not call Intervals.icu", async () => {
  const urls: string[] = [];
  const response = await handleRequest(
    new Request("https://activities.sradams.co.uk/feed.json"),
    env(),
    async (input) => {
      urls.push(String(input));
      return jsonResponse({});
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    source: "empty",
    updatedAt: null,
    stale: false,
    activities: [],
  });
  assert.equal(urls.length, 0);
});

test("sanitize keeps a homepage row and drops gps and heart rate", async () => {
  const store = env(knownKey);
  const feed = await refresh(store, intervalsProvider, async (input) => {
    const url = String(input);
    if (url.includes("/athlete/0/activities")) {
      return jsonResponse([
        rawActivity,
        { ...rawActivity, id: "i100", private: true, name: "Hidden" },
        { ...rawActivity, id: "i101", type: "VirtualRide", name: "Turbo", start_date_local: "2026-10-02T06:00:00" },
      ]);
    }
    throw new Error(`unexpected ${url}`);
  }) as Feed;

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
  const store = env(knownKey);
  await store.FEED.put(
    "intervals",
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
  const feed = await refresh(store, intervalsProvider, async () => jsonResponse({ message: "no" }, 500)) as Feed;
  assert.equal(feed.stale, true);
  assert.equal(feed.activities[0]?.name, "Kept");
});

test("an env key fills the feed and is not stored", async () => {
  const store = env("intervals*key");
  const response = await handleRequest(
    new Request("https://activities.sradams.co.uk/feed.json"),
    store,
    async (input) => {
      const url = String(input);
      if (url.endsWith("/athlete")) return jsonResponse({ id: "i2049151", name: "Scott Adams" });
      if (url.includes("/activities")) return jsonResponse([rawActivity]);
      throw new Error(`unexpected ${url}`);
    },
  );
  const body = (await response.json()) as { source: string; activities: unknown[] };
  assert.equal(body.source, "intervals");
  assert.equal(body.activities.length, 1);
  const saved = (await store.FEED.get("intervals")) ?? "";
  assert.equal(saved.includes("intervals*key"), false);
});

test("a refused activity pull stays empty and does not leak the key", async () => {
  const store = env("intervals*key");
  const response = await handleRequest(
    new Request("https://activities.sradams.co.uk/feed.json"),
    store,
    async () => jsonResponse({ message: "Unauthorized" }, 401),
  );
  const body = (await response.json()) as { source: string };
  assert.equal(body.source, "empty");
  const sync = JSON.parse((await store.FEED.get("intervals:sync")) ?? "{}") as { message?: string };
  assert.match(sync.message ?? "", /401/);
  assert.equal((sync.message ?? "").includes("intervals*key"), false);
});

test("intervals accounts are an array and keys stay out of the cache", async () => {
  const store = env("intervals*key");
  store.INTERVALS_ACCOUNTS = JSON.stringify([
    { id: "personal", label: "Personal" },
    { id: "work", label: "Work" },
  ]);
  store.INTERVALS_API_KEY_WORK = "work-key-99";
  let calls = 0;
  const feed = await refresh(store, intervalsProvider, async () => {
    calls += 1;
    const id = calls === 1 ? "i1" : "i2";
    const start = calls === 1 ? "2026-10-01T06:00:00" : "2026-10-02T06:00:00";
    return jsonResponse([{ ...rawActivity, id, name: id, start_date_local: start }]);
  });
  assert.equal(calls, 2);
  assert.equal(feed.activities[0]?.name, "i2");
  assert.equal(feed.activities[0]?.account, "Work");
  assert.equal(feed.activities[1]?.account, "Personal");
  const saved = (await store.FEED.get("intervals")) ?? "";
  assert.equal(saved.includes("intervals*key"), false);
  assert.equal(saved.includes("work-key-99"), false);
});

test("cors allows the site and its preview and ignores other origins", async () => {
  const store = env();
  const fetchImpl = async () => jsonResponse({}, 500);
  const allowed = await handleRequest(
    new Request("https://activities.sradams.co.uk/feed.json", {
      headers: { Origin: "https://sradams.co.uk" },
    }),
    store,
    fetchImpl,
  );
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://sradams.co.uk");
  const preview = await handleRequest(
    new Request("https://activities.sradams.co.uk/feed.json", {
      headers: { Origin: "https://abc123.sradams-co-uk-content.pages.dev" },
    }),
    store,
    fetchImpl,
  );
  assert.equal(preview.headers.get("Access-Control-Allow-Origin"), "https://abc123.sradams-co-uk-content.pages.dev");
  const blocked = await handleRequest(
    new Request("https://activities.sradams.co.uk/feed.json", {
      headers: { Origin: "https://evil.example" },
    }),
    store,
    fetchImpl,
  );
  assert.equal(blocked.headers.get("Access-Control-Allow-Origin"), null);
});
