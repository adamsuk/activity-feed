# Activity feed

A Cloudflare Worker that publishes one cache at `/feed.json` for sradams.co.uk. The homepage only talks to this worker. It never calls Intervals.icu or GitHub, and it never sees a token.

Each provider is a list of accounts. Personal, work, and any further account are entries in that list. Usernames are worker variables. Tokens are worker secrets. Nothing in the code names an account.

Training activities come from Intervals.icu. The cache has sport, distance, moving time, climb, and a link. It drops GPS, heart rate, and private activities. When more than one Intervals account is configured, each row is labelled with that account.

GitHub is the last seven days. The cache stores counts only: contributions, commits, pull requests, reviews, and issues. It does not store repository names or commit messages.

## Accounts

`GITHUB_ACCOUNTS` is a plain variable, a JSON array:

```json
[
  {"id":"personal","label":"Personal","login":"your-user"},
  {"id":"work","label":"Work","login":"your-work-user"}
]
```

The secret for an id is `GITHUB_TOKEN_<ID>` in uppercase, with hyphens turned into underscores. `personal` is `GITHUB_TOKEN_PERSONAL`. `work` is `GITHUB_TOKEN_WORK`. A third account `{"id":"lab","label":"Lab","login":"another-user"}` needs `GITHUB_TOKEN_LAB`.

Without a token the worker uses that login's public contribution graph. A token is what adds that account's private commits, pull requests, and reviews. GitHub only does that for the account the token belongs to. A fine-grained token with read access to the repositories is enough. Do not grant write, administration, or workflows.

Intervals already uses `INTERVALS_API_KEY` for one account. Leave it. To add another, set `INTERVALS_ACCOUNTS` to a JSON array and add `INTERVALS_API_KEY_<ID>` for each extra id. The id `personal` keeps using `INTERVALS_API_KEY` if `INTERVALS_API_KEY_PERSONAL` is not set.

```json
[
  {"id":"personal","label":"Personal"},
  {"id":"work","label":"Work"}
]
```

Do not put tokens in git or in the homepage.

A cron refreshes the cache every half hour. `/` redirects to `/feed.json`.

The homepage should fetch `https://activities.sradams.co.uk/feed.json`.
