import type { Env } from "./types.ts";

export type FetchImpl = typeof fetch;

/** A source the worker can refresh. Index never names a source itself. */
export interface Provider {
  id: string;
  /** Put the section on the feed root. Otherwise it is nested under id. */
  root?: boolean;
  enabled(env: Env): boolean;
  load(env: Env, fetchImpl: FetchImpl, now?: number): Promise<Record<string, unknown>>;
  publish(env: Env, value: unknown): Record<string, unknown> | null;
}
