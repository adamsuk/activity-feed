import assert from "node:assert/strict";
import test from "node:test";
import { refresh } from "./index.ts";
import { lastfmProvider, lastfmUser, toPublicLastfm } from "./lastfm.ts";
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
  assert.equal(calls.length, 5);
  assert.ok(calls.every((url) => url.searchParams.get("user") === "scotty-bob" && url.searchParams.get("format") === "json"));
  assert.equal(calls[1].searchParams.get("period"), "7day");
  assert.equal(calls[0].searchParams.get("from"), String(NOW / 1000 - 7 * 24 * 3600));
  assert.equal(block.label, "Music");
  assert.equal(block.profilePicture, "");
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

test("empty listening still shows the source", () => {
  const block = toPublicLastfm({ recent: [], scrobbles: 0, topTrack: null, updatedAt: null }, "scotty-bob");
  assert.ok(block);
  assert.deepEqual(block.activity, []);
  assert.equal(block.summary, "");
  assert.equal(block.profilePicture, "");
  assert.equal(toPublicLastfm({ activity: [] }, "scotty-bob"), null);
});

const ALBUM_IMAGES = [
  { size: "small", "#text": "https://lastfm.freetls.fastly.net/i/u/34s/abc.png" },
  { size: "extralarge", "#text": "https://lastfm.freetls.fastly.net/i/u/300x300/abc.png" },
];

test("the top album is featured with its artwork and the top track as a link", async () => {
  const responses = { ...RESPONSES, "user.gettopalbums": { topalbums: { album: [{ name: "Big Album", playcount: "12", artist: { name: "Band" }, url: "https://www.last.fm/music/Band/Big+Album", image: ALBUM_IMAGES }] } } };
  const block = await refresh(env(), lastfmProvider, async (input) => {
    const url = new URL(String(input));
    return Response.json((responses as Record<string, unknown>)[url.searchParams.get("method") ?? ""] ?? { error: 6 });
  }, NOW) as { featured?: Record<string, unknown> };
  const featured = block.featured as { heading: string; title: string; subtitle: string; image: string; details: string[]; link?: { label: string; detail: string; url: string }; video?: unknown };
  assert.equal(featured.heading, "Top album this week");
  assert.equal(featured.title, "Big Album");
  assert.equal(featured.subtitle, "Band");
  assert.equal(featured.image, "https://lastfm.freetls.fastly.net/i/u/300x300/abc.png");
  assert.deepEqual(featured.details, ["12 plays"]);
  assert.deepEqual(featured.link, { label: "Top track · Big Song", detail: "Band · 9 plays", url: "https://www.last.fm/music/Band/_/Big+Song" });
  assert.equal(featured.video, undefined);
});

test("with a YouTube key the top track gets one cached video id", async () => {
  const e = env({ YOUTUBE_API_KEY: "yt-key" });
  let searches = 0;
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.hostname === "www.googleapis.com") {
      searches += 1;
      assert.equal(url.searchParams.get("q"), "Band Big Song");
      return Response.json({ items: [{ id: { videoId: "dQw4w9WgXcQ" } }] });
    }
    return Response.json(RESPONSES[url.searchParams.get("method") ?? ""] ?? { error: 6 });
  };
  const first = await refresh(e, lastfmProvider, fetchImpl, NOW) as { featured?: { video?: { youtubeId: string } } };
  assert.equal(first.featured?.video?.youtubeId, "dQw4w9WgXcQ");
  await refresh(e, lastfmProvider, fetchImpl, NOW);
  assert.equal(searches, 1);
  assert.equal(((await e.FEED.get("lastfm")) ?? "").includes("yt-key"), false);
});

test("placeholder artwork is ignored", async () => {
  const { imageFromJson } = await import("./lastfm.ts");
  assert.equal(imageFromJson([{ size: "extralarge", "#text": "https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png" }]), "");
  assert.equal(imageFromJson([{ size: "extralarge", "#text": "https://evil.example/a.png" }]), "");
});

test("the profile picture comes from the current user.getInfo image", async () => {
  const picture = "https://lastfm.freetls.fastly.net/i/u/300x300/9f3c1a0e7b2d4c88a1e0.png";
  const calls: string[] = [];
  const responses: Record<string, unknown> = {
    ...RESPONSES,
    "user.getInfo": {
      user: {
        image: [
          { size: "medium", "#text": "https://lastfm.freetls.fastly.net/i/u/64s/9f3c1a0e7b2d4c88a1e0.png" },
          { size: "extralarge", "#text": picture },
        ],
      },
    },
  };
  const block = await refresh(env(), lastfmProvider, async (input) => {
    const url = new URL(String(input));
    const method = url.searchParams.get("method") ?? "";
    calls.push(method);
    return Response.json(responses[method] ?? { error: 6 });
  }, NOW);
  assert.ok(calls.includes("user.getInfo"));
  assert.equal(block?.profilePicture, picture);
});

test("an unusable or failed user.getInfo image publishes an empty profile picture", async () => {
  const fetchInfo = (info: Response | Record<string, unknown>) => async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const method = url.searchParams.get("method") ?? "";
    if (method === "user.getInfo") return info instanceof Response ? info : Response.json(info);
    return Response.json(RESPONSES[method] ?? { error: 6 });
  };
  const greyStar = "https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png";
  const placeholder = await refresh(env(), lastfmProvider, fetchInfo({
    user: { image: [{ size: "extralarge", "#text": greyStar }] },
  }), NOW);
  assert.equal(placeholder?.profilePicture, "");

  const offHost = await refresh(env(), lastfmProvider, fetchInfo({
    user: { image: [{ size: "extralarge", "#text": "https://evil.example/avatar.png" }] },
  }), NOW);
  assert.equal(offHost?.profilePicture, "");

  const insecure = await refresh(env(), lastfmProvider, fetchInfo({
    user: { image: [{ size: "extralarge", "#text": "http://lastfm.freetls.fastly.net/i/u/300x300/abc.png" }] },
  }), NOW);
  assert.equal(insecure?.profilePicture, "");

  const failed = await refresh(env(), lastfmProvider, fetchInfo(new Response("down", { status: 503 })), NOW);
  assert.ok(failed);
  assert.equal(failed.profilePicture, "");
  assert.equal(failed.summary, "42 scrobbles this week");
});
