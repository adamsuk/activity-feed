import { emptyFeed, sanitizeActivities, toPublicFeed } from "./strava.ts";
import type { Env, Feed, IntervalsAccount } from "./types.ts";

const FEED_KEY = "feed";
const ACCOUNT_KEY = "intervals";
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

function accountFrom(value: unknown): IntervalsAccount | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const apiKey = typeof row.apiKey === "string" ? row.apiKey : "";
  const athleteId = typeof row.athleteId === "string" ? row.athleteId : "";
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(apiKey)) return null;
  if (!/^i?\d{1,20}$/.test(athleteId)) return null;
  const athleteName = typeof row.athleteName === "string" ? row.athleteName.slice(0, 80) : undefined;
  return { apiKey, athleteId, athleteName };
}

async function readAccount(env: Env): Promise<IntervalsAccount | null> {
  const raw = await env.FEED.get(ACCOUNT_KEY);
  if (!raw) return null;
  try {
    return accountFrom(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function saveAccount(env: Env, account: IntervalsAccount): Promise<void> {
  await env.FEED.put(ACCOUNT_KEY, JSON.stringify(account));
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

export async function refreshFeed(
  env: Env,
  fetchImpl: FetchImpl = fetch,
  known?: IntervalsAccount | null,
): Promise<Feed> {
  try {
    const account = known?.apiKey ? known : await readAccount(env);
    if (!account) throw new Error("Intervals.icu is not connected");
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
  const account = await readAccount(env);
  if (!account) return emptyFeed();
  try {
    return await refreshFeed(env, fetchImpl, account);
  } catch {
    return emptyFeed();
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
      "X-Robots-Tag": "noindex",
    },
  });
}

function keyForm(): string {
  return `<form method="post" action="/connect">
<label>Intervals.icu API key
<input name="apiKey" type="password" autocomplete="off" required>
</label>
<button type="submit">Save key</button>
</form>
<p class="note">In Intervals.icu: Settings, Developer, create a key. Garmin should be the connected source, not Strava. The key stays on this worker.</p>`;
}

async function syncHint(env: Env): Promise<string> {
  const raw = await env.FEED.get(SYNC_KEY);
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { message?: string };
    return typeof parsed.message === "string" && parsed.message ? "The activity pull failed. It will retry shortly." : "";
  } catch {
    return "";
  }
}

async function statusPage(request: Request, env: Env): Promise<Response> {
  const error = new URL(request.url).searchParams.get("error");
  const replace = new URL(request.url).searchParams.get("replace");
  const account = await readAccount(env);
  const feed = await readFeed(env);
  const hint = await syncHint(env);
  const problem =
    error === "key"
      ? "Intervals.icu did not accept that key."
      : error === "refresh"
        ? "The cache refresh failed. It will retry shortly."
        : hint;
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

async function connect(request: Request, env: Env, fetchImpl: FetchImpl): Promise<Response> {
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
  const account: IntervalsAccount = { apiKey, athleteId: athlete.id, athleteName: athlete.name };
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
