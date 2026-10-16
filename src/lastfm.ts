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
type Top = { name: string; artist: string; url: string; plays: number };

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
  return {
    name,
    artist: artistName(first.artist),
    url: lastfmUrl(first.url),
    plays: Number.isInteger(plays) && plays > 0 ? plays : 0,
  };
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
  return {
    label: "Music",
    profileUrl: `https://www.last.fm/user/${user}`,
    profilePicture: LASTFM_PICTURE,
    summary: scrobbles ? `${scrobbles === 1 ? "1 scrobble" : `${scrobbles} scrobbles`} this week` : "",
    activity,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
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
    return {
      updatedAt: new Date(now).toISOString(),
      stale: false,
      recent: recent.tracks,
      scrobbles: recent.scrobbles,
      topTrack,
      topAlbum,
      topArtist,
    };
  },
  publish(env, value) {
    return toPublicLastfm(value, lastfmUser(env));
  },
};
