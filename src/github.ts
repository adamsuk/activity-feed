import { accountsFromEnv, binding, secretName } from "./accounts.ts";
import type { Account } from "./accounts.ts";
import type { Env, GithubAccount, GithubSnapshot } from "./types.ts";

const GITHUB_GRAPHQL = "https://api.github.com/graphql";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function githubAccounts(env: Env): Account[] {
  return accountsFromEnv(env.GITHUB_ACCOUNTS).filter((account) => account.login);
}

type FetchImpl = typeof fetch;

type Collection = {
  contributionCalendar?: { totalContributions?: number };
  totalCommitContributions?: number;
  totalPullRequestContributions?: number;
  totalPullRequestReviewContributions?: number;
  totalIssueContributions?: number;
  restrictedContributionsCount?: number;
};

type GraphqlBody = {
  data?: {
    user?: { contributionsCollection?: Collection };
    viewer?: { login?: string; contributionsCollection?: Collection };
  };
};

const FIELDS = `
  contributionCalendar { totalContributions }
  totalCommitContributions
  totalPullRequestContributions
  totalPullRequestReviewContributions
  totalIssueContributions
  restrictedContributionsCount
`;

const USER_QUERY = `query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) { ${FIELDS} }
  }
}`;

const VIEWER_QUERY = `query($from: DateTime!, $to: DateTime!) {
  viewer {
    login
    contributionsCollection(from: $from, to: $to) { ${FIELDS} }
  }
}`;

export function cleanToken(value: string | undefined): string | null {
  let token = (value || "").trim();
  if (/^bearer\s+/i.test(token)) token = token.slice(token.indexOf(" ") + 1).trim();
  if (token.length < 20 || token.length > 300) return null;
  if (/[^\x21-\x7e]/.test(token)) return null;
  return token;
}

export function weekRange(now = Date.now()): { from: string; to: string } {
  return {
    from: new Date(now - WEEK_MS).toISOString(),
    to: new Date(now).toISOString(),
  };
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100_000) return 0;
  return value;
}

export function accountFromCollection(
  login: string,
  label: GithubAccount["label"],
  collection: Collection | undefined,
): GithubAccount {
  const commits = count(collection?.totalCommitContributions);
  const pullRequests = count(collection?.totalPullRequestContributions);
  const reviews = count(collection?.totalPullRequestReviewContributions);
  const issues = count(collection?.totalIssueContributions);
  const restricted = count(collection?.restrictedContributionsCount);
  const calendar = count(collection?.contributionCalendar?.totalContributions);
  return {
    login,
    label,
    contributions: Math.max(calendar, commits + pullRequests + reviews + issues + restricted),
    commits,
    pullRequests,
    reviews,
    issues,
  };
}

async function graphql(
  fetchImpl: FetchImpl,
  token: string | null,
  query: string,
  variables: { login?: string; from: string; to: string },
): Promise<GraphqlBody> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "sradams-activity-feed",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchImpl(GITHUB_GRAPHQL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`github failed (${res.status})`);
  return (await res.json()) as GraphqlBody;
}

async function loadAccount(
  fetchImpl: FetchImpl,
  account: Account,
  token: string | null,
  range: { from: string; to: string },
): Promise<GithubAccount> {
  if (token) {
    const body = await graphql(fetchImpl, token, VIEWER_QUERY, range);
    const viewer = body.data?.viewer;
    if (viewer?.login === account.login) {
      return accountFromCollection(account.login, account.label, viewer.contributionsCollection);
    }
  }
  const body = await graphql(fetchImpl, null, USER_QUERY, { login: account.login, ...range });
  const collection = body.data?.user?.contributionsCollection;
  if (!collection) throw new Error(`github failed for ${account.login}`);
  return accountFromCollection(account.login, account.label, collection);
}

export async function loadGithubAccounts(
  env: Env,
  fetchImpl: FetchImpl,
  now = Date.now(),
): Promise<GithubAccount[]> {
  const range = weekRange(now);
  const accounts: GithubAccount[] = [];
  for (const account of githubAccounts(env)) {
    const token = cleanToken(binding(env, secretName("GITHUB_TOKEN", account.id)));
    accounts.push(await loadAccount(fetchImpl, account, token, range));
  }
  return accounts;
}

export function toPublicGithub(value: unknown, allowed: Account[]): GithubSnapshot | null {
  if (allowed.length === 0 || !value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.accounts)) return null;
  const byLogin = new Map<string, Record<string, unknown>>();
  for (const item of row.accounts) {
    if (!item || typeof item !== "object") continue;
    const account = item as Record<string, unknown>;
    if (typeof account.login === "string") byLogin.set(account.login, account);
  }
  const accounts: GithubAccount[] = [];
  for (const account of allowed) {
    const found = byLogin.get(account.login);
    if (!found) return null;
    accounts.push({
      login: account.login,
      label: account.label,
      contributions: count(found.contributions),
      commits: count(found.commits),
      pullRequests: count(found.pullRequests),
      reviews: count(found.reviews),
      issues: count(found.issues),
    });
  }
  return {
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    stale: row.stale === true,
    accounts,
  };
}
