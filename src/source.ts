/** The same block for every provider. The homepage renders this and nothing source-specific. */
export type SourceActivity = {
  label: string;
  value: string;
  url: string;
};

export type SourceBlock = {
  label: string;
  profileUrl: string;
  profilePicture: string;
  summary: string;
  activity: SourceActivity[];
  updatedAt: string | null;
};

function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function https(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function sourceBlock(value: unknown): SourceBlock | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.activity)) return null;
  const activity: SourceActivity[] = [];
  for (const item of row.activity) {
    if (!item || typeof item !== "object") continue;
    const activityRow = item as Record<string, unknown>;
    const label = clean(activityRow.label, 80);
    const detail = clean(activityRow.value, 160);
    if (!label || !detail) continue;
    activity.push({ label, value: detail, url: https(activityRow.url) });
    if (activity.length === 20) break;
  }
  return {
    label: clean(row.label, 40),
    profileUrl: https(row.profileUrl),
    profilePicture: https(row.profilePicture),
    summary: clean(row.summary, 160),
    activity,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
  };
}
