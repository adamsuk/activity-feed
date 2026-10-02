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
  stravaUrl: string;
};

export type Feed = {
  source: "strava" | "empty";
  updatedAt: string | null;
  stale: boolean;
  activities: CachedActivity[];
};

export type TokenRecord = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
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
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string;
  /** Optional. The Strava login stores the refresh token in KV, which wins after that. */
  STRAVA_REFRESH_TOKEN?: string;
  /** Comma-separated. Defaults to the public site. */
  ALLOWED_ORIGINS?: string;
}
