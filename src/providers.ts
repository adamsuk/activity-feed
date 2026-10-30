import { githubProvider } from "./github.ts";
// import { goodreadsProvider } from "./goodreads.ts";
import { intervalsProvider } from "./intervals.ts";
import { lastfmProvider } from "./lastfm.ts";
import type { Provider } from "./provider.ts";

export const providers: Provider[] = [
  githubProvider,
  intervalsProvider,
  // TODO: Find a good replacement for Goodreads RSS feed endpoint, scrapping isn't cutting it
  // goodreadsProvider,
  lastfmProvider
];
