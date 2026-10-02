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
  if (!Number.isSafeInteger(idNum) || idNum <= 0) return null;
  const distance = finite(row.distance);
  const moving = finite(row.moving_time);
  const elevation = finite(row.total_elevation_gain);
  const start = cleanText(row.start_date, 40);
  if (distance === null || moving === null || elevation === null || !start) return null;
  const city = cleanText(row.location_city, 40);
  const region = cleanText(row.location_state, 40);
  return {
    id: String(idNum),
    name: cleanText(row.name, 80) || "Activity",
    sport: mapSport(row.sport_type, row.type),
    start,
    distanceM: Math.round(distance),
    movingS: Math.round(moving),
    elevationM: Math.round(elevation),
    location: [city, region].filter(Boolean).join(", "),
    stravaUrl: `https://www.strava.com/activities/${idNum}`
  };
}
function sanitizeActivities(raw) {
  if (!Array.isArray(raw)) return [];
  const activities = [];
  for (const row of raw) {
    const activity = sanitizeActivity(row);
    if (activity) activities.push(activity);
    if (activities.length === 30) break;
  }
  return activities;
}
function publicActivity(raw) {
  if (!raw || typeof raw !== "object") return null;
  const row = raw;
  const id = typeof row.id === "string" ? row.id : "";
  if (!/^\d{1,20}$/.test(id)) return null;
  if (typeof row.sport !== "string" || !PUBLIC_SPORTS.has(row.sport)) return null;
  const distanceM = finite(row.distanceM);
  const movingS = finite(row.movingS);
  const elevationM = finite(row.elevationM);
  const start = cleanText(row.start, 40);
  const stravaUrl = cleanText(row.stravaUrl, 80);
  if (distanceM === null || movingS === null || elevationM === null || !start) return null;
  if (!stravaUrl.startsWith(`https://www.strava.com/activities/${id}`)) return null;
  return {
    id,
    name: cleanText(row.name, 80) || "Activity",
    sport: row.sport,
    start,
    distanceM: Math.round(distanceM),
    movingS: Math.round(movingS),
    elevationM: Math.round(elevationM),
    location: cleanText(row.location, 80),
    stravaUrl
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
    source: row.source === "strava" ? "strava" : "empty",
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    stale: row.stale === true,
    activities
  };
}

// worker/src/index.ts
var FEED_KEY = "feed";
var TOKEN_KEY = "token";
var TOKEN_URL = "https://www.strava.com/oauth/token";
var ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities?per_page=30";
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
function readCookie(request, name) {
  const raw = request.headers.get("Cookie") ?? "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
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
async function readToken(env) {
  const raw = await env.FEED.get(TOKEN_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.accessToken || !parsed.refreshToken || !parsed.expiresAt) return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      athleteName: typeof parsed.athleteName === "string" ? parsed.athleteName : void 0
    };
  } catch {
    return null;
  }
}
async function saveToken(env, record) {
  await env.FEED.put(TOKEN_KEY, JSON.stringify(record));
}
function tokenFromJson(body, nowSec) {
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
  const expiresAt = typeof body.expires_at === "number" ? body.expires_at : typeof body.expires_in === "number" ? nowSec + body.expires_in : 0;
  if (!accessToken || !refreshToken || !expiresAt) return null;
  const athlete = body.athlete;
  let athleteName;
  if (athlete && typeof athlete === "object") {
    const row = athlete;
    const first = typeof row.firstname === "string" ? row.firstname.trim() : "";
    const last = typeof row.lastname === "string" ? row.lastname.trim() : "";
    const name = [first, last].filter(Boolean).join(" ").slice(0, 80);
    if (name) athleteName = name;
  }
  return { accessToken, refreshToken, expiresAt, athleteName };
}
async function ensureAccess(env, fetchImpl) {
  const now = Math.floor(Date.now() / 1e3);
  const stored = await readToken(env);
  if (stored && stored.expiresAt > now + 120) return stored.accessToken;
  const refreshToken = stored?.refreshToken || env.STRAVA_REFRESH_TOKEN;
  if (!refreshToken || !env.STRAVA_CLIENT_ID || !env.STRAVA_CLIENT_SECRET) {
    throw new Error("Strava is not connected");
  }
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    })
  });
  if (!res.ok) throw new Error(`token refresh failed (${res.status})`);
  const next = tokenFromJson(await res.json(), now);
  if (!next) throw new Error("token refresh returned no token");
  if (!next.athleteName && stored?.athleteName) next.athleteName = stored.athleteName;
  await saveToken(env, next);
  return next.accessToken;
}
async function refreshFeed(env, fetchImpl = fetch) {
  try {
    const access = await ensureAccess(env, fetchImpl);
    const res = await fetchImpl(ACTIVITIES_URL, {
      headers: { Authorization: `Bearer ${access}` }
    });
    if (!res.ok) throw new Error(`activities failed (${res.status})`);
    const feed = {
      source: "strava",
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      stale: false,
      activities: sanitizeActivities(await res.json())
    };
    await env.FEED.put(FEED_KEY, JSON.stringify(feed));
    return feed;
  } catch (error) {
    const existing = await readFeed(env);
    if (existing.source === "strava") {
      const stale = { ...existing, stale: true };
      await env.FEED.put(FEED_KEY, JSON.stringify(stale));
      return stale;
    }
    throw error;
  }
}
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function page(body) {
  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Strava feed</title>
<style>
  body { font: 16px/1.5 Georgia, serif; margin: 0; background: #f6f1e7; color: #1c1915; }
  main { max-width: 28rem; margin: 0 auto; padding: 3rem 1.25rem; }
  a, button { font: inherit; }
  button, .login { display: inline-flex; align-items: center; min-height: 2.75rem; margin-top: 1rem; padding: 0 1rem; border-radius: 999px; background: #1c1915; color: #f6f1e7; text-decoration: none; border: 0; }
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
async function statusPage(request, env) {
  const error = new URL(request.url).searchParams.get("error");
  const token = await readToken(env);
  const feed = await readFeed(env);
  const problem = error === "declined" ? "Strava authorisation was declined." : error === "state" ? "That login expired. Try again." : error === "token" ? "Strava did not accept that login." : error === "refresh" ? "The cache refresh failed. The cron will retry." : "";
  if (!token) {
    return page(`<h1>Connect Strava</h1>
<p class="note">This page is for you. The homepage only reads the public feed.</p>
${problem ? `<p>${escapeHtml(problem)}</p>` : ""}
<p><a class="login" href="/oauth/start">Log in with Strava</a></p>`);
  }
  const who = token.athleteName ? escapeHtml(token.athleteName) : "your account";
  const when = feed.updatedAt ? escapeHtml(feed.updatedAt) : "not yet";
  return page(`<h1>Connected</h1>
<p>Signed in as ${who}. ${feed.activities.length} activities cached${feed.stale ? ", last refresh failed" : ""}. Updated ${when}.</p>
${problem ? `<p>${escapeHtml(problem)}</p>` : ""}
<form method="post" action="/refresh"><button type="submit">Refresh now</button></form>
<p><a href="/oauth/start">Log in again</a></p>`);
}
async function startOauth(request, env) {
  if (!env.STRAVA_CLIENT_ID || !env.STRAVA_CLIENT_SECRET) return text("Strava client id and secret are not set", 500);
  const state = crypto.randomUUID();
  await env.FEED.put(`oauth:${state}`, "1", { expirationTtl: 600 });
  const redirectUri = new URL("/oauth/callback", request.url).toString();
  const params = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    approval_prompt: "auto",
    scope: "activity:read",
    state
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://www.strava.com/oauth/authorize?${params}`,
      "Cache-Control": "no-store",
      "Set-Cookie": `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/oauth; Max-Age=600`
    }
  });
}
async function finishOauth(request, env, fetchImpl) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const cookie = readCookie(request, "oauth_state");
  const pending = state ? await env.FEED.get(`oauth:${state}`) : null;
  if (pending) await env.FEED.delete(`oauth:${state}`);
  const home = new URL("/", request.url);
  if (url.searchParams.get("error")) {
    home.searchParams.set("error", "declined");
    return Response.redirect(home, 302);
  }
  if (!code || !pending || cookie !== state) {
    home.searchParams.set("error", "state");
    return Response.redirect(home, 302);
  }
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code"
    })
  });
  const record = res.ok ? tokenFromJson(await res.json(), Math.floor(Date.now() / 1e3)) : null;
  if (!record) {
    home.searchParams.set("error", "token");
    return Response.redirect(home, 302);
  }
  await saveToken(env, record);
  try {
    await refreshFeed(env, fetchImpl);
  } catch {
    home.searchParams.set("error", "refresh");
  }
  home.searchParams.set("connected", "1");
  return Response.redirect(home, 302);
}
async function handleRequest(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "OPTIONS" && path === "/feed.json") {
    return new Response(null, { status: 204, headers: cors(request, env) });
  }
  if (path === "/feed.json" && request.method === "GET") {
    return json(await readFeed(env), cors(request, env));
  }
  if (path === "/" && request.method === "GET") return statusPage(request, env);
  if (path === "/oauth/start" && request.method === "GET") return startOauth(request, env);
  if (path === "/oauth/callback" && request.method === "GET") {
    return finishOauth(request, env, fetchImpl);
  }
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
