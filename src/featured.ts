/**
 * One optional "featured" card per source. The homepage renders it next to the cycled
 * metrics without knowing which source it came from, so every field is generic.
 */
export type FeaturedRoute = {
  /** SVG viewBox width and height. Points are already projected and scaled into it. */
  width: number;
  height: number;
  points: Array<[number, number]>;
};

export type Featured = {
  /** Short label above the card, for example "Latest PR". */
  heading: string;
  title: string;
  subtitle: string;
  description: string;
  url: string;
  /** https image, or "" when there is none. */
  image: string;
  details: string[];
  /** A simplified, shape-only route. No coordinates are published. */
  route?: FeaturedRoute;
  /** A secondary link, for example the top track under the top album. */
  link?: { label: string; detail: string; url: string };
  /** An embeddable YouTube video id. Only set when a YouTube key is configured. */
  video?: { youtubeId: string; title: string };
};

function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function httpsUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function route(value: unknown): FeaturedRoute | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const width = Number(row.width);
  const height = Number(row.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 1000 || height > 1000) {
    return undefined;
  }
  if (!Array.isArray(row.points)) return undefined;
  const points: Array<[number, number]> = [];
  for (const point of row.points) {
    if (!Array.isArray(point) || point.length !== 2) continue;
    const [x, y] = point.map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > width || y > height) continue;
    points.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    if (points.length === 300) break;
  }
  return points.length >= 2 ? { width, height, points } : undefined;
}

/** Re-checks a featured card from cache or a provider. Returns null when it has no title. */
export function sanitizeFeatured(value: unknown): Featured | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const title = clean(row.title, 160);
  if (!title) return null;
  const featured: Featured = {
    heading: clean(row.heading, 40),
    title,
    subtitle: clean(row.subtitle, 160),
    description: clean(row.description, 280),
    url: httpsUrl(row.url),
    image: httpsUrl(row.image),
    details: Array.isArray(row.details)
      ? row.details.map((detail) => clean(detail, 60)).filter(Boolean).slice(0, 4)
      : [],
  };
  const shape = route(row.route);
  if (shape) featured.route = shape;
  if (row.link && typeof row.link === "object") {
    const link = row.link as Record<string, unknown>;
    const label = clean(link.label, 160);
    if (label) featured.link = { label, detail: clean(link.detail, 120), url: httpsUrl(link.url) };
  }
  if (row.video && typeof row.video === "object") {
    const video = row.video as Record<string, unknown>;
    const id = typeof video.youtubeId === "string" ? video.youtubeId : "";
    if (/^[A-Za-z0-9_-]{11}$/.test(id)) featured.video = { youtubeId: id, title: clean(video.title, 160) };
  }
  return featured;
}

/** Plain text from a Markdown PR body: no code, images, links' URLs, headings or HTML. */
export function plainText(markdown: unknown, max = 240): string {
  if (typeof markdown !== "string") return "";
  const text = markdown
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    // "Closes #12" style keywords say nothing to a homepage reader.
    .replace(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[\w.-]+\/[\w.-]+)?#\d+\b[.,]?/gi, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const EARTH_M = 6_371_000;

function distanceM(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLng = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Turns GPS points into a small shape-only route. The first and last `trimM` metres are
 * dropped so the start and finish (often home) are not shown, then the points are
 * projected, scaled into a box and thinned. Nothing geographic is kept.
 */
export function routeFromLatLngs(latlngs: unknown, trimM = 250, size = 200, maxPoints = 150): FeaturedRoute | undefined {
  if (!Array.isArray(latlngs)) return undefined;
  const points: Array<[number, number]> = [];
  for (const item of latlngs) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const lat = Number(item[0]);
    const lng = Number(item[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    if (lat === 0 && lng === 0) continue;
    points.push([lat, lng]);
  }
  if (points.length < 2) return undefined;
  const along = [0];
  for (let index = 1; index < points.length; index += 1) {
    along.push(along[index - 1] + distanceM(points[index - 1], points[index]));
  }
  const total = along[along.length - 1];
  if (total < trimM * 2 + 200) return undefined;
  const kept = points.filter((_, index) => along[index] >= trimM && along[index] <= total - trimM);
  if (kept.length < 2) return undefined;
  const midLat = kept.reduce((sum, point) => sum + point[0], 0) / kept.length;
  const scaleX = Math.cos((midLat * Math.PI) / 180);
  const projected = kept.map(([lat, lng]) => [lng * scaleX, -lat] as [number, number]);
  const xs = projected.map((point) => point[0]);
  const ys = projected.map((point) => point[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX;
  const spanY = Math.max(...ys) - minY;
  const span = Math.max(spanX, spanY);
  if (!(span > 0)) return undefined;
  const pad = 8;
  const scale = (size - pad * 2) / span;
  const width = Math.max(40, Math.round(spanX * scale + pad * 2));
  const height = Math.max(40, Math.round(spanY * scale + pad * 2));
  const offX = (width - spanX * scale) / 2;
  const offY = (height - spanY * scale) / 2;
  const step = Math.max(1, Math.ceil(projected.length / maxPoints));
  const thinned = projected.filter((_, index) => index % step === 0 || index === projected.length - 1);
  return {
    width,
    height,
    points: thinned.map(([x, y]) => [
      Math.round(((x - minX) * scale + offX) * 10) / 10,
      Math.round(((y - minY) * scale + offY) * 10) / 10,
    ]),
  };
}
