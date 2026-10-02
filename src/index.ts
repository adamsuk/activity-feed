import { emptyFeed, sanitizeActivities, toPublicFeed } from "./strava.ts";
import type { Env, Feed, TokenRecord } from "./types.ts";

const FEED_KEY = "feed";
const TOKEN_KEY = "token";
const TOKEN_URL = "https://www.strava.com/oauth/token";
// www.strava.com/api/v3 remains valid until the January 2027 cutover.
const ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities?per_page=30";

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

function readCookie(request: Request, name: string): string {
  const raw = request.headers.get("Cookie") ?? "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
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

async function readToken(env: Env): Promise<TokenRecord | null> {
  const raw = await env.FEED.get(TOKEN_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TokenRecord>;
    if (!parsed.accessToken || !parsed.refreshToken || !parsed.expiresAt) return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      athleteName: typeof parsed.athleteName === "string" ? parsed.athleteName : undefined,
    };
  } catch {
    return null;
  }
}

async function saveToken(env: Env, record: TokenRecord): Promise<void> {
  await env.FEED.put(TOKEN_KEY, JSON.stringify(record));
}

function tokenFromJson(body: Record<string, unknown>, nowSec: number): TokenRecord | null {
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
  const expiresAt =
    typeof body.expires_at === "number"
      ? body.expires_at
      : typeof body.expires_in === "number"
        ? nowSec + body.expires_in
        : 0;
  if (!accessToken || !refreshToken || !expiresAt) return null;
  const athlete = body.athlete;
  let athleteName: string | undefined;
  if (athlete && typeof athlete === "object") {
    const row = athlete as Record<string, unknown>;
    const first = typeof row.firstname === "string" ? row.firstname.trim() : "";
    const last = typeof row.lastname === "string" ? row.lastname.trim() : "";
    const name = [first, last].filter(Boolean).join(" ").slice(0, 80);
    if (name) athleteName = name;
  }
  return { accessToken, refreshToken, expiresAt, athleteName };
}

async function ensureAccess(env: Env, fetchImpl: FetchImpl): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
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
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error(`token refresh failed (${res.status})`);
  const next = tokenFromJson((await res.json()) as Record<string, unknown>, now);
  if (!next) throw new Error("token refresh returned no token");
  if (!next.athleteName && stored?.athleteName) next.athleteName = stored.athleteName;
  await saveToken(env, next);
  return next.accessToken;
}

export async function refreshFeed(env: Env, fetchImpl: FetchImpl = fetch): Promise<Feed> {
  try {
    const access = await ensureAccess(env, fetchImpl);
    const res = await fetchImpl(ACTIVITIES_URL, {
      headers: { Authorization: `Bearer ${access}` },
    });
    if (!res.ok) throw new Error(`activities failed (${res.status})`);
    const feed: Feed = {
      source: "strava",
      updatedAt: new Date().toISOString(),
      stale: false,
      activities: sanitizeActivities(await res.json()),
    };
    await env.FEED.put(FEED_KEY, JSON.stringify(feed));
    return feed;
  } catch (error) {
    const existing = await readFeed(env);
    if (existing.source === "strava") {
      const stale: Feed = { ...existing, stale: true };
      await env.FEED.put(FEED_KEY, JSON.stringify(stale));
      return stale;
    }
    throw error;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "\u0026amp;")
    .replace(/</g, "\u0026lt;")
    .replace(/>/g, "\u0026gt;")
    .replace(/"/g, "\u0026quot;");
}

function page(body: string): Response {
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
      "X-Robots-Tag": "noindex",
    },
  });
}

async function statusPage(request: Request, env: Env): Promise<Response> {
  const error = new URL(request.url).searchParams.get("error");
  const token = await readToken(env);
  const feed = await readFeed(env);
  const problem =
    error === "declined"
      ? "Strava authorisation was declined."
      : error === "state"
        ? "That login expired. Try again."
        : error === "token"
          ? "Strava did not accept that login."
          : error === "refresh"
            ? "The cache refresh failed. The cron will retry."
            : "";
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

async function startOauth(request: Request, env: Env): Promise<Response> {
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
    state,
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://www.strava.com/oauth/authorize?${params}`,
      "Cache-Control": "no-store",
      "Set-Cookie": `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/oauth; Max-Age=600`,
    },
  });
}

async function finishOauth(request: Request, env: Env, fetchImpl: FetchImpl): Promise<Response> {
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
      grant_type: "authorization_code",
    }),
  });
  const record = res.ok
    ? tokenFromJson((await res.json()) as Record<string, unknown>, Math.floor(Date.now() / 1000))
    : null;
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
