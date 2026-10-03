# Activity feed

A Cloudflare Worker that publishes one cache at `/feed.json` for sradams.co.uk. The homepage only talks to this worker. It never calls Intervals.icu or GitHub, and it never sees a token.

Training activities come from Intervals.icu (Garmin connected there, not Strava). The cache has sport, distance, moving time, climb, and a link. It drops GPS, heart rate, and private activities.

GitHub is the last seven days for two accounts: personal (`adamsuk`) and work (`sra405`). The cache stores counts only: contributions, commits, pull requests, reviews, and issues. It does not store repository names or commit messages.

## Secrets

Set these on the worker. Do not put them in git or in the homepage.

| Secret | What it is |
|---|---|
| `INTERVALS_API_KEY` | Intervals.icu → Settings → Developer |
| `GITHUB_TOKEN_PERSONAL` | Read-only token for `adamsuk` |
| `GITHUB_TOKEN_WORK` | Read-only token for `sra405` |

Without a GitHub token the worker uses that account's public contribution graph. A token for an account is what adds its private commits, pull requests, and reviews into those counts. GitHub only does that for the account the token belongs to, so one token cannot cover both. A fine-grained token with read access to the repositories is enough. Do not grant write, administration, or workflows.

A cron refreshes the cache every half hour. `/` redirects to `/feed.json`.

The homepage should fetch `https://activities.sradams.co.uk/feed.json`.
