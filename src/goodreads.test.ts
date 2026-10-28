import assert from "node:assert/strict";
import test from "node:test";
import { booksFromProfile, goodreadsAccounts, goodreadsProvider, pictureFromProfile, toPublicGoodreads } from "./goodreads.ts";
import { refresh } from "./index.ts";
import { MemoryKv } from "./memory-kv.ts";
import type { Env } from "./types.ts";

const NOW = Date.parse("2026-10-09T12:00:00Z");

/** One row of the profile's currently-reading block, shaped as Goodreads sends it. */
function row(fields: { id: string; title: string; author?: string; cover?: string }): string {
  return `<div class="Updates no_border">
    <div class="firstcol"><a href="/book/show/${fields.id}.Slug">
      <img src="${fields.cover ?? `https://i.gr-assets.com/books/1l/${fields.id}.jpg`}" /></a></div>
    <div class="secondcol">
      <div><a class="bookTitle" href="/book/show/${fields.id}.Slug">${fields.title}</a></div>
      <div><a class="authorName" href="/author/show/1.A">${fields.author ?? "Someone"}</a></div>
      <div class="userReview">private notes nobody asked to publish</div>
    </div>
  </div>`;
}

/** The public profile page, trimmed to what the parser reads. */
function profileHtml(rows: string, extra = ""): string {
  return `<html><head>
    <meta property="og:image" content="https://images.gr-assets.com/users/1234p5/99.jpg">
    </head><body>${extra}
    <div id="currentlyReadingReviews">${rows}</div>
    </body></html>`;
}

const SIGN_IN = `<html><head><title>Sign in</title></head><body>
  <form action="/user/sign_in"></form></body></html>`;

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

// The two tests that were here covered booksFromRss's read-shelf window and its
// ordering of finished books. Goodreads ended anonymous access to /review/list
// and list_rss, so finished books have no source at all and that code is gone.
// Removed rather than weakened: there is nothing left to assert. See #19.

test("the current reads come off the profile, without the private notes", () => {
  const books = booksFromProfile(profileHtml(
    row({ id: "10572", title: "A Clash of Kings", author: "George R.R. Martin" })
    + row({ id: "11", title: "Cakes &amp; Ale", author: "Ada &amp; Grace" }),
  ), NOW);
  assert.deepEqual(books.map((book) => book.title), ["A Clash of Kings", "Cakes & Ale"]);
  assert.equal(books[1].author, "Ada & Grace");
  assert.equal(books[0].url, "https://www.goodreads.com/book/show/10572");
  assert.equal(books[0].status, "reading");
  // No date and no rating are available for a current read, so neither is invented.
  assert.equal(books[0].at, null);
  assert.equal(books[0].rating, 0);
  assert.equal(JSON.stringify(books).includes("private notes"), false);
});

test("a profile with no currently-reading block yields nothing", () => {
  assert.deepEqual(booksFromProfile("<html><body>no shelf here</body></html>", NOW), []);
  assert.deepEqual(booksFromProfile(SIGN_IN, NOW), []);
});

test("a row without a usable book id is dropped", () => {
  const books = booksFromProfile(profileHtml(
    `<div class="Updates"><a class="bookTitle" href="/book/show/nope">No id</a></div>`
    + row({ id: "7", title: "Kept" }),
  ), NOW);
  assert.deepEqual(books.map((book) => book.title), ["Kept"]);
});

test("the avatar comes from the same page, and only from Goodreads", () => {
  assert.equal(pictureFromProfile(profileHtml("")), "https://images.gr-assets.com/users/1234p5/99.jpg");
  assert.equal(pictureFromProfile(`<meta property="og:image" content="https://evil.example/x.jpg">`), "");
});

test("the feed stores titles and drops anything not configured", async () => {
  const store = env([{ id: "personal", label: "Personal", userId: "12345678" }]);
  const urls: string[] = [];
  const snapshot = await refresh(store, goodreadsProvider, async (input) => {
    urls.push(String(input));
    return new Response(profileHtml(row({ id: "11", title: "Still going", author: "Ada &amp; Grace" })));
  }, NOW);
  // One request per account now, not three: the profile carries the books and
  // the avatar, and the two shelf feeds are gone.
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/user\/show\/12345678$/);
  const body = snapshot as { profileUrl: string; profilePicture: string; activity: Array<{ label: string; value: string }> };
  assert.equal(body.profileUrl, "https://www.goodreads.com/user/show/12345678");
  assert.equal(body.activity.length, 1);
  assert.equal(body.activity[0].label, "Still going");
  assert.match(body.activity[0].value, /^Reading/);
  assert.equal(body.profilePicture, "https://images.gr-assets.com/users/1234p5/99.jpg");
  assert.equal(JSON.stringify(snapshot).includes("private notes"), false);
  const cached = JSON.parse(await store.FEED.get("goodreads") || "{}") as { books: Array<{ accountId?: string }> };
  assert.equal(cached.books[0].accountId, "personal");
  const published = toPublicGoodreads({ books: [{ title: "Nope" }] }, goodreadsAccounts(store));
  assert.deepEqual(published && published.activity, []);
});

test("a sign-in page is an error, not an empty shelf", async () => {
  const store = env([{ id: "personal", label: "Personal", userId: "12345678" }]);
  // Goodreads answers a signed-out shelf request by redirecting to sign-in.
  // Treating that as "no books" would quietly empty the block, so load throws
  // and index.ts keeps the last good section instead.
  await assert.rejects(
    () => refresh(store, goodreadsProvider, async () => new Response(SIGN_IN), NOW),
    /not a profile page/,
  );
});

test("a block-shaped cache is not published unfiltered", () => {
  const poisoned = {
    label: "Reading",
    profileUrl: "https://www.goodreads.com/user/show/1",
    profilePicture: "",
    summary: "",
    activity: [{ label: "Injected", value: "Reading", url: "https://example.com/" }],
    updatedAt: null,
  };
  assert.equal(toPublicGoodreads(poisoned, [{ id: "main", userId: "1", label: "Me" } as never]), null);
});

test("the newest book is featured with its cover, author and rating", () => {
  const block = toPublicGoodreads({
    updatedAt: "2026-10-09T12:00:00Z",
    books: [
      { accountId: "personal", title: "Finished recently", author: "Ada & Grace", status: "finished", at: "2026-10-07T00:00:00Z", rating: 4, url: "https://www.goodreads.com/book/show/11", cover: "https://i.gr-assets.com/images/cover._SY475_.jpg" },
      { accountId: "personal", title: "Older", author: "Old", status: "finished", at: "2026-08-18T00:00:00Z", rating: 5, url: "https://www.goodreads.com/book/show/12", cover: "https://evil.example/x.jpg" },
    ],
  }, [{ id: "personal", label: "Personal", userId: "1" }]);
  assert.equal(block?.featured?.heading, "Latest finished");
  assert.equal(block?.featured?.title, "Finished recently");
  assert.equal(block?.featured?.subtitle, "Ada & Grace");
  assert.equal(block?.featured?.image, "https://i.gr-assets.com/images/cover._SY475_.jpg");
  assert.deepEqual(block?.featured?.details, ["Finished · 7 Oct", "★★★★☆"]);
});

test("only a Goodreads cover is kept, and a no-photo placeholder is dropped", () => {
  // The profile gives one cover per row, so there is no large/medium choice to
  // make any more. What still matters is that the host is checked.
  const [book] = booksFromProfile(profileHtml(
    row({ id: "21", title: "Big", cover: "https://i.gr-assets.com/l.jpg" }),
  ), NOW);
  assert.equal(book.cover, "https://i.gr-assets.com/l.jpg");
  const [offsite] = booksFromProfile(profileHtml(
    row({ id: "22", title: "Elsewhere", cover: "https://evil.example/x.jpg" }),
  ), NOW);
  assert.equal(offsite.cover, "");
  const block = toPublicGoodreads({ books: [{ ...book, accountId: "personal", cover: "https://s.gr-assets.com/assets/nophoto/book/111x148.png" }] }, [{ id: "personal", label: "P", userId: "1" }]);
  assert.equal(block?.featured?.heading, "Currently reading");
  assert.equal(block?.featured?.image, "");
});
