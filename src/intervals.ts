import { accountsFromEnv, binding, secretName } from "./accounts.ts";
import type { Provider } from "./provider.ts";
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

export const intervalsProvider: Provider = {
  id: "intervals",
  root: true,
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
    const feed = toPublicFeed(value);
    return feed.source === "intervals" ? feed : null;
  },
};
