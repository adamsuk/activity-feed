# Activity feed

A Cloudflare Worker that reads your Intervals.icu activities and publishes a short cache at `/feed.json` for sradams.co.uk.

Connect Garmin in Intervals.icu, not Strava. The homepage never sees the API key. The cache has sport, distance, moving time, climb, and a link. It drops GPS, heart rate, and private activities.

## Secret

The only secret is `INTERVALS_API_KEY` (Intervals.icu → Settings → Developer). Set it on the worker. Do not put it in git or in the homepage.

A cron refreshes the cache every half hour. `/` redirects to `/feed.json`.

The homepage should fetch `https://activities.sradams.co.uk/feed.json`.
