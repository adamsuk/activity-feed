import { githubProvider } from "./github.ts";
import { intervalsProvider } from "./intervals.ts";
import type { Provider } from "./provider.ts";

export const providers: Provider[] = [intervalsProvider, githubProvider];
