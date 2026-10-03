// src/github.ts
var GITHUB_GRAPHQL = "https://api.github.com/graphql";
var WEEK_MS = 7 * 24 * 60 * 60 * 1e3;
var GITHUB_ACCOUNTS = [
  { login: "adamsuk", label: "Personal", envKey: "GITHUB_TOKEN_PERSONAL" },
  { login: "sra405", label: "Work", envKey: "GITHUB_TOKEN_WORK" }
];
var FIELDS = `
  contributionCalendar { totalContributions }
  totalCommitContributions
  totalPullRequestContributions
  totalPullRequestReviewContributions
  totalIssueContributions
  restrictedContributionsCount
`;
var USER_QUERY = `query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) { ${FIELDS} }
  }
}`;
var VIEWER_QUERY = `query($from: DateTime!, $to: DateTime!) {
  viewer {
    login
    contributionsCollection(from: $from, to: $to) { ${FIELDS} }
  }
}`;
function cleanToken(value) {
  let token = (value || "").trim();
  if (/^bearer\s+/i.test(token)) token = token.slice(token.indexOf(" ") + 1).trim();
  if (token.length < 20 || token.length > 300) return null;
  if (/[^\x21-\x7e]/.test(token)) return null;
  return token;
}
function weekRange(now = Date.now()) {
  return {
    from: new Date(now - WEEK_MS).toISOString(),
    to: new Date(now).toISOString()
  };
}
function count(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1e5) return 0;
  return value;
}
function accountFromCollection(login, label, collection) {
  const commits = count(collection?.totalCommitContributions);
  const pullRequests = count(collection?.totalPullRequestContributions);
  const reviews = count(collection?.totalPullRequestReviewContributions);
  const issues = count(collection?.totalIssueContributions);
  const restricted = count(collection?.restrictedContributionsCount);
  const calendar = count(collection?.contributionCalendar?.totalContributions);
  return {
    login,
    label,
    contributions: Math.max(calendar, commits + pullRequests + reviews + issues + restricted),
    commits,
    pullRequests,
    reviews,
    issues
  };
}
async function graphql(fetchImpl, token, query, variables) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "sradams-activity-feed"
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchImpl(GITHUB_GRAPHQL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error(`github failed (${res.status})`);
  return await res.json();
}
async function loadAccount(fetchImpl, account, token, range) {
  if (token) {
    const body2 = await graphql(fetchImpl, token, VIEWER_QUERY, range);
    const viewer = body2.data?.viewer;
    if (viewer?.login === account.login) {
      return accountFromCollection(account.login, account.label, viewer.contributionsCollection);
    }
  }
  const body = await graphql(fetchImpl, null, USER_QUERY, { login: account.login, ...range });
  const collection = body.data?.user?.contributionsCollection;
  if (!collection) throw new Error(`github failed for ${account.login}`);
  return accountFromCollection(account.login, account.label, collection);
}
async function loadGithubAccounts(env, fetchImpl, now = Date.now()) {
  const range = weekRange(now);
  const accounts = [];
  for (const account of GITHUB_ACCOUNTS) {
    const token = cleanToken(env[account.envKey]);
    accounts.push(await loadAccount(fetchImpl, account, token, range));
  }
  return accounts;
}
var KNOWN = new Map(GITHUB_ACCOUNTS.map((account) => [account.login, account.label]));
function toPublicGithub(value) {
  if (!value || typeof value !== "object") return null;
  const row = value;
  if (!Array.isArray(row.accounts)) return null;
  const accounts = [];
  for (const item of row.accounts) {
    if (!item || typeof item !== "object") continue;
    const account = item;
    const login = typeof account.login === "string" ? account.login : "";
    const label = KNOWN.get(login);
    if (!label) continue;
    accounts.push({
      login,
      label,
      contributions: count(account.contributions),
      commits: count(account.commits),
      pullRequests: count(account.pullRequests),
      reviews: count(account.reviews),
      issues: count(account.issues)
    });
  }
  if (accounts.length !== GITHUB_ACCOUNTS.length) return null;
  return {
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    stale: row.stale === true,
    accounts
  };
}

// src/strava.ts
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

// src/index.ts
var FEED_KEY = "feed";
var GITHUB_KEY = "github";
var SYNC_KEY = "sync";
var GITHUB_SYNC_KEY = "github-sync";
var SYNC_BACKOFF_MS = 5 * 60 * 1e3;
var DEFAULT_ORIGINS = "https://sradams.co.uk,https://www.sradams.co.uk";
var PAGES_HOST = "sradams-co-uk-content.pages.dev";
function origins(env) {
  return (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(",").map((origin) => origin.trim()).filter(Boolean);
}
function originAllowed(origin, env) {
  if (origins(env).includes(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && (url.hostname === PAGES_HOST || url.hostname.endsWith(`.${PAGES_HOST}`));
  } catch {
    return false;
  }
}
function cors(request, env) {
  const headers = new Headers();
  const origin = request.headers.get("Origin");
  if (origin && originAllowed(origin, env)) {
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
async function failureDetail(res) {
  try {
    const body = await res.json();
    const message = typeof body.message === "string" ? body.message.slice(0, 80) : "";
    return message;
  } catch {
    return "";
  }
}
async function noteSyncFailure(env, key, error) {
  const message = error instanceof Error ? error.message.slice(0, 180) : "refresh failed";
  await env.FEED.put(key, JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), message }));
}
async function recentFailure(env, key) {
  const raw = await env.FEED.get(key);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    const at = typeof parsed.at === "string" ? Date.parse(parsed.at) : Number.NaN;
    return Number.isFinite(at) && Date.now() - at < SYNC_BACKOFF_MS;
  } catch {
    return false;
  }
}
async function resolveAccount(env) {
  const apiKey = apiKeyFrom(env);
  if (!apiKey) throw new Error("Intervals.icu API key is not set");
  return { apiKey, athleteId: "0" };
}
async function refreshFeed(env, fetchImpl = fetch, known) {
  try {
    const account = known?.apiKey ? known : await resolveAccount(env);
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
    await noteSyncFailure(env, SYNC_KEY, error);
    const existing = await readFeed(env);
    if (existing.source === "intervals") {
      const stale = { ...existing, stale: true };
      await env.FEED.put(FEED_KEY, JSON.stringify(stale));
      return stale;
    }
    throw error;
  }
}
async function readGithub(env) {
  const raw = await env.FEED.get(GITHUB_KEY);
  if (!raw) return null;
  try {
    return toPublicGithub(JSON.parse(raw));
  } catch {
    return null;
  }
}
async function refreshGithub(env, fetchImpl = fetch, now = Date.now()) {
  try {
    const snapshot = {
      updatedAt: new Date(now).toISOString(),
      stale: false,
      accounts: await loadGithubAccounts(env, fetchImpl, now)
    };
    await env.FEED.put(GITHUB_KEY, JSON.stringify(snapshot));
    await env.FEED.delete(GITHUB_SYNC_KEY);
    return snapshot;
  } catch (error) {
    await noteSyncFailure(env, GITHUB_SYNC_KEY, error);
    const existing = await readGithub(env);
    if (existing) {
      const stale = { ...existing, stale: true };
      await env.FEED.put(GITHUB_KEY, JSON.stringify(stale));
      return stale;
    }
    throw error;
  }
}
async function serveGithub(env, fetchImpl) {
  const cached = await readGithub(env);
  if (cached) return cached;
  if (await recentFailure(env, GITHUB_SYNC_KEY)) return null;
  try {
    return await refreshGithub(env, fetchImpl);
  } catch {
    return null;
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
  if (await recentFailure(env, SYNC_KEY)) return emptyFeed();
  if (!apiKeyFrom(env)) return emptyFeed();
  try {
    const feed = await refreshFeed(env, fetchImpl);
    const github = await serveGithub(env, fetchImpl);
    return github ? { ...feed, github } : feed;
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
    const feed = await serveFeed(env, fetchImpl);
    const github = feed.github ?? await serveGithub(env, fetchImpl);
    return json(github ? { ...feed, github } : feed, cors(request, env));
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
      Promise.all([
        refreshFeed(env).catch((error) => {
          console.error(error);
        }),
        refreshGithub(env).catch((error) => {
          console.error(error);
        })
      ])
    );
  }
};
export {
  index_default as default,
  handleRequest,
  refreshFeed,
  refreshGithub
};
