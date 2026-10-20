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
  assert.deepEqual(await response.json(), { updatedAt: null });
  assert.equal(urls.length, 0);
});

test("sanitize keeps a homepage row and drops gps and heart rate", async () => {
  const store = env(knownKey);
  const recent = new Date(Date.now() - 3_600_000).toISOString();
  const feed = await refresh(store, intervalsProvider, async (input) => {
    const url = String(input);
    if (url.includes("/athlete/0/activities")) {
      return jsonResponse([
        { ...rawActivity, start_date_local: recent },
        { ...rawActivity, id: "i100", private: true, name: "Hidden", start_date_local: recent },
        { ...rawActivity, id: "i101", type: "VirtualRide", name: "Turbo", start_date_local: recent },
      ]);
    }
    throw new Error(`unexpected ${url}`);
  }) as { label: string; activity: { label: string; value: string }[] };

  assert.equal(feed.label, "Training");
  assert.equal(feed.activity.length, 2);
  assert.match(feed.activity.map((row) => row.label).join(" "), /Run/);
  assert.match(feed.activity.map((row) => row.label).join(" "), /Ride/);
  const saved = (await store.FEED.get("intervals")) ?? "";
  assert.equal(saved.includes("heartrate"), false);
  assert.equal(saved.includes("52.83"), false);
  assert.equal(saved.includes("latlng"), false);
  assert.equal(saved.includes("Hidden"), false);
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
          start: new Date(Date.now() - 3_600_000).toISOString(),
        },
      ],
    }),
  );
  const feed = await refresh(store, intervalsProvider, async () => jsonResponse({ message: "no" }, 500)) as { stale?: boolean; activity: { value: string }[] };
  assert.equal(feed.stale, true);
  assert.match(feed.activity[0]?.value ?? "", /1\.0 km/);
});

test("an env key fills the feed and is not stored", async () => {
  const store = env("intervals*key");
  const response = await handleRequest(
    new Request("https://activities.sradams.co.uk/feed.json"),
    store,
    async (input) => {
      const url = String(input);
      if (url.endsWith("/athlete")) return jsonResponse({ id: "i2049151", name: "Scott Adams" });
      if (url.includes("/activities")) return jsonResponse([{ ...rawActivity, start_date_local: new Date().toISOString() }]);
      throw new Error(`unexpected ${url}`);
    },
  );
  const body = (await response.json()) as { intervals: { label: string; activity: unknown[] } };
  assert.equal(body.intervals.label, "Training");
  assert.equal(body.intervals.activity.length, 1);
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
  const body = (await response.json()) as { updatedAt: string | null; intervals?: unknown };
  assert.equal(body.updatedAt, null);
  assert.equal(body.intervals, undefined);
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
  const feed = await refresh(store, intervalsProvider, async (input) => {
    if (String(input).includes("/map")) return jsonResponse({}, 404);
    calls += 1;
    const id = calls === 1 ? "i1" : "i2";
    const start = new Date(Date.now() - calls * 3_600_000).toISOString();
    return jsonResponse([{ ...rawActivity, id, name: id, start_date_local: start }]);
  }) as { activity: { label: string }[] };
  assert.equal(calls, 2);
  const labels = feed.activity.map((row) => row.label).join(" ");
  assert.match(labels, /Personal/);
  assert.match(labels, /Work/);
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

test("the latest activity is featured with a shape-only route and no coordinates", async () => {
  const store = env(knownKey);
  const recent = new Date(Date.now() - 3_600_000).toISOString();
  const older = new Date(Date.now() - 7_200_000).toISOString();
  // A 2.2 km out-and-back line heading north-east from a "home" point.
  const latlngs = Array.from({ length: 200 }, (_, index) => [52.8301 + index * 0.0001, -1.1801 + index * 0.00005]);
  const urls: string[] = [];
  const feed = await refresh(store, intervalsProvider, async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/athlete/0/activities")) {
      return jsonResponse([
        { ...rawActivity, id: "i5", name: "Older", start_date_local: older },
        { ...rawActivity, id: "i6", name: "Evening run", start_date_local: recent },
      ]);
    }
    if (url.endsWith("/activity/i6/map")) return jsonResponse({ bounds: [[52.83, -1.18], [52.85, -1.17]], latlngs });
    throw new Error(`unexpected ${url}`);
  }) as { featured?: { heading: string; title: string; subtitle: string; details: string[]; route?: { width: number; height: number; points: number[][] } } };
  assert.ok(urls.some((url) => url.endsWith("/activity/i6/map")));
  assert.equal(feed.featured?.heading, "Latest activity");
  assert.equal(feed.featured?.title, "Evening run");
  assert.match(feed.featured?.subtitle ?? "", /^Run · /);
  assert.deepEqual(feed.featured?.details.slice(0, 2), ["5.0 km", "25m"]);
  const route = feed.featured?.route;
  assert.ok(route && route.points.length >= 2);
  assert.ok(route.points.every(([x, y]) => x >= 0 && y >= 0 && x <= route.width && y <= route.height));
  const saved = (await store.FEED.get("intervals")) ?? "";
  assert.equal(saved.includes("52.83"), false);
  assert.equal(saved.includes("-1.18"), false);
  assert.equal(JSON.stringify(feed).includes("52.8"), false);
});

test("an activity without GPS still gets a featured card with a fallback note", async () => {
  const store = env(knownKey);
  const recent = new Date(Date.now() - 3_600_000).toISOString();
  const feed = await refresh(store, intervalsProvider, async (input) => {
    const url = String(input);
    if (url.includes("/athlete/0/activities")) return jsonResponse([{ ...rawActivity, id: "i7", name: "Turbo", type: "VirtualRide", start_date_local: recent }]);
    return jsonResponse({ latlngs: null });
  }) as { featured?: { route?: unknown; description: string } };
  assert.equal(feed.featured?.route, undefined);
  assert.equal(feed.featured?.description, "No GPS map for this session.");
});
