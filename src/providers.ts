import { githubProvider } from "./github.ts";
import { goodreadsProvider } from "./goodreads.ts";
import { intervalsProvider } from "./intervals.ts";
import { lastfmProvider } from "./lastfm.ts";
import type { Provider } from "./provider.ts";

export const providers: Provider[] = [githubProvider, intervalsProvider, goodreadsProvider, lastfmProvider];
