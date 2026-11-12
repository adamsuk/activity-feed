# Progressive release (canary deploy and automatic rollback)

`.github/workflows/deploy.yml` no longer sends a new build to all traffic at once. After the
maintainer approves the `production` environment, the deploy job does this, using
`scripts/gradual-deploy.sh` and the same digest-verified bundle as before:

1. Record the stable version: the version with most traffic in the newest deployment
   (`wrangler deployments list --json`).
2. `wrangler versions upload --no-bundle bundle/index.js`. The new version gets no traffic. The
   version id is read from wrangler's `WRANGLER_OUTPUT_FILE_PATH` file (`version-upload`
   entry) and checked against a UUID pattern.
3. Canary: `wrangler versions deploy <new>@10 <stable>@90`. The percentage is `CANARY_PERCENT`
   in the workflow `env` (1 to 99, default 10).
4. **Guardrail: canary health.** 20 requests, 3 seconds apart, to
   `https://activities.sradams.co.uk/feed.json`, each pinned to the new version with the
   `Cloudflare-Workers-Version-Overrides: activity-feed="<new>"` header. A probe fails unless
   it returns HTTP 200 and a JSON object. More than 10% failed probes breaches the guardrail
   (`GUARDRAIL_REQUESTS`, `GUARDRAIL_INTERVAL_SECONDS`, `GUARDRAIL_MAX_ERROR_PERCENT`). It is a
   smoke check: the feed answers from KV, so it proves the version starts and serves, not that
   every upstream source works.
5. **Rollback to the stable version.** Runs when the canary step ran, including a canary step that
   failed or timed out after traffic was split, and the guardrail did not pass (failed,
   cancelled or never ran): `wrangler versions deploy <stable>@100`, then it
   fails the job so the run is red.
6. Promote: `wrangler deploy --no-bundle bundle/index.js` of the same bundle, to 100%. A full
   deploy also applies the cron trigger (`*/30 * * * *`) and vars from `wrangler.toml`
   (`versions upload` alone changes neither triggers nor routes). `keep_vars = true` keeps
   dashboard vars; secrets are never deleted. This uploads a second version with identical code.

The Worker must already exist. A brand-new Worker has no deployments, and Cloudflare answers
the deployments lookup with a worker-not-found error (10007) that this workflow treats as fatal,
so bootstrap it once with a plain `npx wrangler deploy` first. A Worker that exists but has an
empty deployment list has no stable version, so steps 3 to 5 are skipped and the bundle goes
straight to 100% (step 6); there is nothing to roll back to.

## Cloudflare settings the maintainer must apply

- **API token** (GitHub secret `CF_API_TOKEN`, environment `production`): account permission
  **Workers Scripts: Edit**, which `wrangler deploy` already needs. The versions and
  deployments APIs are expected to use the same permission. This is not confirmed; if the first
  run reports a 403, add the permission it names.
- **No dashboard toggle** is needed for gradual deployments on a Worker. The custom domain
  `activities.sradams.co.uk` must stay attached to the `activity-feed` Worker, as now.
- Optional: enable Workers Logs or Observability on `activity-feed` to confirm which version
  served the canary requests.

Rollback by hand: `npx wrangler rollback`, or `npx wrangler versions deploy <id>@100`.

## Line repo Pages deploy is unchanged

The line repo's Cloudflare Pages deploy stays `deploy=release` under the human gate. This
change covers only the activity-feed Worker.

## Unverified until the first real run

Only the maintainer's `production` approval can run this workflow. Not yet verified against
Cloudflare: the exact `deployments list --json` shape on a live Worker (checked only against
wrangler's source), the token permission above, the override header taking effect on the custom
domain, YAML anchor support for the shared `env` in GitHub Actions, and `wrangler deploy` after a
canary on the same Worker. Watch the first run.

Tracking issue: adamsuk/software-factory#308.
