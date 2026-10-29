import assert from "node:assert/strict";
import test from "node:test";
import { booksFromProfile, goodreadsAccounts, goodreadsProvider, pictureFromProfile, statusUpdatesFromPage, toPublicGoodreads } from "./goodreads.ts";
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
  // Two requests per account: the profile carries the books and the avatar,
  // the status page carries the progress posts (#23).
  assert.equal(urls.length, 2);
  assert.match(urls[0], /\/user\/show\/12345678$/);
  assert.match(urls[1], /\/user_status\/list\/12345678$/);
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

/** One post on /user_status/list, shaped as Goodreads sends it. */
function statusRow(fields: { id: string; book: string; header: string; stamp: string; body?: string }): string {
  return `<div id="user_status_${fields.id}">
  <a class="leftAlignedImage" href="/user/show/1-me"><img src="https://images.gr-assets.com/users/1p1/1.jpg" /></a>
  <div class="left">
    <span class="uitext greyText inlineblock stacked user_status_header">
      <a href="/user/show/1-me">Me</a>
      ${fields.header} <a href="https://www.goodreads.com/book/show/${fields.book}.Slug" rel="nofollow noopener">Cakes &amp; Ale</a>
    </span>
    <div class="readable body">${fields.body ?? ""}</div>
    <span class="greyText uitext smallText">&mdash; <a class="greyText" href="/user_status/show/${fields.id}">${fields.stamp}</a></span>
  </div>
  <div class="left bookCover"><a href="/book/show/${fields.book}"><img src="https://i.gr-assets.com/images/S/books/${fields.book}._SY75_.jpg" /></a></div>
</div>`;
}

test("status updates are read off the public page, without the free-text note", () => {
  const updates = statusUpdatesFromPage(
    statusRow({ id: "2", book: "11", header: "is on page 469 of 1009 of", stamp: "Sep 02, 2026 05:28AM", body: "private notes nobody asked to publish" })
    + statusRow({ id: "1", book: "12", header: "is 45% done with", stamp: "Aug 30, 2026 11:05PM" })
    + statusRow({ id: "3", book: "nope", header: "is on page 1 of" , stamp: "Aug 01, 2026 01:00AM" }),
  );
  assert.deepEqual(updates.map((update) => [update.title, update.progress, update.at, update.status]), [
    ["Cakes & Ale", "Page 469 of 1009", "2026-09-02T05:28:00.000Z", "update"],
    ["Cakes & Ale", "45% done", "2026-08-30T23:05:00.000Z", "update"],
  ]);
  assert.equal(updates[0].url, "https://www.goodreads.com/book/show/11");
  assert.equal(updates[0].cover, "https://i.gr-assets.com/images/S/books/11._SY75_.jpg");
  assert.equal(JSON.stringify(updates).includes("private notes"), false);
  assert.deepEqual(statusUpdatesFromPage("<html>no posts</html>"), []);
  // The last post is followed by the page footer, whose images must not become its cover.
  const [last] = statusUpdatesFromPage(
    statusRow({ id: "9", book: "13", header: "is on page 5 of", stamp: "Sep 02, 2026 05:28AM" })
    + `<footer><img src="https://s.gr-assets.com/assets/logo.svg" /></footer>`,
  );
  assert.equal(last.cover, "https://i.gr-assets.com/images/S/books/13._SY75_.jpg");
});

test("updates join the reading list, and the featured card stays a book", async () => {
  const store = env([{ id: "personal", label: "Personal", userId: "12345678" }]);
  const snapshot = await refresh(store, goodreadsProvider, async (input) => {
    if (String(input).includes("/user_status/")) {
      return new Response(statusRow({ id: "2", book: "11", header: "is on page 469 of 1009 of", stamp: "Oct 08, 2026 05:28AM" }));
    }
    return new Response(profileHtml(row({ id: "11", title: "Still going" })));
  }, NOW) as { activity: Array<{ label: string; value: string }>; featured?: { heading: string; title: string } };
  assert.deepEqual(snapshot.activity.map((item) => item.value), ["Page 469 of 1009 · 8 Oct", "Reading"]);
  assert.equal(snapshot.featured?.heading, "Currently reading");
  assert.equal(snapshot.featured?.title, "Still going");
});

test("a failing status page does not cost the reading list", async () => {
  const store = env([{ id: "personal", label: "Personal", userId: "12345678" }]);
  const snapshot = await refresh(store, goodreadsProvider, async (input) => {
    if (String(input).includes("/user_status/")) return new Response("nope", { status: 500 });
    return new Response(profileHtml(row({ id: "11", title: "Still going" })));
  }, NOW) as { activity: Array<{ label: string }> };
  assert.deepEqual(snapshot.activity.map((item) => item.label), ["Still going"]);
});
