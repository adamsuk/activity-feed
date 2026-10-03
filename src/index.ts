import type { FetchImpl, Provider } from "./provider.ts";
import { providers } from "./providers.ts";
import { emptyFeed } from "./strava.ts";
import type { Env } from "./types.ts";

const SYNC_BACKOFF_MS = 5 * 60 * 1000;
const DEFAULT_ORIGINS = "https://sradams.co.uk,https://www.sradams.co.uk";
const PAGES_HOST = "sradams-co-uk-content.pages.dev";
const ROOT_FIELDS = new Set(["source", "updatedAt", "stale", "activities"]);

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
    const record = body as Record<string, unknown>;
    const onlyRoot = Object.keys(record).every((key) => ROOT_FIELDS.has(key));
    headers.set("Cache-Control", record.source === "empty" && onlyRoot ? "no-store" : "public, max-age=300");
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

function syncKey(provider: Provider): string {
  return `${provider.id}:sync`;
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

async function readSection(env: Env, provider: Provider): Promise<Record<string, unknown> | null> {
  const raw = await env.FEED.get(provider.id);
  if (!raw) return null;
  try {
    return provider.publish(env, JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function refresh(
  env: Env,
  provider: Provider,
  fetchImpl: FetchImpl = fetch,
  now = Date.now(),
): Promise<Record<string, unknown> | null> {
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

async function serveProvider(
  env: Env,
  provider: Provider,
  fetchImpl: FetchImpl,
): Promise<Record<string, unknown> | null> {
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

async function serveFeed(env: Env, fetchImpl: FetchImpl): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
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
    const enabled = providers.filter((provider) => provider.enabled(env));
    ctx.waitUntil(
      Promise.all(enabled.map((provider) => refresh(env, provider).catch((error: unknown) => {
        console.error(error);
      }))),
    );
  },
};
