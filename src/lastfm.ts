import { sanitizeFeatured, type Featured } from "./featured.ts";
import type { Provider } from "./provider.ts";
import type { SourceBlock } from "./source.ts";
import type { Env } from "./types.ts";

const API = "https://ws.audioscrobbler.com/2.0/";
const WEEK_S = 7 * 24 * 60 * 60;
export const LASTFM_DEFAULT_USER = "scotty-bob";
/** Raw Last.fm avatar; may change, so the site falls back to GitHub. */
export const LASTFM_PICTURE = "https://lastfm-img.freetls.fastly.net/i/u/avatar170s/dab58fd0450ba281006e849c2088c214.png";

function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function lastfmUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.last.fm" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function lastfmUser(env: Env): string {
  const user = env.LASTFM_USER?.trim() || LASTFM_DEFAULT_USER;
  return /^[A-Za-z][A-Za-z0-9_-]{1,14}$/.test(user) ? user : "";
}

function apiKey(env: Env): string {
  return env.LASTFM_API_KEY?.trim() ?? "";
}

/** "#text" or "name" from a Last.fm artist object or string. */
function artistName(value: unknown): string {
  if (typeof value === "string") return clean(value, 120);
  if (!value || typeof value !== "object") return "";
  const row = value as Record<string, unknown>;
  return clean(row["#text"] ?? row.name, 120);
}

function list(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object");
  return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
}

async function call(
  method: string,
  params: Record<string, string>,
  env: Env,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const url = new URL(API);
  url.searchParams.set("method", method);
  url.searchParams.set("user", lastfmUser(env));
  url.searchParams.set("api_key", apiKey(env));
  url.searchParams.set("format", "json");
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const response = await fetchImpl(url, { headers: { "User-Agent": "sradams-activity-feed" } });
  if (!response.ok) throw new Error(`Last.fm ${method} failed (${response.status})`);
  const body = (await response.json()) as Record<string, unknown>;
  if (!body || typeof body !== "object" || "error" in body) throw new Error(`Last.fm ${method} returned an error`);
  return body;
}

type Track = { name: string; artist: string; url: string; nowPlaying: boolean; at: string | null };
type Top = { name: string; artist: string; url: string; plays: number; image?: string };

/** Last.fm's grey star, served when it has no real artwork. */
const PLACEHOLDER = "2a96cbd8b46e442fc41c2b86b821562f";

export function imageFromJson(value: unknown): string {
  const images = list(value);
  for (const size of ["extralarge", "large", "medium"]) {
    const found = images.find((image) => image.size === size);
    const url = typeof found?.["#text"] === "string" ? found["#text"] : "";
    if (!url || url.includes(PLACEHOLDER)) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" && /(^|\.)(fastly\.net|last\.fm|lst\.fm)$/.test(parsed.hostname)) return parsed.toString();
    } catch {
      // try the next size
    }
  }
  return "";
}

export function recentFromJson(body: Record<string, unknown>): { tracks: Track[]; scrobbles: number } {
  const root = (body.recenttracks ?? {}) as Record<string, unknown>;
  const attr = (root["@attr"] ?? {}) as Record<string, unknown>;
  const total = Number(attr.total);
  const tracks: Track[] = [];
  for (const row of list(root.track)) {
    const name = clean(row.name, 160);
    if (!name) continue;
    const date = row.date as Record<string, unknown> | undefined;
    const uts = Number(date?.uts);
    const nowPlaying = (row["@attr"] as Record<string, unknown> | undefined)?.nowplaying === "true";
    tracks.push({
      name,
      artist: artistName(row.artist),
      url: lastfmUrl(row.url),
      nowPlaying,
      at: Number.isFinite(uts) && uts > 0 ? new Date(uts * 1000).toISOString() : null,
    });
    if (tracks.length === 5) break;
  }
  return { tracks, scrobbles: Number.isInteger(total) && total >= 0 ? total : 0 };
}

export function topFromJson(body: Record<string, unknown>, root: string, item: string): Top | null {
  const section = (body[root] ?? {}) as Record<string, unknown>;
  const first = list(section[item])[0];
  if (!first) return null;
  const name = clean(first.name, 160);
  if (!name) return null;
  const plays = Number(first.playcount);
  const top: Top = {
    name,
    artist: artistName(first.artist),
    url: lastfmUrl(first.url),
    plays: Number.isInteger(plays) && plays > 0 ? plays : 0,
  };
  const image = imageFromJson(first.image);
  if (image) top.image = image;
  return top;
}

function plays(count: number): string {
  return count === 1 ? "1 play" : `${count} plays`;
}

function when(at: string | null): string {
  return at && Number.isFinite(Date.parse(at))
    ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" }).format(Date.parse(at))
    : "";
}

function topRow(prefix: string, value: unknown): SourceBlock["activity"][number] | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const name = clean(row.name, 120);
  if (!name) return null;
  const artist = clean(row.artist, 80);
  const count = typeof row.plays === "number" && row.plays > 0 ? row.plays : 0;
  return {
    label: `${prefix} · ${name}`,
    value: [artist, count ? plays(count) : ""].filter(Boolean).join(" · ") || prefix,
    url: lastfmUrl(row.url),
  };
}

function youtubeSearch(track: string, artist: string): string {
  const url = new URL("https://www.youtube.com/results");
  url.searchParams.set("search_query", `${artist} ${track}`.trim());
  return url.toString();
}

export function featuredMusic(row: Record<string, unknown>): Featured | null {
  const album = (row.topAlbum ?? null) as Record<string, unknown> | null;
  const track = (row.topTrack ?? null) as Record<string, unknown> | null;
  const albumName = clean(album?.name, 160);
  const trackName = clean(track?.name, 160);
  const trackArtist = clean(track?.artist, 120);
  const video = (row.video ?? null) as Record<string, unknown> | null;
  const videoMatches = video && video.track === trackName && video.artist === trackArtist;
  const trackLink = trackName
    ? {
      label: trackName,
      detail: [trackArtist, typeof track?.plays === "number" && track.plays > 0 ? plays(track.plays) : ""].filter(Boolean).join(" · "),
      url: lastfmUrl(track?.url) || youtubeSearch(trackName, trackArtist),
    }
    : undefined;
  const youtube = videoMatches ? { youtubeId: video.youtubeId, title: `${trackArtist} – ${trackName}` } : undefined;
  if (albumName) {
    const count = typeof album?.plays === "number" && album.plays > 0 ? plays(album.plays) : "";
    return sanitizeFeatured({
      heading: "Top album this week",
      title: albumName,
      subtitle: clean(album?.artist, 120),
      description: "",
      url: lastfmUrl(album?.url),
      image: typeof album?.image === "string" ? album.image : "",
      details: [count],
      link: trackLink ? { ...trackLink, label: `Top track · ${trackLink.label}` } : undefined,
      video: youtube,
    });
  }
  if (!trackLink) return null;
  return sanitizeFeatured({
    heading: "Top track this week",
    title: trackName,
    subtitle: trackArtist,
    description: "",
    url: trackLink.url,
    image: "",
    details: [trackLink.detail.split(" · ").pop() ?? ""],
    video: youtube,
  });
}

/**
 * Optional. With YOUTUBE_API_KEY set, finds one embeddable video for the top track.
 * The result is reused until the top track changes, so the 100-unit search runs rarely.
 */
async function loadVideo(
  env: Env,
  topTrack: Top | null,
  fetchImpl: typeof fetch,
): Promise<{ track: string; artist: string; youtubeId: string } | null> {
  const key = env.YOUTUBE_API_KEY?.trim();
  if (!key || !topTrack) return null;
  try {
    const previous = JSON.parse((await env.FEED.get("lastfm")) ?? "null") as Record<string, unknown> | null;
    const cached = previous?.video as Record<string, unknown> | undefined;
    if (cached && cached.track === topTrack.name && cached.artist === topTrack.artist && typeof cached.youtubeId === "string") {
      return { track: topTrack.name, artist: topTrack.artist, youtubeId: cached.youtubeId };
    }
  } catch {
    // search again
  }
  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "id");
    url.searchParams.set("type", "video");
    url.searchParams.set("videoEmbeddable", "true");
    url.searchParams.set("maxResults", "1");
    url.searchParams.set("q", `${topTrack.artist} ${topTrack.name}`);
    url.searchParams.set("key", key);
    const response = await fetchImpl(url, { headers: { "User-Agent": "sradams-activity-feed" } });
    if (!response.ok) return null;
    const body = (await response.json()) as { items?: Array<{ id?: { videoId?: unknown } }> };
    const id = body.items?.[0]?.id?.videoId;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    return { track: topTrack.name, artist: topTrack.artist, youtubeId: id };
  } catch {
    return null;
  }
}

export function toPublicLastfm(value: unknown, user: string): SourceBlock | null {
  if (!user || !value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.recent)) return null;
  const activity: SourceBlock["activity"] = [];
  const latest = row.recent[0] as Record<string, unknown> | undefined;
  const latestName = clean(latest?.name, 120);
  if (latest && latestName) {
    const artist = clean(latest.artist, 80);
    const at = typeof latest.at === "string" ? latest.at : null;
    const status = latest.nowPlaying === true ? "Now playing" : when(at);
    activity.push({
      label: `Latest · ${latestName}`,
      value: [artist, status].filter(Boolean).join(" · ") || "Played",
      url: lastfmUrl(latest.url),
    });
  }
  for (const [prefix, key] of [["Top track", "topTrack"], ["Top album", "topAlbum"], ["Top artist", "topArtist"]] as const) {
    const top = topRow(prefix, row[key]);
    if (top) activity.push(top);
  }
  const scrobbles = typeof row.scrobbles === "number" && row.scrobbles > 0 ? row.scrobbles : 0;
  const featured = featuredMusic(row);
  return {
    label: "Music",
    profileUrl: `https://www.last.fm/user/${user}`,
    profilePicture: LASTFM_PICTURE,
    summary: scrobbles ? `${scrobbles === 1 ? "1 scrobble" : `${scrobbles} scrobbles`} this week` : "",
    activity,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    ...(featured ? { featured } : {}),
  };
}

export const lastfmProvider: Provider = {
  id: "lastfm",
  enabled(env) {
    return apiKey(env) !== "" && lastfmUser(env) !== "";
  },
  async load(env, fetchImpl, now = Date.now()) {
    const from = String(Math.floor(now / 1000) - WEEK_S);
    const recent = recentFromJson(await call("user.getrecenttracks", { limit: "5", from }, env, fetchImpl));
    const week = { period: "7day", limit: "1" };
    const topTrack = topFromJson(await call("user.gettoptracks", week, env, fetchImpl), "toptracks", "track");
    const topAlbum = topFromJson(await call("user.gettopalbums", week, env, fetchImpl), "topalbums", "album");
    const topArtist = topFromJson(await call("user.gettopartists", week, env, fetchImpl), "topartists", "artist");
    const video = await loadVideo(env, topTrack, fetchImpl);
    return {
      updatedAt: new Date(now).toISOString(),
      stale: false,
      recent: recent.tracks,
      scrobbles: recent.scrobbles,
      topTrack,
      topAlbum,
      topArtist,
      ...(video ? { video } : {}),
    };
  },
  publish(env, value) {
    return toPublicLastfm(value, lastfmUser(env));
  },
};
