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
var ACCOUNT_KEY = "intervals";
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
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "public, max-age=300");
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
function accountFrom(value) {
  if (!value || typeof value !== "object") return null;
  const row = value;
  const apiKey = typeof row.apiKey === "string" ? row.apiKey : "";
  const athleteId = typeof row.athleteId === "string" ? row.athleteId : "";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(apiKey)) return null;
  if (!/^i?\d{1,20}$/.test(athleteId)) return null;
  const athleteName = typeof row.athleteName === "string" ? row.athleteName.slice(0, 80) : void 0;
  return { apiKey, athleteId, athleteName };
}
async function readAccount(env) {
  const raw = await env.FEED.get(ACCOUNT_KEY);
  if (!raw) return null;
  try {
    return accountFrom(JSON.parse(raw));
  } catch {
    return null;
  }
}
async function saveAccount(env, account) {
  await env.FEED.put(ACCOUNT_KEY, JSON.stringify(account));
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
async function refreshFeed(env, fetchImpl = fetch, known) {
  try {
    const account = known?.apiKey ? known : await readAccount(env);
    if (!account) throw new Error("Intervals.icu is not connected");
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
  const account = await readAccount(env);
  if (!account) return emptyFeed();
  try {
    return await refreshFeed(env, fetchImpl, account);
  } catch {
    return emptyFeed();
  }
}
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function page(body) {
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Activity feed</title>
<style>
  body { font: 16px/1.5 Georgia, serif; margin: 0; background: #f6f1e7; color: #1c1915; }
  main { max-width: 28rem; margin: 0 auto; padding: 3rem 1.25rem; }
  a, button, input { font: inherit; }
  button, .login { display: inline-flex; align-items: center; min-height: 2.75rem; margin-top: 1rem; padding: 0 1rem; border-radius: 999px; background: #1c1915; color: #f6f1e7; text-decoration: none; border: 0; }
  input { display: block; width: 100%; box-sizing: border-box; margin-top: 0.35rem; padding: 0.6rem 0.75rem; border: 1px solid #d9d0c1; border-radius: 0.75rem; background: #fffdf8; }
  label { display: block; margin-top: 1rem; }
  p.note { color: #5c564c; }
</style>
<main>
${body}
</main>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex"
    }
  });
}
function keyForm() {
  return `<form method="post" action="/connect">
<label>Intervals.icu API key
<input name="apiKey" type="password" autocomplete="off" required>
</label>
<button type="submit">Save key</button>
</form>
<p class="note">In Intervals.icu: Settings, Developer, create a key. Garmin should be the connected source, not Strava. The key stays on this worker.</p>`;
}
async function syncHint(env) {
  const raw = await env.FEED.get(SYNC_KEY);
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed.message === "string" && parsed.message ? "The activity pull failed. It will retry shortly." : "";
  } catch {
    return "";
  }
}
async function statusPage(request, env) {
  const error = new URL(request.url).searchParams.get("error");
  const replace = new URL(request.url).searchParams.get("replace");
  const account = await readAccount(env);
  const feed = await readFeed(env);
  const hint = await syncHint(env);
  const problem = error === "key" ? "Intervals.icu did not accept that key." : error === "refresh" ? "The cache refresh failed. It will retry shortly." : hint;
  if (!account || replace) {
    return page(`<h1>${account ? "Replace key" : "Connect Intervals.icu"}</h1>
<p class="note">This page is for you. The homepage only reads the public feed.</p>
${problem ? `<p>${escapeHtml(problem)}</p>` : ""}
${keyForm()}`);
  }
  const who = account.athleteName ? escapeHtml(account.athleteName) : "your account";
  const when = feed.updatedAt ? escapeHtml(feed.updatedAt) : "not yet";
  return page(`<h1>Connected</h1>
<p>Signed in as ${who}. ${feed.activities.length} activities cached${feed.stale ? ", last refresh failed" : ""}. Updated ${when}.</p>
${problem ? `<p>${escapeHtml(problem)}</p>` : ""}
<form method="post" action="/refresh"><button type="submit">Refresh now</button></form>
<p><a href="/?replace=1">Replace key</a></p>`);
}
async function connect(request, env, fetchImpl) {
  const form = await request.formData();
  const apiKey = String(form.get("apiKey") ?? "").trim();
  const home = new URL("/", request.url);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(apiKey)) {
    home.searchParams.set("error", "key");
    return Response.redirect(home, 303);
  }
  const res = await fetchImpl(ATHLETE_URL, { headers: { Authorization: basic(apiKey) } });
  const athlete = res.ok ? athleteFrom(await res.json()) : null;
  if (!athlete) {
    home.searchParams.set("error", "key");
    return Response.redirect(home, 303);
  }
  const account = { apiKey, athleteId: athlete.id, athleteName: athlete.name };
  await saveAccount(env, account);
  await env.FEED.delete("token");
  try {
    await refreshFeed(env, fetchImpl, account);
  } catch {
    home.searchParams.set("error", "refresh");
  }
  home.searchParams.set("connected", "1");
  return Response.redirect(home, 303);
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
  if (path === "/" && request.method === "GET") return statusPage(request, env);
  if (path === "/connect" && request.method === "POST") return connect(request, env, fetchImpl);
  if (path === "/refresh" && request.method === "POST") {
    try {
      await refreshFeed(env, fetchImpl);
      return Response.redirect(new URL("/", request.url), 303);
    } catch {
      const home = new URL("/", request.url);
      home.searchParams.set("error", "refresh");
      return Response.redirect(home, 303);
    }
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
