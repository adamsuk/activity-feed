import { accountsFromEnv, binding, secretName } from "./accounts.ts";
import { githubAccounts, loadGithubAccounts, toPublicGithub } from "./github.ts";
import { emptyFeed, sanitizeActivities, toPublicFeed } from "./strava.ts";
import type { CachedActivity, Env, Feed, GithubSnapshot, IntervalsAccount } from "./types.ts";

const FEED_KEY = "feed";
const GITHUB_KEY = "github";
const SYNC_KEY = "sync";
const GITHUB_SYNC_KEY = "github-sync";
const SYNC_BACKOFF_MS = 5 * 60 * 1000;
const DEFAULT_ORIGINS = "https://sradams.co.uk,https://www.sradams.co.uk";
const PAGES_HOST = "sradams-co-uk-content.pages.dev";

type FetchImpl = typeof fetch;

function origins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function originAllowed(origin: string, env: Env): boolean {
  if (origins(env).includes(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && (
      url.hostname === PAGES_HOST || url.hostname.endsWith(`.${PAGES_HOST}`)
    );
  } catch {
    return false;
  }
}

function cors(request: Request, env: Env): Headers {
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

function json(body: unknown, extra?: Headers, status = 200): Response {
  const headers = extra ?? new Headers();
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("Cache-Control")) {
    const empty = typeof body === "object" && body !== null && (body as { source?: string }).source === "empty";
    headers.set("Cache-Control", empty ? "no-store" : "public, max-age=300");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function text(body: string, status: number, extra?: Headers): Response {
  const headers = extra ?? new Headers();
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex");
  return new Response(body, { status, headers });
}

async function readFeed(env: Env): Promise<Feed> {
  const raw = await env.FEED.get(FEED_KEY);
  if (!raw) return emptyFeed();
  try {
    return toPublicFeed(JSON.parse(raw));
  } catch {
    return emptyFeed();
  }
}

function cleanApiKey(value: string | undefined): string | null {
  let apiKey = (value || "").trim();
  if (
    (apiKey.startsWith('"') && apiKey.endsWith('"')) ||
    (apiKey.startsWith("'") && apiKey.endsWith("'"))
  ) {
    apiKey = apiKey.slice(1, -1).trim();
  }
  if (/^API_KEY:/i.test(apiKey)) apiKey = apiKey.slice("API_KEY:".length).trim();
  if (apiKey.length < 8 || apiKey.length > 200) return null;
  if (/[^\x21-\x7e]/.test(apiKey)) return null;
  return apiKey;
}

type ResolvedIntervals = {
  id: string;
  label: string;
  apiKey: string;
  athleteId: string;
};

function configuredIntervals(env: Env): ResolvedIntervals[] {
  const listed = accountsFromEnv(env.INTERVALS_ACCOUNTS);
  if (listed.length === 0) {
    const apiKey = cleanApiKey(env.INTERVALS_API_KEY);
    return apiKey ? [{ id: "personal", label: "", apiKey, athleteId: "0" }] : [];
  }
  const resolved: ResolvedIntervals[] = [];
  for (const account of listed) {
    const named = cleanApiKey(binding(env, secretName("INTERVALS_API_KEY", account.id)));
    const apiKey = named || (account.id === "personal" ? cleanApiKey(env.INTERVALS_API_KEY) : null);
    if (!apiKey) throw new Error(`Intervals key is not set for ${account.id}`);
    resolved.push({ id: account.id, label: account.label, apiKey, athleteId: "0" });
  }
  return resolved;
}

function basic(apiKey: string): string {
  return `Basic ${btoa(`API_KEY:${apiKey}`)}`;
}

function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

async function failureDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    const message = typeof body.message === "string" ? body.message.slice(0, 80) : "";
    return message;
  } catch {
    return "";
  }
}

async function noteSyncFailure(env: Env, key: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 180) : "refresh failed";
  await env.FEED.put(key, JSON.stringify({ at: new Date().toISOString(), message }));
}

async function recentFailure(env: Env, key: string): Promise<boolean> {
  const raw = await env.FEED.get(key);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { at?: string };
    const at = typeof parsed.at === "string" ? Date.parse(parsed.at) : Number.NaN;
    return Number.isFinite(at) && Date.now() - at < SYNC_BACKOFF_MS;
  } catch {
    return false;
  }
}

async function pullActivities(
  account: ResolvedIntervals,
  fetchImpl: FetchImpl,
): Promise<CachedActivity[]> {
  const url = `https://intervals.icu/api/v1/athlete/${account.athleteId}/activities?oldest=${day(-120)}&newest=${day(1)}`;
  const res = await fetchImpl(url, { headers: { Authorization: basic(account.apiKey) } });
  if (!res.ok) {
    const detail = await failureDetail(res);
    throw new Error(detail ? `activities failed (${res.status}) ${detail}` : `activities failed (${res.status})`);
  }
  const activities = sanitizeActivities(await res.json());
  if (!account.label) return activities;
  return activities.map((activity) => ({ ...activity, account: account.label }));
}

export async function refreshFeed(
  env: Env,
  fetchImpl: FetchImpl = fetch,
  known?: IntervalsAccount | null,
): Promise<Feed> {
  try {
    const accounts: ResolvedIntervals[] = known?.apiKey
      ? [{ id: "personal", label: "", apiKey: known.apiKey, athleteId: known.athleteId || "0" }]
      : configuredIntervals(env);
    if (accounts.length === 0) throw new Error("Intervals.icu API key is not set");
    const showLabel = accounts.length > 1;
    const activities: CachedActivity[] = [];
    for (const account of accounts) {
      const rows = await pullActivities(
        showLabel ? account : { ...account, label: "" },
        fetchImpl,
      );
      activities.push(...rows);
    }
    activities.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0));
    const feed: Feed = {
      source: "intervals",
      updatedAt: new Date().toISOString(),
      stale: false,
      activities: activities.slice(0, 30),
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
      const stale: Feed = { ...existing, stale: true };
      await env.FEED.put(FEED_KEY, JSON.stringify(stale));
      return stale;
    }
    throw error;
  }
}

async function readGithub(env: Env): Promise<GithubSnapshot | null> {
  const raw = await env.FEED.get(GITHUB_KEY);
  if (!raw) return null;
  try {
    return toPublicGithub(JSON.parse(raw), githubAccounts(env));
  } catch {
    return null;
  }
}

export async function refreshGithub(
  env: Env,
  fetchImpl: FetchImpl = fetch,
  now = Date.now(),
): Promise<GithubSnapshot> {
  if (githubAccounts(env).length === 0) {
    await env.FEED.delete(GITHUB_KEY);
    return { updatedAt: null, stale: false, accounts: [] };
  }
  try {
    const snapshot: GithubSnapshot = {
      updatedAt: new Date(now).toISOString(),
      stale: false,
      accounts: await loadGithubAccounts(env, fetchImpl, now),
    };
    await env.FEED.put(GITHUB_KEY, JSON.stringify(snapshot));
    await env.FEED.delete(GITHUB_SYNC_KEY);
    return snapshot;
  } catch (error) {
    await noteSyncFailure(env, GITHUB_SYNC_KEY, error);
    const existing = await readGithub(env);
    if (existing) {
      const stale: GithubSnapshot = { ...existing, stale: true };
      await env.FEED.put(GITHUB_KEY, JSON.stringify(stale));
      return stale;
    }
    throw error;
  }
}

async function serveGithub(env: Env, fetchImpl: FetchImpl): Promise<GithubSnapshot | null> {
  if (githubAccounts(env).length === 0) return null;
  const cached = await readGithub(env);
  if (cached) return cached;
  if (await recentFailure(env, GITHUB_SYNC_KEY)) return null;
  try {
    return await refreshGithub(env, fetchImpl);
  } catch {
    return null;
  }
}

async function serveFeed(env: Env, fetchImpl: FetchImpl): Promise<Feed & { github?: GithubSnapshot }> {
  const raw = await env.FEED.get(FEED_KEY);
  if (raw) {
    try {
      return toPublicFeed(JSON.parse(raw));
    } catch {
      return emptyFeed();
    }
  }
  if (await recentFailure(env, SYNC_KEY)) return emptyFeed();
  let ready = false;
  try {
    ready = configuredIntervals(env).length > 0;
  } catch (error) {
    await noteSyncFailure(env, SYNC_KEY, error);
    return emptyFeed();
  }
  if (!ready) return emptyFeed();
  try {
    const feed = await refreshFeed(env, fetchImpl);
    const github = await serveGithub(env, fetchImpl);
    return github ? { ...feed, github } : feed;
  } catch {
    return emptyFeed();
  }
}

export async function handleRequest(
  request: Request,
  env: Env,
  fetchImpl: FetchImpl = fetch,
): Promise<Response> {
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

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
  scheduled(_event: unknown, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): void {
    ctx.waitUntil(
      Promise.all([
        refreshFeed(env).catch((error: unknown) => {
          console.error(error);
        }),
        refreshGithub(env).catch((error: unknown) => {
          console.error(error);
        }),
      ]),
    );
  },
};
