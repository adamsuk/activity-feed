import assert from "node:assert/strict";
import test from "node:test";
import { accountFromCollection, cleanToken, loadGithubAccounts, toPublicGithub } from "./github.ts";
import { handleRequest, refreshGithub } from "./index.ts";
import { MemoryKv } from "./memory-kv.ts";
import type { Env } from "./types.ts";

const TOKEN = "ghp_personal_token_value_123456";
const WORK_TOKEN = "ghp_work_token_value_123456789";

function collection(overrides: Record<string, unknown> = {}) {
  return {
    contributionCalendar: { totalContributions: 43 },
    totalCommitContributions: 0,
    totalPullRequestContributions: 0,
    totalPullRequestReviewContributions: 0,
    totalIssueContributions: 0,
    restrictedContributionsCount: 43,
    commitContributionsByRepository: [{ repository: { nameWithOwner: "secret/hidden" } }],
    ...overrides,
  };
}

function viewerResponse(login: string, body = collection()) {
  return new Response(JSON.stringify({ data: { viewer: { login, contributionsCollection: body } } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function env(extra: Partial<Env> = {}): Env {
  return { FEED: new MemoryKv(), ...extra };
}

test("a token has to look like a token", () => {
  assert.equal(cleanToken("Bearer ghp_personal_token_value_123456"), TOKEN);
  assert.equal(cleanToken("short"), null);
  assert.equal(cleanToken("ghp_with space_in_the_token_value"), null);
});

test("counts stay numeric and ignore repository names", () => {
  const account = accountFromCollection("sra405", "Work", collection());
  assert.equal(account.contributions, 43);
  assert.equal(JSON.stringify(account).includes("secret/hidden"), false);
  const opened = accountFromCollection("adamsuk", "Personal", collection({
    contributionCalendar: { totalContributions: 114 },
    totalCommitContributions: 64,
    totalPullRequestContributions: 17,
    totalPullRequestReviewContributions: 17,
    totalIssueContributions: 13,
    restrictedContributionsCount: 1,
  }));
  assert.equal(opened.commits, 64);
  assert.equal(opened.pullRequests, 17);
  assert.equal(opened.issues, 13);
});

test("each token is sent only for its own account and is not stored", async () => {
  const store = env({ GITHUB_TOKEN_PERSONAL: TOKEN, GITHUB_TOKEN_WORK: `Bearer ${WORK_TOKEN}` });
  const calls: { auth: string | null; query: string }[] = [];
  const snapshot = await refreshGithub(store, async (_input, init) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as { query: string };
    calls.push({ auth: headers.get("Authorization"), query: body.query });
    const login = headers.get("Authorization") === `Bearer ${TOKEN}` ? "adamsuk" : "sra405";
    const stats = login === "adamsuk"
      ? collection({ totalCommitContributions: 64, totalPullRequestContributions: 17 })
      : collection();
    return viewerResponse(login, stats);
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.auth, `Bearer ${TOKEN}`);
  assert.equal(calls[1]?.auth, `Bearer ${WORK_TOKEN}`);
  assert.equal(snapshot.accounts[0]?.commits, 64);
  assert.equal(snapshot.accounts[1]?.contributions, 43);
  const saved = (await store.FEED.get("github")) ?? "";
  assert.equal(saved.includes(TOKEN), false);
  assert.equal(saved.includes(WORK_TOKEN), false);
  assert.equal(saved.includes("secret/hidden"), false);
  assert.equal(saved.includes("commitContributionsByRepository"), false);
});

test("a missing token uses the public profile", async () => {
  let auth: string | null = "unset";
  const accounts = await loadGithubAccounts(env(), async (_input, init) => {
    auth = new Headers(init?.headers).get("Authorization");
    const body = JSON.parse(String(init?.body)) as { variables: { login: string } };
    return new Response(JSON.stringify({
      data: { user: { contributionsCollection: collection(body.variables.login === "adamsuk"
        ? { totalCommitContributions: 4, contributionCalendar: { totalContributions: 4 } }
        : {}) } },
    }));
  });
  assert.equal(auth, null);
  assert.equal(accounts[0]?.commits, 4);
  assert.equal(accounts[1]?.login, "sra405");
});

test("a token for the wrong account falls back to the public profile", async () => {
  const calls: string[] = [];
  const accounts = await loadGithubAccounts(
    env({ GITHUB_TOKEN_PERSONAL: TOKEN }),
    async (_input, init) => {
      const headers = new Headers(init?.headers);
      calls.push(headers.get("Authorization") ?? "public");
      if (headers.get("Authorization")) return viewerResponse("someone-else");
      return new Response(JSON.stringify({
        data: { user: { contributionsCollection: collection({ totalCommitContributions: 2 }) } },
      }));
    },
  );
  assert.deepEqual(calls.slice(0, 2), [`Bearer ${TOKEN}`, "public"]);
  assert.equal(accounts[0]?.commits, 2);
});

test("the public feed adds github counts and still hides the token", async () => {
  const store = env({
    INTERVALS_API_KEY: "intervals*key",
    GITHUB_TOKEN_PERSONAL: TOKEN,
    GITHUB_TOKEN_WORK: WORK_TOKEN,
  });
  const response = await handleRequest(
    new Request("https://activities.sradams.co.uk/feed.json", {
      headers: { Origin: "https://feat-github-week.sradams-co-uk-content.pages.dev" },
    }),
    store,
    async (input, init) => {
      const url = String(input);
      if (url.includes("intervals.icu")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      const headers = new Headers(init?.headers);
      const login = headers.get("Authorization") === `Bearer ${TOKEN}` ? "adamsuk" : "sra405";
      return viewerResponse(login);
    },
  );
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://feat-github-week.sradams-co-uk-content.pages.dev");
  const body = await response.json() as { source: string; github: { accounts: { login: string }[] } };
  assert.equal(body.source, "intervals");
  assert.deepEqual(body.github.accounts.map((account) => account.login), ["adamsuk", "sra405"]);
  assert.equal(JSON.stringify(body).includes(TOKEN), false);
});

test("a poisoned cache cannot add another account", () => {
  const snapshot = toPublicGithub({
    updatedAt: "2026-10-03T06:00:00Z",
    accounts: [
      { login: "adamsuk", label: "Hacker", contributions: 1, commits: 1, pullRequests: 0, reviews: 0, issues: 0 },
      { login: "evil", contributions: 9, commits: 9, pullRequests: 0, reviews: 0, issues: 0 },
      { login: "sra405", contributions: 2, commits: 0, pullRequests: 0, reviews: 0, issues: 0 },
    ],
  });
  assert.equal(snapshot?.accounts[0]?.label, "Personal");
  assert.equal(snapshot?.accounts.some((account) => account.login === "evil"), false);
});
