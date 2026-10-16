import assert from "node:assert/strict";
import test from "node:test";
import { GOODREADS_PICTURE, toPublicGoodreads } from "./goodreads.ts";
import { INTERVALS_PICTURE, toPublicIntervals } from "./intervals.ts";
import { sourceBlock } from "./source.ts";

test("goodreads uses the raw profile image when the scrape finds none", () => {
  const block = toPublicGoodreads({ books: [], profilePicture: "" }, [{ id: "main", userId: "1", label: "Me" } as never]);
  assert.equal(block?.profilePicture, GOODREADS_PICTURE);
  assert.equal(block?.fallbackPicture, undefined);
});

test("goodreads keeps a scraped profile image", () => {
  const scraped = "https://images.gr-assets.com/users/1p8/1.jpg";
  const block = toPublicGoodreads({ books: [], profilePicture: scraped }, [{ id: "main", userId: "1", label: "Me" } as never]);
  assert.equal(block?.profilePicture, scraped);
});

test("intervals publishes the raw profile image and is not the fallback", () => {
  const block = toPublicIntervals({ source: "intervals", updatedAt: null, stale: false, activities: [] });
  assert.equal(block?.profilePicture, INTERVALS_PICTURE);
  assert.equal(block?.fallbackPicture, undefined);
});

test("only a literal true fallback flag survives a cached block", () => {
  const base = { label: "X", activity: [] };
  assert.equal(sourceBlock({ ...base, fallbackPicture: true })?.fallbackPicture, true);
  assert.equal(sourceBlock({ ...base, fallbackPicture: "yes" })?.fallbackPicture, undefined);
});
