// worker/src/strava.ts
var RUN = /* @__PURE__ */ new Set(["Run", "TrailRun", "VirtualRun"]);
var RIDE = /* @__PURE__ */ new Set([
  "Ride",
  "VirtualRide",
  "GravelRide",
  "MountainBikeRide",
  "EBikeRide",
  "EMountainBikeRide",
  "Velomobile",
  "Handcycle"
]);
var SWIM = /* @__PURE__ */ new Set(["Swim"]);
var PUBLIC_SPORTS = /* @__PURE__ */ new Set(["Run", "Ride", "Swim", "Other"]);
function emptyFeed() {
  return { source: "empty", updatedAt: null, stale: false, activities: [] };
}
function mapSport(sportType, fallbackType) {
  const key = typeof sportType === "string" && sportType ? sportType : fallbackType;
  if (typeof key !== "string") return "Other";
  if (RUN.has(key)) return "Run";
  if (RIDE.has(key)) return "Ride";
  if (SWIM.has(key)) return "Swim";
  return "Other";
}
function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function finite(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}
function sanitizeActivity(raw) {
  if (!raw || typeof raw !== "object") return null;
  const row = raw;
  if (row.private === true) return null;
  const idNum = typeof row.id === "number" ? row.id : Number(row.id);
  const id = typeof row.id === "string" && /^i\d{1,20}$/.test(row.id) ? row.id : Number.isSafeInteger(idNum) && idNum > 0 ? String(idNum) : "";
  if (!id) return null;
  const distance = finite(row.distance);
  const moving = finite(row.moving_time);
  const elevation = finite(row.total_elevation_gain) ?? 0;
  const start = cleanText(row.start_date, 40) || cleanText(row.start_date_local, 40);
  if (distance === null || moving === null || !start) return null;
  const city = cleanText(row.location_city, 40);
  const region = cleanText(row.location_state, 40);
  return {
    id,
    name: cleanText(row.name, 80) || "Activity",
    sport: mapSport(row.sport_type, row.type),
    start,
    distanceM: Math.round(distance),
    movingS: Math.round(moving),
    elevationM: Math.round(elevation),
    location: [city, region].filter(Boolean).join(", "),
    url: `https://intervals.icu/activities/${id}`
  };
}
function sanitizeActivities(raw) {
  if (!Array.isArray(raw)) return [];
  const activities = [];
  for (const row of raw) {
    const activity = sanitizeActivity(row);
    if (activity) activities.push(activity);
  }
  activities.sort((a, b) => a.start < b.start ? 1 : a.start > b.start ? -1 : 0);
  return activities.slice(0, 30);
}
function publicActivity(raw) {
  if (!raw || typeof raw !== "object") return null;
  const row = raw;
  const id = typeof row.id === "string" ? row.id : "";
  if (!/^i?\d{1,20}$/.test(id)) return null;
  if (typeof row.sport !== "string" || !PUBLIC_SPORTS.has(row.sport)) return null;
  const distanceM = finite(row.distanceM);
  const movingS = finite(row.movingS);
  const elevationM = finite(row.elevationM);
  const start = cleanText(row.start, 40);
  const url = cleanText(row.url, 80);
  if (distanceM === null || movingS === null || elevationM === null || !start) return null;
  if (url !== `https://intervals.icu/activities/${id}`) return null;
  return {
    id,
    name: cleanText(row.name, 80) || "Activity",
    sport: row.sport,
    start,
    distanceM: Math.round(distanceM),
    movingS: Math.round(movingS),
    elevationM: Math.round(elevationM),
    location: cleanText(row.location, 80),
    url
  };
}
function toPublicFeed(value) {
  if (!value || typeof value !== "object") return emptyFeed();
  const row = value;
  const activities = [];
  if (Array.isArray(row.activities)) {
    for (const item of row.activities) {
      const activity = publicActivity(item);
      if (activity) activities.push(activity);
      if (activities.length === 30) break;
    }
  }
  return {
    source: row.source === "intervals" ? "intervals" : "empty",
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    stale: row.stale === true,
    activities
  };
}

// worker/src/index.ts
var FEED_KEY = "feed";
var SYNC_KEY = "sync";
var SYNC_BACKOFF_MS = 5 * 60 * 1e3;
var ATHLETE_URL = "https://intervals.icu/api/v1/athlete";
var DEFAULT_ORIGINS = "https://sradams.co.uk,https://www.sradams.co.uk";
function origins(env) {
  return (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(",").map((origin) => origin.trim()).filter(Boolean);
}
function cors(request, env) {
  const headers = new Headers();
  const origin = request.headers.get("Origin");
  if (origin && origins(env).includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
  }
  return headers;
}
function json(body, extra, status = 200) {
  const headers = extra ?? new Headers();
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("Cache-Control")) {
    const empty = typeof body === "object" && body !== null && body.source === "empty";
    headers.set("Cache-Control", empty ? "no-store" : "public, max-age=300");
  }
  return new Response(JSON.stringify(body), { status, headers });
}
function text(body, status, extra) {
  const headers = extra ?? new Headers();
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex");
  return new Response(body, { status, headers });
}
async function readFeed(env) {
  const raw = await env.FEED.get(FEED_KEY);
  if (!raw) return emptyFeed();
  try {
    return toPublicFeed(JSON.parse(raw));
  } catch {
    return emptyFeed();
  }
}
function apiKeyFrom(env) {
  let apiKey = (env.INTERVALS_API_KEY || "").trim();
  if (apiKey.startsWith('"') && apiKey.endsWith('"') || apiKey.startsWith("'") && apiKey.endsWith("'")) {
    apiKey = apiKey.slice(1, -1).trim();
  }
  if (/^API_KEY:/i.test(apiKey)) apiKey = apiKey.slice("API_KEY:".length).trim();
  if (apiKey.length < 8 || apiKey.length > 200) return null;
  if (/[^\x21-\x7e]/.test(apiKey)) return null;
  return apiKey;
}
function basic(apiKey) {
  return `Basic ${btoa(`API_KEY:${apiKey}`)}`;
}
function day(offset) {
  return new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
}
function athleteFrom(body) {
  if (!body || typeof body !== "object") return null;
  const row = body;
  const id = typeof row.id === "number" ? String(row.id) : typeof row.id === "string" ? row.id : "";
  if (!/^i?\d{1,20}$/.test(id)) return null;
  const named = typeof row.name === "string" ? row.name.trim() : "";
  const first = typeof row.firstname === "string" ? row.firstname.trim() : "";
  const last = typeof row.lastname === "string" ? row.lastname.trim() : "";
  const name = (named || [first, last].filter(Boolean).join(" ")).slice(0, 80);
  return { id, name: name || void 0 };
}
async function failureDetail(res) {
  try {
    const body = await res.json();
    const message = typeof body.message === "string" ? body.message.slice(0, 80) : "";
    return message;
  } catch {
    return "";
  }
}
async function noteSyncFailure(env, error) {
  const message = error instanceof Error ? error.message.slice(0, 180) : "refresh failed";
  await env.FEED.put(SYNC_KEY, JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), message }));
}
async function recentSyncFailure(env) {
  const raw = await env.FEED.get(SYNC_KEY);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    const at = typeof parsed.at === "string" ? Date.parse(parsed.at) : Number.NaN;
    return Number.isFinite(at) && Date.now() - at < SYNC_BACKOFF_MS;
  } catch {
    return false;
  }
}
async function resolveAccount(env, fetchImpl) {
  const apiKey = apiKeyFrom(env);
  if (!apiKey) throw new Error("Intervals.icu API key is not set");
  const res = await fetchImpl(ATHLETE_URL, { headers: { Authorization: basic(apiKey) } });
  if (!res.ok) {
    const detail = await failureDetail(res);
    throw new Error(detail ? `athlete failed (${res.status}) ${detail}` : `athlete failed (${res.status})`);
  }
  const athlete = athleteFrom(await res.json());
  if (!athlete) throw new Error("Intervals.icu did not return an athlete id");
  return { apiKey, athleteId: athlete.id, athleteName: athlete.name };
}
async function refreshFeed(env, fetchImpl = fetch, known) {
  try {
    const account = known?.apiKey ? known : await resolveAccount(env, fetchImpl);
    const url = `https://intervals.icu/api/v1/athlete/${account.athleteId}/activities?oldest=${day(-120)}&newest=${day(1)}`;
    const res = await fetchImpl(url, { headers: { Authorization: basic(account.apiKey) } });
    if (!res.ok) {
      const detail = await failureDetail(res);
      throw new Error(detail ? `activities failed (${res.status}) ${detail}` : `activities failed (${res.status})`);
    }
    const feed = {
      source: "intervals",
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      stale: false,
      activities: sanitizeActivities(await res.json())
    };
    await env.FEED.put(FEED_KEY, JSON.stringify(feed));
    await env.FEED.delete(SYNC_KEY);
    await env.FEED.delete("token");
    await env.FEED.delete("intervals");
    return feed;
  } catch (error) {
    await noteSyncFailure(env, error);
    const existing = await readFeed(env);
    if (existing.source === "intervals") {
      const stale = { ...existing, stale: true };
      await env.FEED.put(FEED_KEY, JSON.stringify(stale));
      return stale;
    }
    throw error;
  }
}
async function serveFeed(env, fetchImpl) {
  const raw = await env.FEED.get(FEED_KEY);
  if (raw) {
    try {
      return toPublicFeed(JSON.parse(raw));
    } catch {
      return emptyFeed();
    }
  }
  if (await recentSyncFailure(env)) return emptyFeed();
  if (!apiKeyFrom(env)) return emptyFeed();
  try {
    return await refreshFeed(env, fetchImpl);
  } catch {
    return emptyFeed();
  }
}
async function handleRequest(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "OPTIONS" && path === "/feed.json") {
    return new Response(null, { status: 204, headers: cors(request, env) });
  }
  if (path === "/feed.json" && request.method === "GET") {
    return json(await serveFeed(env, fetchImpl), cors(request, env));
  }
  if (path === "/" && request.method === "GET") {
    return Response.redirect(new URL("/feed.json", request.url), 302);
  }
  return text("Not found", 404);
}
var index_default = {
  fetch(request, env) {
    return handleRequest(request, env);
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil(
      refreshFeed(env).catch((error) => {
        console.error(error);
      })
    );
  }
};
export {
  index_default as default,
  handleRequest,
  refreshFeed
};
