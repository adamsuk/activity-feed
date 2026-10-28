import { sanitizeFeatured, type Featured } from "./featured.ts";
import type { Provider } from "./provider.ts";
import type { SourceBlock } from "./source.ts";
import type { Env } from "./types.ts";

// The read shelf and its week window are gone with the RSS feed: Goodreads
// only exposes currently-reading anonymously now. See booksFromProfile.

export type GoodreadsAccount = {
  id: string;
  label: string;
  userId: string;
};

export type GoodreadsBook = {
  title: string;
  author: string;
  status: "reading" | "finished";
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

function bookValue(status: "reading" | "finished", at: string | null): string {
  const when = at && Number.isFinite(Date.parse(at))
    ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" }).format(Date.parse(at))
    : "";
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

function featuredBook(book: Record<string, unknown>, title: string, url: string, status: string, at: string | null): Featured | null {
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
    details: [bookValue(status as "reading" | "finished", at), rating ? `${"★".repeat(rating)}${"☆".repeat(5 - rating)}` : ""],
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
    const status = book.status === "reading" ? "reading" : book.status === "finished" ? "finished" : "";
    if (!status) continue;
    const at = typeof book.at === "string" ? book.at : null;
    const account = showLabel ? labels.get(accountId) : "";
    if (!featured) featured = featuredBook(book, title, url, status, at);
    activity.push({
      label: account ? `${account} · ${title}` : title,
      value: bookValue(status, at),
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
    // One request per account now, not three: the profile page carries the
    // books and the avatar, and the two shelf feeds it used to read are gone.
    let picture = "";
    for (const [index, account] of accounts.entries()) {
      const html = await profile(account.userId, fetchImpl);
      if (index === 0) picture = pictureFromProfile(html);
      const rows = dedupe(booksFromProfile(html, now)).slice(0, 20);
      for (const { bookId: _bookId, ...book } of rows) {
        books.push({ ...book, accountId: account.id });
      }
    }
    books.sort((left, right) => (right.at || "").localeCompare(left.at || ""));
    return {
      updatedAt: new Date(now).toISOString(),
      stale: false,
      profilePicture: picture,
      books: books.slice(0, 20),
    };
  },
  publish(env, value) {
    return toPublicGoodreads(value, goodreadsAccounts(env));
  },
};
