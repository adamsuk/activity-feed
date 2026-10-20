import { accountsFromEnv, binding, secretName } from "./accounts.ts";
import type { Account } from "./accounts.ts";
import type { Provider } from "./provider.ts";
import { plainText, sanitizeFeatured, type Featured } from "./featured.ts";
import type { SourceBlock } from "./source.ts";
import type { Env, GithubAccount } from "./types.ts";

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

const LATEST_PR_QUERY = `query($login: String!) {
  user(login: $login) {
    pullRequests(first: 10, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        title body url number state isDraft createdAt mergedAt
        repository { nameWithOwner isPrivate }
      }
    }
  }
}`;

export type LatestPr = {
  title: string;
  body: string;
  url: string;
  number: number;
  repo: string;
  state: "Open" | "Draft" | "Merged" | "Closed";
  at: string;
};

export function latestPrFromJson(body: unknown): LatestPr | null {
  const nodes = (body as { data?: { user?: { pullRequests?: { nodes?: unknown } } } })
    ?.data?.user?.pullRequests?.nodes;
  if (!Array.isArray(nodes)) return null;
  for (const item of nodes) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const repository = (row.repository ?? {}) as Record<string, unknown>;
    // Private repositories never reach the public feed.
    if (repository.isPrivate !== false) continue;
    const repo = typeof repository.nameWithOwner === "string" ? repository.nameWithOwner : "";
    const url = typeof row.url === "string" ? row.url : "";
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !url.startsWith(`https://github.com/${repo}/pull/`)) continue;
    const title = typeof row.title === "string" ? row.title.trim().slice(0, 160) : "";
    if (!title) continue;
    const state = row.state === "MERGED" ? "Merged" : row.state === "CLOSED" ? "Closed" : row.isDraft === true ? "Draft" : "Open";
    return {
      title,
      body: plainText(row.body, 240),
      url,
      number: Number.isSafeInteger(row.number) ? (row.number as number) : 0,
      repo,
      state,
      at: typeof row.mergedAt === "string" && row.mergedAt ? row.mergedAt : typeof row.createdAt === "string" ? row.createdAt : "",
    };
  }
  return null;
}

/** The newest public PR by the first account. A failure only drops the card. */
export async function loadLatestPr(env: Env, fetchImpl: FetchImpl): Promise<LatestPr | null> {
  const account = githubAccounts(env)[0];
  if (!account) return null;
  const token = cleanToken(binding(env, secretName("GITHUB_TOKEN", account.id)));
  if (!token) return null;
  try {
    const res = await fetchImpl(GITHUB_GRAPHQL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "sradams-activity-feed",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: LATEST_PR_QUERY, variables: { login: account.login } }),
    });
    if (!res.ok) return null;
    return latestPrFromJson(await res.json());
  } catch {
    return null;
  }
}

function shortDate(at: string): string {
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return "";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" }).format(parsed);
}

export function featuredPr(value: unknown): Featured | null {
  if (!value || typeof value !== "object") return null;
  const pr = value as Record<string, unknown>;
  const url = typeof pr.url === "string" && pr.url.startsWith("https://github.com/") ? pr.url : "";
  if (!url) return null;
  const repo = typeof pr.repo === "string" ? pr.repo : "";
  const number = typeof pr.number === "number" && pr.number > 0 ? ` #${pr.number}` : "";
  const state = typeof pr.state === "string" ? pr.state : "";
  const when = typeof pr.at === "string" ? shortDate(pr.at) : "";
  return sanitizeFeatured({
    heading: "Latest PR",
    title: pr.title,
    subtitle: `${repo}${number}`,
    description: pr.body,
    url,
    image: "",
    details: [state, when ? `${state === "Merged" ? "Merged" : "Opened"} ${when}` : ""],
  });
}

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

function detail(stats: GithubAccount): string {
  const word = (value: number, singular: string, plural = `${singular}s`) => (
    `${value} ${value === 1 ? singular : plural}`
  );
  const parts: string[] = [];
  if (stats.commits > 0) parts.push(word(stats.commits, "commit"));
  if (stats.pullRequests > 0) parts.push(word(stats.pullRequests, "PR"));
  if (stats.reviews > 0) parts.push(word(stats.reviews, "review"));
  if (stats.issues > 0) parts.push(word(stats.issues, "issue"));
  if (parts.length > 0) return parts.join(" · ");
  if (stats.contributions > 0) return word(stats.contributions, "contribution");
  return "Quiet week";
}

export function toPublicGithub(value: unknown, allowed: Account[]): SourceBlock | null {
  if (allowed.length === 0 || !value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  // Only the raw cached shape is trusted: it is re-filtered against the allowlist.
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
  const first = accounts[0];
  if (!first) return null;
  const featured = featuredPr(row.latestPr);
  return {
    label: "GitHub",
    profileUrl: `https://github.com/${first.login}`,
    profilePicture: `https://github.com/${first.login}.png`,
    fallbackPicture: true,
    summary: "",
    activity: accounts.map((account) => ({
      label: account.label,
      value: detail(account),
      url: `https://github.com/${account.login}`,
    })),
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    ...(featured ? { featured } : {}),
  };
}

export const githubProvider: Provider = {
  id: "github",
  enabled(env) {
    return githubAccounts(env).length > 0;
  },
  async load(env, fetchImpl, now = Date.now()) {
    return {
      updatedAt: new Date(now).toISOString(),
      stale: false,
      accounts: await loadGithubAccounts(env, fetchImpl, now),
      latestPr: await loadLatestPr(env, fetchImpl),
    };
  },
  publish(env, value) {
    return toPublicGithub(value, githubAccounts(env));
  },
};
