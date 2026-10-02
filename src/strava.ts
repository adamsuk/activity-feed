import type { CachedActivity, Feed, Sport } from "./types.ts";

const RUN = new Set(["Run", "TrailRun", "VirtualRun"]);
const RIDE = new Set([
  "Ride",
  "VirtualRide",
  "GravelRide",
  "MountainBikeRide",
  "EBikeRide",
  "EMountainBikeRide",
  "Velomobile",
  "Handcycle",
]);
const SWIM = new Set(["Swim"]);
const PUBLIC_SPORTS = new Set<Sport>(["Run", "Ride", "Swim", "Other"]);

export function emptyFeed(): Feed {
  return { source: "empty", updatedAt: null, stale: false, activities: [] };
}

export function mapSport(sportType: unknown, fallbackType: unknown): Sport {
  const key = typeof sportType === "string" && sportType ? sportType : fallbackType;
  if (typeof key !== "string") return "Other";
  if (RUN.has(key)) return "Run";
  if (RIDE.has(key)) return "Ride";
  if (SWIM.has(key)) return "Swim";
  return "Other";
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function finite(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/** Keep the fields a homepage can show. Drop GPS, heart rate, and anything else. */
export function sanitizeActivity(raw: unknown): CachedActivity | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  if (row.private === true) return null;

  const idNum = typeof row.id === "number" ? row.id : Number(row.id);
  if (!Number.isSafeInteger(idNum) || idNum <= 0) return null;

  const distance = finite(row.distance);
  const moving = finite(row.moving_time);
  const elevation = finite(row.total_elevation_gain);
  const start = cleanText(row.start_date, 40);
  if (distance === null || moving === null || elevation === null || !start) return null;

  const city = cleanText(row.location_city, 40);
  const region = cleanText(row.location_state, 40);

  return {
    id: String(idNum),
    name: cleanText(row.name, 80) || "Activity",
    sport: mapSport(row.sport_type, row.type),
    start,
    distanceM: Math.round(distance),
    movingS: Math.round(moving),
    elevationM: Math.round(elevation),
    location: [city, region].filter(Boolean).join(", "),
    stravaUrl: `https://www.strava.com/activities/${idNum}`,
  };
}

export function sanitizeActivities(raw: unknown): CachedActivity[] {
  if (!Array.isArray(raw)) return [];
  const activities: CachedActivity[] = [];
  for (const row of raw) {
    const activity = sanitizeActivity(row);
    if (activity) activities.push(activity);
    if (activities.length === 30) break;
  }
  return activities;
}

function publicActivity(raw: unknown): CachedActivity | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : "";
  if (!/^\d{1,20}$/.test(id)) return null;
  if (typeof row.sport !== "string" || !PUBLIC_SPORTS.has(row.sport as Sport)) return null;
  const distanceM = finite(row.distanceM);
  const movingS = finite(row.movingS);
  const elevationM = finite(row.elevationM);
  const start = cleanText(row.start, 40);
  const stravaUrl = cleanText(row.stravaUrl, 80);
  if (distanceM === null || movingS === null || elevationM === null || !start) return null;
  if (!stravaUrl.startsWith(`https://www.strava.com/activities/${id}`)) return null;
  return {
    id,
    name: cleanText(row.name, 80) || "Activity",
    sport: row.sport as Sport,
    start,
    distanceM: Math.round(distanceM),
    movingS: Math.round(movingS),
    elevationM: Math.round(elevationM),
    location: cleanText(row.location, 80),
    stravaUrl,
  };
}

export function toPublicFeed(value: unknown): Feed {
  if (!value || typeof value !== "object") return emptyFeed();
  const row = value as Record<string, unknown>;
  const activities: CachedActivity[] = [];
  if (Array.isArray(row.activities)) {
    for (const item of row.activities) {
      const activity = publicActivity(item);
      if (activity) activities.push(activity);
      if (activities.length === 30) break;
    }
  }
  return {
    source: row.source === "strava" ? "strava" : "empty",
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    stale: row.stale === true,
    activities,
  };
}
