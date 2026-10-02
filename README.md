# Activity feed

A Cloudflare Worker that reads your Intervals.icu activities and publishes a short cache at `/feed.json` for sradams.co.uk.

Connect Garmin in Intervals.icu, not Strava. The homepage never sees the API key. The cache has sport, distance, moving time, climb, and a link. It drops GPS, heart rate, and private activities.

## Access

Cloudflare Access is on `activities.sradams.co.uk`. Bypass **only** `GET /feed.json`. The key form and refresh stay behind Access.

`/feed.json` has to stay public. The static homepage fetches it from the browser.

## Use

Open the worker hostname, paste the key from Intervals.icu → Settings → Developer, and save it. A cron refreshes the cache every half hour. **Refresh now** does it immediately.

The homepage should fetch `https://activities.sradams.co.uk/feed.json`.
