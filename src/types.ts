export type Sport = "Run" | "Ride" | "Swim" | "Other";

export type CachedActivity = {
  id: string;
  name: string;
  sport: Sport;
  start: string;
  distanceM: number;
  movingS: number;
  elevationM: number;
  location: string;
  url: string;
};

export type Feed = {
  source: "intervals" | "empty";
  updatedAt: string | null;
  stale: boolean;
  activities: CachedActivity[];
};

export type IntervalsAccount = {
  apiKey: string;
  athleteId: string;
  athleteName?: string;
};

export type GithubAccount = {
  login: string;
  label: "Personal" | "Work";
  contributions: number;
  commits: number;
  pullRequests: number;
  reviews: number;
  issues: number;
};

export type GithubSnapshot = {
  updatedAt: string | null;
  stale: boolean;
  accounts: GithubAccount[];
};

/** Minimal KV surface so the worker runs on Cloudflare and in tests. */
export interface Kv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Env {
  FEED: Kv;
  /** Comma-separated. Defaults to the public site. */
  ALLOWED_ORIGINS?: string;
  /** Intervals.icu personal API key. Set as a Worker secret. Never commit it. */
  INTERVALS_API_KEY?: string;
  /**
   * GitHub tokens for adamsuk and sra405. Read-only is enough.
   * A token sees that account's private commits and pull requests.
   * The public feed still stores only the counts.
   */
  GITHUB_TOKEN_PERSONAL?: string;
  GITHUB_TOKEN_WORK?: string;
}
