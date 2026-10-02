import { emptyFeed, sanitizeActivities, toPublicFeed } from "./strava.ts";
import type { Env, Feed, IntervalsAccount } from "./types.ts";

const FEED_KEY = "feed";
const SYNC_KEY = "sync";
const SYNC_BACKOFF_MS = 5 * 60 * 1000;
const ATHLETE_URL = "https://intervals.icu/api/v1/athlete";
const DEFAULT_ORIGINS = "https://sradams.co.uk,https://www.sradams.co.uk";

type FetchImpl = typeof fetch;

function origins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function cors(request: Request, env: Env): Headers {
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

function json(body: unknown, extra?: Headers, status = 200): Response {
  const headers = extra ?? new Headers();
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "public, max-age=300");
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

function apiKeyFrom(env: Env): string | null {
  const apiKey = (env.INTERVALS_API_KEY || "").trim();
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(apiKey)) return null;
  return apiKey;
}

function basic(apiKey: string): string {
  return `Basic ${btoa(`API_KEY:${apiKey}`)}`;
}

function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

function athleteFrom(body: unknown): { id: string; name?: string } | null {
  if (!body || typeof body !== "object") return null;
  const row = body as Record<string, unknown>;
  const id = typeof row.id === "number" ? String(row.id) : typeof row.id === "string" ? row.id : "";
  if (!/^i?\d{1,20}$/.test(id)) return null;
  const named = typeof row.name === "string" ? row.name.trim() : "";
  const first = typeof row.firstname === "string" ? row.firstname.trim() : "";
  const last = typeof row.lastname === "string" ? row.lastname.trim() : "";
  const name = (named || [first, last].filter(Boolean).join(" ")).slice(0, 80);
  return { id, name: name || undefined };
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

async function noteSyncFailure(env: Env, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 180) : "refresh failed";
  await env.FEED.put(SYNC_KEY, JSON.stringify({ at: new Date().toISOString(), message }));
}

async function recentSyncFailure(env: Env): Promise<boolean> {
  const raw = await env.FEED.get(SYNC_KEY);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { at?: string };
    const at = typeof parsed.at === "string" ? Date.parse(parsed.at) : Number.NaN;
    return Number.isFinite(at) && Date.now() - at < SYNC_BACKOFF_MS;
  } catch {
    return false;
  }
}

async function resolveAccount(env: Env, fetchImpl: FetchImpl): Promise<IntervalsAccount> {
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

export async function refreshFeed(
  env: Env,
  fetchImpl: FetchImpl = fetch,
  known?: IntervalsAccount | null,
): Promise<Feed> {
  try {
    const account = known?.apiKey ? known : await resolveAccount(env, fetchImpl);
    const url = `https://intervals.icu/api/v1/athlete/${account.athleteId}/activities?oldest=${day(-120)}&newest=${day(1)}`;
    const res = await fetchImpl(url, { headers: { Authorization: basic(account.apiKey) } });
    if (!res.ok) {
      const detail = await failureDetail(res);
      throw new Error(detail ? `activities failed (${res.status}) ${detail}` : `activities failed (${res.status})`);
    }
    const feed: Feed = {
      source: "intervals",
      updatedAt: new Date().toISOString(),
      stale: false,
      activities: sanitizeActivities(await res.json()),
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
      const stale: Feed = { ...existing, stale: true };
      await env.FEED.put(FEED_KEY, JSON.stringify(stale));
      return stale;
    }
    throw error;
  }
}

async function serveFeed(env: Env, fetchImpl: FetchImpl): Promise<Feed> {
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
    return json(await serveFeed(env, fetchImpl), cors(request, env));
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
      refreshFeed(env).catch((error: unknown) => {
        console.error(error);
      }),
    );
  },
};
