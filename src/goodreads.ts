import type { Provider } from "./provider.ts";
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
  const books: Parsed[] = [];
  for (const item of xml.split("<item>").slice(1)) {
    const body = item.split("</item>")[0];
    const title = clean(tag(body, "title"), 180);
    const bookId = tag(body, "book_id");
    if (!title || !bookUrl(bookId)) continue;
    const readAt = Date.parse(tag(body, "user_read_at"));
    const addedAt = Date.parse(tag(body, "user_date_added"));
    const finished = shelf === "read" && Number.isFinite(readAt) && readAt >= since;
    const reading = shelf === "currently-reading";
    if (!finished && !reading) continue;
    const when = finished ? readAt : (Number.isFinite(addedAt) ? addedAt : Number.NaN);
    const rating = Number(tag(body, "user_rating"));
    books.push({
      bookId,
      title,
      author: clean(tag(body, "author_name"), 120),
      status: finished ? "finished" : "reading",
      at: Number.isFinite(when) ? new Date(when).toISOString() : null,
      rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : 0,
      url: bookUrl(bookId),
      cover: coverUrl(tag(body, "book_medium_image_url")),
    });
  }
  return books;
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

export function toPublicGoodreads(value: unknown, accounts: GoodreadsAccount[]): Record<string, unknown> | null {
  if (accounts.length === 0 || !value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.books)) return null;
  const labels = new Map(accounts.map((account) => [account.id, account.label]));
  const showLabel = accounts.length > 1;
  const books: GoodreadsBook[] = [];
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
    const rating = typeof book.rating === "number" ? book.rating : 0;
    const published: GoodreadsBook = {
      title,
      author: typeof book.author === "string" ? clean(book.author, 120) : "",
      status,
      at: typeof book.at === "string" ? book.at : null,
      rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : 0,
      url,
      cover: typeof book.cover === "string" ? coverUrl(book.cover) : "",
    };
    if (showLabel) published.account = labels.get(accountId);
    books.push(published);
  }
  return {
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
    stale: row.stale === true,
    books: books.slice(0, 20),
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
    return {
      updatedAt: new Date(now).toISOString(),
      stale: false,
      books: books.slice(0, 20),
    };
  },
  publish(env, value) {
    return toPublicGoodreads(value, goodreadsAccounts(env));
  },
};
