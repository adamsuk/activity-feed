// src/accounts.ts
function cleanLabel(value, fallback) {
  if (typeof value !== "string") return fallback;
  const label = value.replace(/[\u0000-\u001F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return label || fallback;
}
function accountsFromEnv(raw) {
  if (!raw?.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = /* @__PURE__ */ new Set();
  const accounts = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const row = item;
    const id = typeof row.id === "string" ? row.id.trim().toLowerCase() : "";
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(id) || seen.has(id)) continue;
    const login = typeof row.login === "string" ? row.login.trim() : "";
    if (login && !/^[A-Za-z0-9-]{1,39}$/.test(login)) continue;
    seen.add(id);
    accounts.push({ id, label: cleanLabel(row.label, id), login });
    if (accounts.length === 10) break;
  }
  return accounts;
}
function secretName(prefix, id) {
  return `${prefix}_${id.toUpperCase().replace(/-/g, "_")}`;
}
function binding(env, name) {
  const value = env[name];
  return typeof value === "string" ? value : void 0;
}

// src/github.ts
var GITHUB_GRAPHQL = "https://api.github.com/graphql";
var WEEK_MS = 7 * 24 * 60 * 60 * 1e3;
function githubAccounts(env) {
  return accountsFromEnv(env.GITHUB_ACCOUNTS).filter((account) => account.login);
}
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
  for (const account of githubAccounts(env)) {
    const token = cleanToken(binding(env, secretName("GITHUB_TOKEN", account.id)));
    accounts.push(await loadAccount(fetchImpl, account, token, range));
  }
  return accounts;
}
function toPublicGithub(value, allowed) {
  if (allowed.length === 0 || !value || typeof value !== "object") return null;
  const row = value;
  if (!Array.isArray(row.accounts)) return null;
  const byLogin = /* @__PURE__ */ new Map();
  for (const item of row.accounts) {
    if (!item || typeof item !== "object") continue;
    const account = item;
    if (typeof account.login === "string") byLogin.set(account.login, account);
  }
  const accounts = [];
  for (const account of allowed) {
    const found = byLogin.get(account.login);
    if (!found) return null;
    accounts.push({
      login: account.login,
      label: account.label,
      contributions: count(found.contributions),
      commits: count(found.commits),
      pullRequests: count(found.pullRequests),
      reviews: count(found.reviews),
      issues: count(found.issues)
    });
  }
  return {
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    stale: row.stale === true,
    accounts
  };
}
var githubProvider = {
  id: "github",
  enabled(env) {
    return githubAccounts(env).length > 0;
  },
  async load(env, fetchImpl, now = Date.now()) {
    return {
      updatedAt: new Date(now).toISOString(),
      stale: false,
      accounts: await loadGithubAccounts(env, fetchImpl, now)
    };
  },
  publish(env, value) {
    return toPublicGithub(value, githubAccounts(env));
  }
};

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
  const account = cleanText(row.account, 40);
  return {
    id,
    name: cleanText(row.name, 80) || "Activity",
    sport: row.sport,
    start,
    distanceM: Math.round(distanceM),
    movingS: Math.round(movingS),
    elevationM: Math.round(elevationM),
    location: cleanText(row.location, 80),
    url,
    ...account ? { account } : {}
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

// src/intervals.ts
function cleanApiKey(value) {
  let apiKey = (value || "").trim();
  if (apiKey.startsWith('"') && apiKey.endsWith('"') || apiKey.startsWith("'") && apiKey.endsWith("'")) {
    apiKey = apiKey.slice(1, -1).trim();
  }
  if (/^API_KEY:/i.test(apiKey)) apiKey = apiKey.slice("API_KEY:".length).trim();
  if (apiKey.length < 8 || apiKey.length > 200) return null;
  if (/[^\x21-\x7e]/.test(apiKey)) return null;
  return apiKey;
}
function configured(env) {
  const listed = accountsFromEnv(env.INTERVALS_ACCOUNTS);
  if (listed.length === 0) {
    const apiKey = cleanApiKey(env.INTERVALS_API_KEY);
    return apiKey ? [{ id: "personal", label: "", apiKey, athleteId: "0" }] : [];
  }
  return listed.map((account) => {
    const named = cleanApiKey(binding(env, secretName("INTERVALS_API_KEY", account.id)));
    const apiKey = named || (account.id === "personal" ? cleanApiKey(env.INTERVALS_API_KEY) : null);
    if (!apiKey) throw new Error(`Intervals key is not set for ${account.id}`);
    return { id: account.id, label: account.label, apiKey, athleteId: "0" };
  });
}
function day(offset) {
  return new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
}
async function failureDetail(res) {
  try {
    const body = await res.json();
    return typeof body.message === "string" ? body.message.slice(0, 80) : "";
  } catch {
    return "";
  }
}
async function pull(account, fetchImpl) {
  const url = `https://intervals.icu/api/v1/athlete/${account.athleteId}/activities?oldest=${day(-120)}&newest=${day(1)}`;
  const res = await fetchImpl(url, { headers: { Authorization: `Basic ${btoa(`API_KEY:${account.apiKey}`)}` } });
  if (!res.ok) {
    const detail = await failureDetail(res);
    throw new Error(detail ? `activities failed (${res.status}) ${detail}` : `activities failed (${res.status})`);
  }
  const activities = sanitizeActivities(await res.json());
  if (!account.label) return activities;
  return activities.map((activity) => ({ ...activity, account: account.label }));
}
var intervalsProvider = {
  id: "intervals",
  root: true,
  enabled(env) {
    return Boolean(env.INTERVALS_ACCOUNTS?.trim() || cleanApiKey(env.INTERVALS_API_KEY));
  },
  async load(env, fetchImpl) {
    const accounts = configured(env);
    if (accounts.length === 0) throw new Error("Intervals.icu API key is not set");
    const showLabel = accounts.length > 1;
    const activities = [];
    for (const account of accounts) {
      const rows = await pull(showLabel ? account : { ...account, label: "" }, fetchImpl);
      activities.push(...rows);
    }
    activities.sort((left, right) => left.start < right.start ? 1 : left.start > right.start ? -1 : 0);
    return {
      source: "intervals",
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      stale: false,
      activities: activities.slice(0, 30)
    };
  },
  publish(_env, value) {
    const feed = toPublicFeed(value);
    return feed.source === "intervals" ? feed : null;
  }
};

// src/providers.ts
var providers = [intervalsProvider, githubProvider];

// src/index.ts
var SYNC_BACKOFF_MS = 5 * 60 * 1e3;
var DEFAULT_ORIGINS = "https://sradams.co.uk,https://www.sradams.co.uk";
var PAGES_HOST = "sradams-co-uk-content.pages.dev";
var ROOT_FIELDS = /* @__PURE__ */ new Set(["source", "updatedAt", "stale", "activities"]);
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
    const record = body;
    const onlyRoot = Object.keys(record).every((key) => ROOT_FIELDS.has(key));
    headers.set("Cache-Control", record.source === "empty" && onlyRoot ? "no-store" : "public, max-age=300");
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
function syncKey(provider) {
  return `${provider.id}:sync`;
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
async function readSection(env, provider) {
  const raw = await env.FEED.get(provider.id);
  if (!raw) return null;
  try {
    return provider.publish(env, JSON.parse(raw));
  } catch {
    return null;
  }
}
async function refresh(env, provider, fetchImpl = fetch, now = Date.now()) {
  if (!provider.enabled(env)) {
    await env.FEED.delete(provider.id);
    return null;
  }
  try {
    const section = await provider.load(env, fetchImpl, now);
    await env.FEED.put(provider.id, JSON.stringify(section));
    await env.FEED.delete(syncKey(provider));
    return section;
  } catch (error) {
    await noteSyncFailure(env, syncKey(provider), error);
    const existing = await readSection(env, provider);
    if (!existing) throw error;
    const stale = { ...existing, stale: true };
    await env.FEED.put(provider.id, JSON.stringify(stale));
    return stale;
  }
}
async function serveProvider(env, provider, fetchImpl) {
  if (!provider.enabled(env)) return null;
  const cached = await readSection(env, provider);
  if (cached) return cached;
  if (await recentFailure(env, syncKey(provider))) return null;
  try {
    return await refresh(env, provider, fetchImpl);
  } catch {
    return null;
  }
}
async function serveFeed(env, fetchImpl) {
  const body = {};
  let rooted = false;
  for (const provider of providers) {
    const section = await serveProvider(env, provider, fetchImpl);
    if (!section) continue;
    if (provider.root) {
      Object.assign(body, section);
      rooted = true;
    } else {
      body[provider.id] = section;
    }
  }
  if (!rooted) Object.assign(body, emptyFeed());
  return body;
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
    const enabled = providers.filter((provider) => provider.enabled(env));
    ctx.waitUntil(
      Promise.all(enabled.map((provider) => refresh(env, provider).catch((error) => {
        console.error(error);
      })))
    );
  }
};
export {
  index_default as default,
  handleRequest,
  refresh
};
