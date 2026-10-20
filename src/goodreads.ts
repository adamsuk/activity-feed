import { sanitizeFeatured, type Featured } from "./featured.ts";
import type { Provider } from "./provider.ts";
import type { SourceBlock } from "./source.ts";
import type { Env } from "./types.ts";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SHELVES = ["read", "currently-reading"] as const;

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
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, "\"")
    .replace(/'/g, "'")
    .replace(/&/g, "&");
}

function tag(item: string, name: string): string {
  const match = item.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</${name}>`));
  return decode((match?.[1] ?? match?.[2] ?? "").trim());
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

export function booksFromRss(xml: string, shelf: "read" | "currently-reading", now: number): Parsed[] {
  const since = now - WEEK_MS;
  const reading: Parsed[] = [];
  const finished: Array<Parsed & { readAt: number }> = [];
  for (const item of xml.split("<item>").slice(1)) {
    const body = item.split("</item>")[0];
    const title = clean(tag(body, "title"), 180);
    const bookId = tag(body, "book_id");
    if (!title || !bookUrl(bookId)) continue;
    const readAt = Date.parse(tag(body, "user_read_at"));
    const addedAt = Date.parse(tag(body, "user_date_added"));
    const rating = Number(tag(body, "user_rating"));
    const book: Parsed = {
      bookId,
      title,
      author: clean(tag(body, "author_name"), 120),
      status: shelf === "read" ? "finished" : "reading",
      at: null,
      rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : 0,
      url: bookUrl(bookId),
      cover: coverUrl(tag(body, "book_large_image_url")) || coverUrl(tag(body, "book_medium_image_url")),
    };
    if (shelf === "currently-reading") {
      book.at = Number.isFinite(addedAt) ? new Date(addedAt).toISOString() : null;
      reading.push(book);
      continue;
    }
    if (!Number.isFinite(readAt)) continue;
    book.at = new Date(readAt).toISOString();
    finished.push({ ...book, readAt });
  }
  if (shelf === "currently-reading") return reading;
  finished.sort((left, right) => right.readAt - left.readAt);
  return finished
    .filter((book, index) => index === 0 || book.readAt >= since)
    .map(({ readAt: _readAt, ...book }) => book);
}

async function shelf(
  userId: string,
  name: "read" | "currently-reading",
  fetchImpl: typeof fetch,
  now: number,
): Promise<Parsed[]> {
  const url = new URL("https://www.goodreads.com/review/list_rss/" + userId);
  url.searchParams.set("shelf", name);
  url.searchParams.set("per_page", "50");
  url.searchParams.set("sort", name === "read" ? "date_read" : "date_added");
  url.searchParams.set("order", "d");
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "sradams-activity-feed", Accept: "application/rss+xml, application/xml" },
  });
  if (!response.ok) throw new Error(`Goodreads ${name} failed (${response.status})`);
  const xml = await response.text();
  if (!xml.includes("<rss")) throw new Error(`Goodreads ${name} was not a feed`);
  return booksFromRss(xml, name, now);
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

async function profilePicture(userId: string, fetchImpl: typeof fetch): Promise<string> {
  try {
    const response = await fetchImpl(`https://www.goodreads.com/user/show/${userId}`, {
      headers: { "User-Agent": "sradams-activity-feed", Accept: "text/html" },
    });
    if (!response.ok) return "";
    const html = (await response.text()).slice(0, 100_000);
    const match = html.match(/property="og:image" content="(https:\/\/images\.gr-assets\.com\/users\/[^"]+)"/);
    return match?.[1] ?? "";
  } catch {
    return "";
  }
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
    for (const account of accounts) {
      const finished = await shelf(account.userId, "read", fetchImpl, now);
      const reading = await shelf(account.userId, "currently-reading", fetchImpl, now);
      const rows = dedupe([...finished, ...reading]).slice(0, 20);
      for (const { bookId: _bookId, ...book } of rows) {
        books.push({ ...book, accountId: account.id });
      }
    }
    books.sort((left, right) => (right.at || "").localeCompare(left.at || ""));
    const first = accounts[0];
    return {
      updatedAt: new Date(now).toISOString(),
      stale: false,
      profilePicture: first ? await profilePicture(first.userId, fetchImpl) : "",
      books: books.slice(0, 20),
    };
  },
  publish(env, value) {
    return toPublicGoodreads(value, goodreadsAccounts(env));
  },
};
