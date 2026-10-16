import { accountsFromEnv, binding, secretName } from "./accounts.ts";
import type { Provider } from "./provider.ts";
import { sourceBlock, type SourceBlock } from "./source.ts";
import { sanitizeActivities, toPublicFeed } from "./strava.ts";
import type { CachedActivity, Env } from "./types.ts";

type FetchImpl = typeof fetch;

type Resolved = {
  id: string;
  label: string;
  apiKey: string;
  athleteId: string;
};

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

function configured(env: Env): Resolved[] {
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

function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

async function failureDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    return typeof body.message === "string" ? body.message.slice(0, 80) : "";
  } catch {
    return "";
  }
}

async function pull(account: Resolved, fetchImpl: FetchImpl): Promise<CachedActivity[]> {
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

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function formatDistance(metres: number): string {
  return `${(metres / 1000).toFixed(1)} km`;
}

function formatMoving(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.round((safe % 3600) / 60);
  if (minutes === 60) return `${hours + 1}h 0m`;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function formatWhen(start: string): string {
  const parsed = Date.parse(start);
  if (!Number.isFinite(parsed)) return "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/London",
  }).format(parsed);
}

function sessionLabel(activity: CachedActivity): string {
  if (activity.sport && activity.sport !== "Other") return activity.sport;
  const name = activity.name.trim();
  if (/football|soccer/i.test(name)) return "Football";
  const head = name.split(" - ")[0].replace(/^Rushcliffe\s+/i, "").trim();
  if (!head) return "Session";
  return head.length > 22 ? `${head.slice(0, 21)}…` : head;
}

/** Raw Intervals.icu storage URL; may change, so the site falls back to the GitHub picture. */
export const INTERVALS_PICTURE =
  "https://storage.googleapis.com/intervals-icu-images/profile_pics/8439aaad-4817-4519-8deb-963fb1dd96a0";

export function toPublicIntervals(value: unknown, now = Date.now()): SourceBlock | null {
  const row = value as Record<string, unknown> | null;
  if (row && !Array.isArray(row.activities)) {
    // A cached row may predate the raw picture URL (profilePicture ""), so fill it in.
    const cached = sourceBlock(value);
    if (cached && !cached.profilePicture.trim()) cached.profilePicture = INTERVALS_PICTURE;
    return cached;
  }
  const feed = toPublicFeed(value);
  if (feed.source !== "intervals") return null;
  const week = feed.activities.filter((activity) => {
    const started = Date.parse(activity.start);
    return Number.isFinite(started) && started <= now && now - started <= WEEK_MS;
  });
  const distanceM = week.reduce((sum, activity) => sum + activity.distanceM, 0);
  const movingS = week.reduce((sum, activity) => sum + activity.movingS, 0);
  const sessions = week.length === 1 ? "session" : "sessions";
  return {
    label: "Training",
    profileUrl: "https://intervals.icu/",
    profilePicture: INTERVALS_PICTURE,
    summary: `${formatDistance(distanceM)} · ${week.length} ${sessions} · ${formatMoving(movingS)}`,
    activity: week.slice(0, 20).map((activity) => ({
      label: [activity.account, formatWhen(activity.start), sessionLabel(activity)].filter(Boolean).join(" · "),
      value: `${formatDistance(activity.distanceM)} · ${formatMoving(activity.movingS)}`,
      url: activity.url,
    })),
    updatedAt: feed.updatedAt,
  };
}

export const intervalsProvider: Provider = {
  id: "intervals",
  enabled(env) {
    return Boolean(env.INTERVALS_ACCOUNTS?.trim() || cleanApiKey(env.INTERVALS_API_KEY));
  },
  async load(env, fetchImpl) {
    const accounts = configured(env);
    if (accounts.length === 0) throw new Error("Intervals.icu API key is not set");
    const showLabel = accounts.length > 1;
    const activities: CachedActivity[] = [];
    for (const account of accounts) {
      const rows = await pull(showLabel ? account : { ...account, label: "" }, fetchImpl);
      activities.push(...rows);
    }
    activities.sort((left, right) => (left.start < right.start ? 1 : left.start > right.start ? -1 : 0));
    return {
      source: "intervals",
      updatedAt: new Date().toISOString(),
      stale: false,
      activities: activities.slice(0, 30),
    };
  },
  publish(_env, value) {
    return toPublicIntervals(value);
  },
};
