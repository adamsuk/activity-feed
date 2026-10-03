import type { Env } from "./types.ts";

export type Account = {
  id: string;
  label: string;
  login: string;
};

function cleanLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const label = value.replace(/[\u0000-\u001F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return label || fallback;
}

/** JSON array from a worker variable. Tokens are not accepted here. */
export function accountsFromEnv(raw: string | undefined): Account[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const accounts: Account[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim().toLowerCase() : "";
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(id) || seen.has(id)) continue;
    const login = typeof row.login === "string" ? row.login.trim() : "";
    if (login && !/^[A-Za-z0-9-]{1,39}$/.test(login)) continue;
    seen.add(id);
    accounts.push({ id, label: cleanLabel(row.label, id), login });
    if (accounts.length === 10) break;
  }
  return accounts;
}

export function secretName(prefix: string, id: string): string {
  return `${prefix}_${id.toUpperCase().replace(/-/g, "_")}`;
}

export function binding(env: Env, name: string): string | undefined {
  const value = (env as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}
