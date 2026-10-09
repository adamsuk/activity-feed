import assert from "node:assert/strict";
import test from "node:test";
import { booksFromRss, goodreadsAccounts, goodreadsProvider, toPublicGoodreads } from "./goodreads.ts";
import { refresh } from "./index.ts";
import { MemoryKv } from "./memory-kv.ts";
import type { Env } from "./types.ts";

const NOW = Date.parse("2026-10-09T12:00:00Z");

function item(fields: Record<string, string>): string {
  const body = Object.entries(fields).map(([name, value]) => `<${name}><![CDATA[${value}]]></${name}>`).join("");
  return `<item>${body}<user_review><![CDATA[secret thoughts about the ending]]></user_review><book_description><![CDATA[a long plot summary]]></book_description></item>`;
}

const RSS = `<?xml version="1.0"?><rss><channel>
${item({
  title: "Finished recently",
  book_id: "11",
  author_name: "Ada & Grace",
  user_rating: "4",
  user_read_at: "Wed, 07 Oct 2026 00:00:00 +0000",
  book_medium_image_url: "https://i.gr-assets.com/images/cover.jpg",
})}
${item({
  title: "Finished last month",
  book_id: "12",
  author_name: "Old",
  user_rating: "5",
  user_read_at: "Tue, 18 Aug 2026 00:00:00 +0000",
})}
${item({
  title: "Still going",
  book_id: "13",
  author_name: "Now",
  user_rating: "0",
  user_read_at: "",
  user_date_added: "Sat, 01 Jan 2026 00:00:00 +0000",
})}
</channel></rss>`;

function env(accounts: unknown): Env {
  return { FEED: new MemoryKv(), GOODREADS_ACCOUNTS: JSON.stringify(accounts) };
}

test("goodreads is not called when no accounts are configured", async () => {
  let called = 0;
  const result = await refresh({ FEED: new MemoryKv() }, goodreadsProvider, async () => {
    called += 1;
    return new Response("no");
  });
  assert.equal(result, null);
  assert.equal(called, 0);
});

test("a user id has to be the number from the profile URL", () => {
  const accounts = goodreadsAccounts(env([
    { id: "personal", label: "Personal", userId: "12345678" },
    { id: "bad", label: "Bad", userId: "not-a-number" },
    { id: "personal", label: "Again", userId: "99" },
  ]));
  assert.deepEqual(accounts, [{ id: "personal", label: "Personal", userId: "12345678" }]);
});

test("the week keeps a fresh finish and the current book, not the review", () => {
  const finished = booksFromRss(RSS, "read", NOW);
  assert.deepEqual(finished.map((book) => book.title), ["Finished recently"]);
  assert.equal(finished[0].author, "Ada & Grace");
  assert.equal(finished[0].rating, 4);
  assert.equal(JSON.stringify(finished).includes("secret thoughts"), false);
  const reading = booksFromRss(RSS, "currently-reading", NOW);
  assert.deepEqual(reading.map((book) => book.title), ["Finished recently", "Finished last month", "Still going"]);
});

test("the feed stores titles and drops anything not configured", async () => {
  const store = env([{ id: "personal", label: "Personal", userId: "12345678" }]);
  const urls: string[] = [];
  const snapshot = await refresh(store, goodreadsProvider, async (input) => {
    urls.push(String(input));
    const shelf = new URL(String(input)).searchParams.get("shelf");
    return new Response(shelf === "read" ? RSS : "<rss><channel></channel></rss>");
  }, NOW);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /\/review\/list_rss\/12345678\?/);
  const body = snapshot as { books: Array<Record<string, unknown>> };
  assert.equal(body.books.length, 1);
  assert.equal(body.books[0].title, "Finished recently");
  assert.equal("accountId" in body.books[0], false);
  assert.equal(JSON.stringify(snapshot).includes("secret thoughts"), false);
  const cached = JSON.parse(await store.FEED.get("goodreads") || "{}") as { books: Array<{ accountId?: string }> };
  assert.equal(cached.books[0].accountId, "personal");
  const published = toPublicGoodreads({ books: [{ title: "Nope" }] }, goodreadsAccounts(store));
  assert.deepEqual(published && published.books, []);
});
