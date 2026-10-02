import assert from "node:assert/strict";
import test from "node:test";
import { MemoryKv } from "./memory-kv.ts";
import { handleRequest, refreshFeed } from "./index.ts";
import type { Env } from "./types.ts";

const rawActivity = {
  id: 99,
  name: "Morning\nloop",
  distance: 5000.4,
  moving_time: 1500,
  total_elevation_gain: 12.2,
  sport_type: "TrailRun",
  type: "Run",
  start_date: "2026-10-01T06:00:00Z",
  location_city: "East Leake",
  location_state: "England",
  private: false,
  average_heartrate: 150,
  start_latlng: [52.83, -1.18],
  map: { summary_polyline: "secret-trace" },
};

function env(overrides: Partial<Env> = {}): Env {
  return {
    FEED: new MemoryKv(),
    STRAVA_CLIENT_ID: "client",
    STRAVA_CLIENT_SECRET: "secret",
    STRAVA_REFRESH_TOKEN: "refresh-1",
    ALLOWED_ORIGINS: "https://sradams.co.uk",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

test("public feed is empty and does not call Strava", async () => {
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

test("sanitize keeps a homepage row and drops gps, heart rate, and private activities", async () => {
  const store = env();
  await store.FEED.put(
    "token",
    JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: 9_999_999_999 }),
  );
  const feed = await refreshFeed(store, async (input) => {
    const url = String(input);
    if (url.includes("/athlete/activities")) {
      return jsonResponse([
        rawActivity,
        { ...rawActivity, id: 100, private: true, name: "Hidden" },
        { ...rawActivity, id: 101, sport_type: "VirtualRide", name: "Turbo" },
      ]);
    }
    throw new Error(`unexpected ${url}`);
  });

  assert.equal(feed.activities.length, 2);
  assert.equal(feed.activities[0]?.sport, "Run");
  assert.equal(feed.activities[0]?.name, "Morning loop");
  assert.equal(feed.activities[0]?.distanceM, 5000);
  assert.equal(feed.activities[0]?.location, "East Leake, England");
  assert.equal(feed.activities[1]?.sport, "Ride");
  const serialized = JSON.stringify(feed);
  assert.equal(serialized.includes("heartrate"), false);
  assert.equal(serialized.includes("latlng"), false);
  assert.equal(serialized.includes("secret-trace"), false);
  assert.equal(serialized.includes("Hidden"), false);
});

test("refresh stores the rotated refresh token", async () => {
  const store = env();
  await refreshFeed(store, async (input) => {
    const url = String(input);
    if (url.includes("/oauth/token")) {
      return jsonResponse({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_at: 9_999_999_999,
      });
    }
    return jsonResponse([]);
  });
  const saved = JSON.parse((await store.FEED.get("token")) ?? "{}") as { refreshToken?: string };
  assert.equal(saved.refreshToken, "refresh-2");
});

test("a failed refresh keeps the last good cache and marks it stale", async () => {
  const store = env();
  await store.FEED.put(
    "token",
    JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: 9_999_999_999 }),
  );
  await store.FEED.put(
    "feed",
    JSON.stringify({
      source: "strava",
      updatedAt: "2026-10-01T00:00:00.000Z",
      stale: false,
      activities: [
        {
          id: "1",
          name: "Kept",
          sport: "Run",
          start: "2026-10-01T06:00:00Z",
          distanceM: 1000,
          movingS: 300,
          elevationM: 0,
          location: "",
          stravaUrl: "https://www.strava.com/activities/1",
        },
      ],
    }),
  );
  const feed = await refreshFeed(store, async () => jsonResponse({ message: "no" }, 500));
  assert.equal(feed.stale, true);
  assert.equal(feed.activities[0]?.name, "Kept");
});

test("login redirects to Strava and remembers the state", async () => {
  const store = env();
  const started = await handleRequest(
    new Request("https://activities.sradams.co.uk/oauth/start"),
    store,
  );
  assert.equal(started.status, 302);
  const location = started.headers.get("Location") ?? "";
  assert.equal(location.startsWith("https://www.strava.com/oauth/authorize?"), true);
  assert.equal(location.includes("scope=activity%3Aread") || location.includes("scope=activity:read"), true);
  const cookie = started.headers.get("Set-Cookie") ?? "";
  assert.match(cookie, /oauth_state=/);
  assert.match(cookie, /HttpOnly/);
});

test("callback stores the athlete token and does not echo it", async () => {
  const store = env({ STRAVA_REFRESH_TOKEN: undefined });
  const state = "state-1";
  await store.FEED.put(`oauth:${state}`, "1", { expirationTtl: 600 });
  const response = await handleRequest(
    new Request(`https://activities.sradams.co.uk/oauth/callback?code=abc&state=${state}`, {
      headers: { Cookie: `oauth_state=${state}` },
    }),
    store,
    async (input) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return jsonResponse({
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          expires_at: 9_999_999_999,
          athlete: { firstname: "Scott", lastname: "Adams" },
        });
      }
      if (url.includes("/athlete/activities")) return jsonResponse([rawActivity]);
      throw new Error(`unexpected ${url}`);
    },
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "https://activities.sradams.co.uk/?connected=1");
  const saved = JSON.parse((await store.FEED.get("token")) ?? "{}") as {
    refreshToken?: string;
    athleteName?: string;
    accessToken?: string;
  };
  assert.equal(saved.refreshToken, "refresh-secret");
  assert.equal(saved.athleteName, "Scott Adams");
  const page = await handleRequest(new Request("https://activities.sradams.co.uk/"), store);
  const html = await page.text();
  assert.match(html, /Scott Adams/);
  assert.equal(html.includes("access-secret"), false);
  assert.equal(html.includes("refresh-secret"), false);
});

test("cors allows the site and ignores other origins", async () => {
  const allowed = await handleRequest(
    new Request("https://activities.sradams.co.uk/feed.json", {
      headers: { Origin: "https://sradams.co.uk" },
    }),
    env(),
  );
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://sradams.co.uk");

  const blocked = await handleRequest(
    new Request("https://activities.sradams.co.uk/feed.json", {
      headers: { Origin: "https://evil.example" },
    }),
    env(),
  );
  assert.equal(blocked.headers.get("Access-Control-Allow-Origin"), null);
});
