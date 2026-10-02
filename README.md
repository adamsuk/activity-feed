# Strava feed

A Cloudflare Worker that logs you in with Strava, keeps the refresh token in KV, and publishes a short activity cache at `/feed.json` for sradams.co.uk.

The homepage never sees a token. The cache has sport, distance, moving time, climb, a place name, and a Strava link. It drops GPS, heart rate, and private activities.

## Access

Put Cloudflare Access on the worker hostname. Bypass **only** `GET /feed.json`. Everything else — the login page, `/oauth/start`, and `/oauth/callback` — stays behind Access.

`/feed.json` has to stay public. The static homepage fetches it from the browser, and Access would turn that request into a login wall.

## Deploy

Use one of your existing Strava API apps. Set its Authorization Callback Domain to the worker hostname, with no path.

```bash
npx wrangler kv namespace create FEED
```

Paste the KV id into `wrangler.toml`. `STRAVA_CLIENT_ID` is already a plain var there. Then:

```bash
npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler deploy
```

Attach the hostname (for example `activities.sradams.co.uk`), turn Access on with the `/feed.json` bypass, then open the worker and choose **Log in with Strava**. Approve `activity:read`. A cron refreshes the cache every half hour. **Refresh now** on the login page does it immediately.

The homepage should fetch `https://<worker-host>/feed.json`.
