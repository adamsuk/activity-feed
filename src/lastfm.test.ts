import assert from "node:assert/strict";
import test from "node:test";
import { refresh } from "./index.ts";
import { LASTFM_PICTURE, lastfmProvider, lastfmUser, toPublicLastfm } from "./lastfm.ts";
import { MemoryKv } from "./memory-kv.ts";
import type { Env } from "./types.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");

const RESPONSES: Record<string, unknown> = {
  "user.getrecenttracks": {
    recenttracks: {
      "@attr": { user: "scotty-bob", total: "42" },
      track: [
        { name: "Playing Now", artist: { "#text": "Band" }, url: "https://www.last.fm/music/Band/_/Playing+Now", "@attr": { nowplaying: "true" } },
        { name: "Earlier", artist: { "#text": "Band" }, url: "https://evil.example/x", date: { uts: "1760600000" } },
      ],
    },
  },
  "user.gettoptracks": { toptracks: { track: [{ name: "Big Song", playcount: "9", artist: { name: "Band" }, url: "https://www.last.fm/music/Band/_/Big+Song" }] } },
  "user.gettopalbums": { topalbums: { album: { name: "Big Album", playcount: "12", artist: { name: "Band" }, url: "https://www.last.fm/music/Band/Big+Album" } } },
  "user.gettopartists": { topartists: { artist: [] } },
};

function env(extra: Partial<Env> = {}): Env {
  return { FEED: new MemoryKv(), LASTFM_API_KEY: "key", ...extra };
}

const fetchMock = (calls: URL[]) => async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  calls.push(url);
  return Response.json(RESPONSES[url.searchParams.get("method") ?? ""] ?? { error: 6 });
};

test("last.fm is skipped without an API key", async () => {
  let called = 0;
  const result = await refresh({ FEED: new MemoryKv() }, lastfmProvider, async () => {
    called += 1;
    return new Response("no");
  });
  assert.equal(result, null);
  assert.equal(called, 0);
});

test("the user defaults to scotty-bob and rejects bad names", () => {
  assert.equal(lastfmUser(env()), "scotty-bob");
  assert.equal(lastfmUser(env({ LASTFM_USER: "other_user" })), "other_user");
  assert.equal(lastfmUser(env({ LASTFM_USER: "bad/../name" })), "");
  assert.equal(lastfmProvider.enabled(env({ LASTFM_USER: "bad/../name" })), false);
});

test("last.fm publishes latest track, weekly tops and scrobble count", async () => {
  const calls: URL[] = [];
  const e = env();
  const block = await refresh(e, lastfmProvider, fetchMock(calls), NOW);
  assert.ok(block);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((url) => url.searchParams.get("user") === "scotty-bob" && url.searchParams.get("format") === "json"));
  assert.equal(calls[1].searchParams.get("period"), "7day");
  assert.equal(calls[0].searchParams.get("from"), String(NOW / 1000 - 7 * 24 * 3600));
  assert.equal(block.label, "Music");
  assert.equal(block.profilePicture, LASTFM_PICTURE);
  assert.equal(block.profileUrl, "https://www.last.fm/user/scotty-bob");
  assert.equal(block.summary, "42 scrobbles this week");
  assert.deepEqual(block.activity, [
    { label: "Latest · Playing Now", value: "Band · Now playing", url: "https://www.last.fm/music/Band/_/Playing+Now" },
    { label: "Top track · Big Song", value: "Band · 9 plays", url: "https://www.last.fm/music/Band/_/Big+Song" },
    { label: "Top album · Big Album", value: "Band · 12 plays", url: "https://www.last.fm/music/Band/Big+Album" },
  ]);
  const raw = JSON.parse((await e.FEED.get("lastfm")) ?? "{}");
  assert.equal(raw.recent[1].url, "", "non-Last.fm links are dropped");
  assert.ok(!JSON.stringify(raw).includes("key"), "the API key is not cached");
});

test("an API error does not publish a section", async () => {
  await assert.rejects(refresh(env(), lastfmProvider, async () => Response.json({ error: 10, message: "Invalid API key" }), NOW));
});

test("empty listening still shows the source with its picture", () => {
  const block = toPublicLastfm({ recent: [], scrobbles: 0, topTrack: null, updatedAt: null }, "scotty-bob");
  assert.ok(block);
  assert.deepEqual(block.activity, []);
  assert.equal(block.summary, "");
  assert.equal(block.profilePicture, LASTFM_PICTURE);
  assert.equal(toPublicLastfm({ activity: [] }, "scotty-bob"), null);
});
