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
}
