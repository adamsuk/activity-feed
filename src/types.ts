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
  /** Set when the provider has more than one account. */
  account?: string;
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
  label: string;
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
  /** Intervals.icu key for the personal account. Extra accounts use INTERVALS_API_KEY_<ID>. */
  INTERVALS_API_KEY?: string;
  /**
   * JSON array of accounts. Logins live here, not in code.
   * [{"id":"personal","label":"Personal","login":"..."}]
   * The token for an id is the secret GITHUB_TOKEN_<ID>.
   */
  GITHUB_ACCOUNTS?: string;
  /**
   * Optional JSON array. When omitted, INTERVALS_API_KEY is the only account.
   * [{"id":"personal","label":"Personal"},{"id":"work","label":"Work"}]
   */
  INTERVALS_ACCOUNTS?: string;
}
