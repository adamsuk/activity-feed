import { sanitizeFeatured, type Featured } from "./featured.ts";
import type { Provider } from "./provider.ts";
import type { SourceBlock } from "./source.ts";
import type { Env } from "./types.ts";

// The read shelf and its week window are gone with the RSS feed: Goodreads
// only exposes currently-reading anonymously now. See booksFromProfile. The
// public "Recent Status Updates" page is still anonymous, so progress posts
// ("on page 469 of 1009") come from there. See statusUpdatesFromPage.

export type GoodreadsAccount = {
  id: string;
  label: string;
  userId: string;
};

export type GoodreadsBook = {
  title: string;
  author: string;
  status: "reading" | "finished" | "update";
  /** Only on an "update": what the post said, e.g. "Page 469 of 1009". */
  progress?: string;
  at: string | null;
  rating: number;
  url: string;
  cover: string;
  account?: string;
};

function clean(value: string, max: number): string {
  return value.replace(/[\u0000-\u001F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function decode(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    // Last, so an entity written &amp;lt; does not decode twice.
    .replace(/&amp;/g, "&");
}

function coverUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname.endsWith("gr-assets.com")) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function bookUrl(id: string): string {
  return /^\d{1,12}$/.test(id) ? `https://www.goodreads.com/book/show/${id}` : "";
}

export function goodreadsAccounts(env: Env): GoodreadsAccount[] {
  if (!env.GOODREADS_ACCOUNTS?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.GOODREADS_ACCOUNTS);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const accounts: GoodreadsAccount[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim().toLowerCase() : "";
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(id) || seen.has(id)) continue;
    const userId = typeof row.userId === "number" ? String(row.userId) : typeof row.userId === "string" ? row.userId.trim() : "";
    if (!/^\d{1,12}$/.test(userId)) continue;
    const label = clean(typeof row.label === "string" ? row.label : id, 40) || id;
    seen.add(id);
    accounts.push({ id, label, userId });
    if (accounts.length === 10) break;
  }
  return accounts;
}

type Parsed = GoodreadsBook & { bookId: string };

/** Text of the first `<a class="NAME" ...>text</a>` in a row. */
function anchorText(row: string, name: string): string {
  const match = row.match(new RegExp(`<a[^>]*class="${name}"[^>]*>([\\s\\S]*?)</a>`));
  return decode((match?.[1] ?? "").replace(/<[^>]+>/g, " ").trim());
}

/**
 * The books on the public profile's "currently reading" block.
 *
 * Goodreads ended anonymous access to /review/list and its list_rss feed, which
 * is what this provider used to read: every form of
 * `review/list_rss/<id>?shelf=...` now answers 404 with
 * `<error>Page not found</error>`, and /review/list redirects to /user/sign_in.
 * The profile page is still public, so currently-reading is still readable.
 *
 * The read shelf is not. Its dates and ratings live behind that sign-in, so
 * finished books have no source and this returns reading only. `status` keeps
 * both values because the publish side still renders a cached "finished" book.
 */
export function booksFromProfile(html: string, _now: number): Parsed[] {
  const start = html.indexOf('id="currentlyReadingReviews"');
  if (start === -1) return [];
  const block = html.slice(start, start + 20_000);
  const books: Parsed[] = [];
  for (const row of block.split('class="Updates').slice(1)) {
    const bookId = row.match(/\/book\/show\/(\d{1,12})/)?.[1] ?? "";
    const title = clean(anchorText(row, "bookTitle"), 180);
    if (!title || !bookUrl(bookId)) continue;
    books.push({
      bookId,
      title,
      author: clean(anchorText(row, "authorName"), 120),
      status: "reading",
      // The profile shows no date for a current read, so there is nothing
      // honest to put here. bookValue() renders a bare "Reading" for null.
      at: null,
      // Nor a rating: you rate a book when you finish it.
      rating: 0,
      url: bookUrl(bookId),
      cover: coverUrl(row.match(/src="(https:\/\/[^"]*gr-assets\.com\/[^"]+)"/)?.[1] ?? ""),
    });
    if (books.length === 20) break;
  }
  return books;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "Sep 02, 2026 05:28AM" as ISO. Goodreads gives no zone to a signed-out reader, so UTC. */
function statusTime(text: string): string | null {
  const match = text.match(/([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  if (month === -1) return null;
  const hour = (Number(match[4]) % 12) + (match[6].toUpperCase() === "PM" ? 12 : 0);
  const time = Date.UTC(Number(match[3]), month, Number(match[2]), hour, Number(match[5]));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** "on page 469 of 1009" or "45% done" out of a status header; nothing else is kept. */
function progressText(header: string): string {
  const page = header.match(/\bon page (\d{1,6})(?: of (\d{1,6}))?/i);
  if (page) return page[2] ? `Page ${page[1]} of ${page[2]}` : `Page ${page[1]}`;
  const percent = header.match(/\b(\d{1,3})% (?:done|complete)/i);
  return percent ? `${percent[1]}% done` : "";
}

/**
 * The reader's own status posts from /user_status/list/<id>, newest first.
 *
 * Like the profile this needs no sign-in. The free-text body of a post is not
 * read: the title, the progress and the time are all that is published.
 */
export function statusUpdatesFromPage(html: string): GoodreadsBook[] {
  const updates: GoodreadsBook[] = [];
  for (const row of html.split('<div id="user_status_').slice(1)) {
    const header = row.match(/class="[^"]*user_status_header[^"]*"[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? "";
    const link = header.match(/<a [^>]*href="https:\/\/www\.goodreads\.com\/book\/show\/(\d{1,12})[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const title = clean(decode(link[2].replace(/<[^>]+>/g, " ")), 180);
    const url = bookUrl(link[1]);
    if (!title || !url) continue;
    const stamp = row.match(/href="\/user_status\/show\/\d+">([^<]+)</)?.[1] ?? "";
    updates.push({
      title,
      author: "",
      status: "update",
      progress: progressText(decode(header.replace(/<[^>]+>/g, " "))),
      at: statusTime(stamp),
      rating: 0,
      url,
      cover: coverUrl(row.match(/class="[^"]*bookCover[^"]*"[\s\S]*?src="(https:\/\/[^"]*gr-assets\.com\/[^"]+)"/)?.[1] ?? ""),
    });
    if (updates.length === 10) break;
  }
  return updates;
}

/** The status updates page. Optional: a failure here must not cost the reading list. */
async function statusPage(userId: string, fetchImpl: typeof fetch): Promise<string> {
  try {
    const response = await fetchImpl(`https://www.goodreads.com/user_status/list/${userId}`, {
      headers: { "User-Agent": "sradams-activity-feed", Accept: "text/html" },
    });
    if (!response.ok) return "";
    return (await response.text()).slice(0, 400_000);
  } catch {
    return "";
  }
}

/** The public profile page, once. It carries the books and the avatar. */
async function profile(userId: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(`https://www.goodreads.com/user/show/${userId}`, {
    headers: { "User-Agent": "sradams-activity-feed", Accept: "text/html" },
  });
  if (!response.ok) throw new Error(`Goodreads profile failed (${response.status})`);
  const html = await response.text();
  // A signed-out /review/list redirects here, so check we got a profile and not
  // the sign-in page before reading books out of it.
  if (!html.includes('id="currentlyReadingReviews"') && !html.includes("og:image")) {
    throw new Error("Goodreads profile was not a profile page");
  }
  return html.slice(0, 400_000);
}

function dedupe(books: Parsed[]): Parsed[] {
  const seen = new Set<string>();
  const unique: Parsed[] = [];
  for (const book of books) {
    if (seen.has(book.bookId)) continue;
    seen.add(book.bookId);
    unique.push(book);
  }
  return unique;
}

function bookValue(status: GoodreadsBook["status"], at: string | null, progress = ""): string {
  const when = at && Number.isFinite(Date.parse(at))
    ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" }).format(Date.parse(at))
    : "";
  if (status === "update") {
    const text = progress || "Update";
    return when ? `${text} · ${when}` : text;
  }
  if (status === "reading") return when ? `Reading · ${when}` : "Reading";
  return when ? `Finished · ${when}` : "Finished";
}

/** Raw Goodreads image used when the profile scrape finds none; may change, so the site falls back to GitHub. */
export const GOODREADS_PICTURE = "https://images.gr-assets.com/users/1792145984p8/176915360.jpg";

/** The avatar, read from the profile HTML already fetched. */
export function pictureFromProfile(html: string): string {
  const match = html.match(/property="og:image" content="(https:\/\/images\.gr-assets\.com\/users\/[^"]+)"/);
  return match?.[1] ?? "";
}

function featuredBook(book: Record<string, unknown>, title: string, url: string, status: "reading" | "finished", at: string | null): Featured | null {
  const cover = typeof book.cover === "string" ? coverUrl(book.cover) : "";
  const rating = typeof book.rating === "number" && book.rating >= 1 && book.rating <= 5 ? book.rating : 0;
  return sanitizeFeatured({
    heading: status === "reading" ? "Currently reading" : "Latest finished",
    title,
    subtitle: typeof book.author === "string" ? book.author : "",
    description: "",
    url,
    // Goodreads' "no photo" placeholder is worse than the site's own fallback.
    image: cover.includes("/nophoto/") ? "" : cover,
    details: [bookValue(status, at), rating ? `${"★".repeat(rating)}${"☆".repeat(5 - rating)}` : ""],
  });
}

export function toPublicGoodreads(value: unknown, accounts: GoodreadsAccount[]): SourceBlock | null {
  if (accounts.length === 0 || !value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  // Only the raw cached shape is trusted: it is re-filtered against the allowlist.
  if (!Array.isArray(row.books)) return null;
  const labels = new Map(accounts.map((account) => [account.id, account.label]));
  const showLabel = accounts.length > 1;
  const activity: SourceBlock["activity"] = [];
  let featured: Featured | null = null;
  for (const item of row.books) {
    if (!item || typeof item !== "object") continue;
    const book = item as Record<string, unknown>;
    const accountId = typeof book.accountId === "string" ? book.accountId : "";
    if (!labels.has(accountId)) continue;
    const title = typeof book.title === "string" ? clean(book.title, 180) : "";
    const url = typeof book.url === "string" ? book.url : "";
    if (!title || !url.startsWith("https://www.goodreads.com/book/show/")) continue;
    const status = book.status === "reading" || book.status === "finished" || book.status === "update" ? book.status : "";
    if (!status) continue;
    const at = typeof book.at === "string" ? book.at : null;
    const account = showLabel ? labels.get(accountId) : "";
    if (!featured && status !== "update") featured = featuredBook(book, title, url, status, at);
    const progress = typeof book.progress === "string" ? clean(book.progress, 40) : "";
    activity.push({
      label: account ? `${account} · ${title}` : title,
      value: bookValue(status, at, progress),
      url,
    });
    if (activity.length === 20) break;
  }
  const picture = typeof row.profilePicture === "string" ? row.profilePicture : "";
  return {
    label: "Reading",
    profileUrl: `https://www.goodreads.com/user/show/${accounts[0].userId}`,
    profilePicture: picture.startsWith("https://images.gr-assets.com/users/") ? picture : GOODREADS_PICTURE,
    summary: "",
    activity,
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    ...(featured ? { featured } : {}),
  };
}

export const goodreadsProvider: Provider = {
  id: "goodreads",
  enabled(env) {
    return goodreadsAccounts(env).length > 0;
  },
  async load(env, fetchImpl, now = Date.now()) {
    const accounts = goodreadsAccounts(env);
    const books: Array<GoodreadsBook & { accountId: string }> = [];
    // Two requests per account: the profile carries the current reads and the
    // avatar, the status page carries the progress posts.
    let picture = "";
    for (const [index, account] of accounts.entries()) {
      const html = await profile(account.userId, fetchImpl);
      if (index === 0) picture = pictureFromProfile(html);
      const rows = dedupe(booksFromProfile(html, now)).slice(0, 20);
      for (const { bookId: _bookId, ...book } of rows) {
        books.push({ ...book, accountId: account.id });
      }
      for (const update of statusUpdatesFromPage(await statusPage(account.userId, fetchImpl))) {
        books.push({ ...update, accountId: account.id });
      }
    }
    // Updates are dated and current reads are not, so a plain date sort and cap
    // would let updates push every current read out. Current reads keep their
    // places first; updates fill what is left.
    const reads = books.filter((book) => book.status !== "update").slice(0, 20);
    const updates = books.filter((book) => book.status === "update").slice(0, 20 - reads.length);
    const kept = [...reads, ...updates];
    kept.sort((left, right) => (right.at || "").localeCompare(left.at || ""));
    return {
      updatedAt: new Date(now).toISOString(),
      stale: false,
      profilePicture: picture,
      books: kept,
    };
  },
  publish(env, value) {
    return toPublicGoodreads(value, goodreadsAccounts(env));
  },
};
