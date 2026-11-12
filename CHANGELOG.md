# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 2026-10-26

### Fixed

- Last.fm profile picture is taken from the current `user.getInfo` image. When that image is missing or the request fails, `profilePicture` is empty so the site can use its GitHub fallback.

## [Unreleased]

## 2026-11-12 (block egress on every job)

### Changed

- Harden-Runner is now `egress-policy: block` with an `allowed-endpoints` list on the `Build` job of `deploy.yml` ([43241952589](https://github.com/adamsuk/activity-feed/actions/runs/43241952589)), the `test` job of `test.yml` ([43243398124](https://github.com/adamsuk/activity-feed/actions/runs/43243398124)) and both `Analyze` jobs of `codeql.yml` ([43243397896](https://github.com/adamsuk/activity-feed/actions/runs/43243397896)). No job is left in `audit` (adamsuk/software-factory#371).

## 2026-11-12 (prove the canary rollback)

### Added

- `src/gradual-deploy.test.ts` runs `scripts/gradual-deploy.sh rollback` against a stub `wrangler` and asserts `versions deploy <stable>@100` is called and the script exits non-zero.
- `deploy.yml` gains a `workflow_dispatch` trigger with one boolean input, `force_guardrail_failure` (default `false`), which makes the guardrail fail so the rollback can be proven live. Normal deploys on push to `main` are unchanged. `docs/progressive-release.md` explains how to run it.
- The forced-failure run happened on 2026-11-12 ([43242601767](https://github.com/adamsuk/activity-feed/actions/runs/43242601767)): the guardrail failed, the rollback restored the stable version at 100% and Promote was skipped. The run URL is recorded in `docs/progressive-release.md` (adamsuk/software-factory#352).

## 2026-11-12 (block egress on the Deploy job)

### Changed

- The `Deploy` job, which holds `CF_API_TOKEN`, now runs Harden-Runner with `egress-policy: block` and an allowlist of `activities.sradams.co.uk`, `api.cloudflare.com`, `github.com`, `registry.npmjs.org` and `sparrow.cloudflare.com` (all :443), taken from the recommended policy of run 43182552056, which includes the canary and guardrail steps. The `Build` job stays on `audit` until its own list is known (adamsuk/software-factory#354).

## 2026-11-12 (gradual deploy with automatic rollback)

### Changed

- The `deploy` job now uploads a version with no traffic, sends `CANARY_PERCENT` (10) of traffic to it, runs the "Guardrail: canary health" probes against the canary version, and rolls back to the stable version at 100% (failing the run) if the guardrail does not pass. Otherwise it promotes the same verified bundle with `wrangler deploy`. Build once, the digest check, the SHA-pinned actions and the scoped `CF_API_TOKEN` are unchanged. The mechanics are in `scripts/gradual-deploy.sh`; the Cloudflare settings and what is unverified are in `docs/progressive-release.md` (adamsuk/software-factory#308).
- The rollback also runs when the canary step itself fails or times out after traffic was split (it only skips when no canary was started); restoring the stable version at 100% is idempotent.
- The Worker must already exist: a brand-new Worker fails the deployments lookup (error 10007) by design, so bootstrap it once with a plain `wrangler deploy`.
- The line repo's Pages deploy stays `deploy=release` under the human gate.
- Not verified before merge: the workflow only runs on a push to `main` with the `production` environment approval.

## 2026-11-11 (build once, deploy the same bundle)

### Changed

- `deploy.yml` is split in two. A `build` job with no secrets and no environment runs the tests, bundles the worker once (`wrangler deploy --dry-run --outdir dist`, wrangler pinned to 4.154.0, published 2026-10-27, the newest 4.x release older than 14 days), records the sha256 of `index.js` as a job output and uploads it as the artifact `worker-bundle-<commit sha>`. The `deploy` job (`needs: build`, environment `production`, concurrency group `production`) downloads that artifact, re-verifies the sha256, then publishes it with `wrangler deploy --no-bundle`. It runs no project install, test or build, and is the only job that reads `CF_API_TOKEN`. Bindings, KV, cron triggers and vars still come from `wrangler.toml`. Tests in `src/workflows.test.ts` lock this shape (adamsuk/software-factory#313).
- Re-runs: the upload sets `overwrite: true`, so re-running the workflow on the same commit replaces the artifact. The deploy job still verifies the sha256 output of that same run's build job.
- Cloudflare settings: none needed. The deploy is an ordinary `wrangler deploy` of a prebuilt script with the same token, so no Cloudflare version or promote setting is involved.
- Roll back with `npx wrangler rollback` (or revert and push); the practised procedure is `docs/runbooks/rollback-pages-and-workers.md` in adamsuk/software-factory.
- Not verified before merge: the workflow only runs on a push to `main` with the `production` environment approval.

## 2026-11-11 (size label)

### Added

- `size-label.yml` calls the shared `adamsuk/gh-factory` size-label workflow, pinned to a full commit SHA, so every pull request is labelled `size/XS` to `size/XL` (adamsuk/software-factory#341).

## 2026-11-11 (pinned deploy actions)

### Security

- `deploy.yml` pins `actions/checkout`, `actions/setup-node` and `cloudflare/wrangler-action` to full commit SHAs (with a version comment) and declares `permissions: contents: read`. A retagged action can no longer run with `CF_API_TOKEN` in scope, and the job's `GITHUB_TOKEN` is read-only. A test fails if any `uses:` in `.github/workflows/` is not pinned to a 40-character SHA (adamsuk/software-factory#324).

## 2026-11-11 (merge queue ready)

### Changed

- The Changelog, CodeQL and Test workflows now also trigger on `merge_group`, so required checks report on a merge queue's temporary branch. Without this, enabling the queue would leave every required check pending and stall merges (adamsuk/software-factory#312).

## 2026-11-11

### Changed

- `.github/factory.yml` lists `test` in `required_checks`, so station 04 gates on the worker tests that `test.yml` now runs on pull requests. The `factory-main` ruleset requires the same check (adamsuk/software-factory#115).

## 2026-11-10

### Added

- `test.yml` runs the worker tests (`node --experimental-strip-types --test src/*.test.ts`) on every pull request and on every push to `main`. The job has a read-only token, uses no secret and cannot deploy. Until now the tests ran only inside the deploy job, after merge.
- `src/workflows.test.ts` fails if the test workflow gains a write permission or a secret, if the deploy stops being push-to-`main` only, or if any workflow other than `deploy.yml` uses the Cloudflare credential.

## 2026-11-03

### Changed

- `deploy.yml` and `codeql.yml` pin Harden-Runner (`egress-policy: audit`) as the first step of every job.
- The `deploy` job runs in the `production` GitHub Environment so a deploy can require a reviewer.
- The `deploy` job has a `production` concurrency group (`cancel-in-progress: false`) so a stale deploy waiting on approval cannot overwrite a newer one, and a running deploy is never cancelled.

### Added

- README rollback steps that bypass the environment approval.

## 2026-10-30 (goodreads)

### Removed

- Goodreads from the provider list so it's no longer in the active providers feeds output.


## 2026-10-29 (goodreads)

### Added

- Goodreads status updates (#23). Besides the currently-reading books, the
  provider reads the public `user_status/list/<id>` page and publishes each
  progress post ("Page 469 of 1009 · 2 Sep") in the Reading block. The post's
  free text is not read or stored. One extra request per account; if it fails
  the reading list is still published. Times on that page carry no zone for a
  signed-out reader, so they are taken as UTC.
- The featured card stays a book (currently reading); an update never replaces it.
- Updates fill the places left after the currently-reading books, newest first across accounts, so updates from several accounts can no longer push every current read out of the 20-row cap.

## 2026-10-28 (goodreads)

### Removed

- Finished books, their read dates and their star ratings. Those live on
  `/review/list?shelf=read`, which now needs a signed-in session, so there is no
  anonymous source for them. The published block still renders a cached
  `finished` book, so nothing breaks if one is already stored.
### Fixed


- Goodreads activity is back in the feed (#19). The provider read
  `review/list_rss`, which Goodreads has retired: every form of it now answers
  404 `<error>Page not found</error>`, and `/review/list` redirects to
  `/user/sign_in`. `shelf()` threw, `load()` failed, and `serveFeed` drops a
  provider that returns nothing, so the `goodreads` key vanished from the feed
  entirely rather than appearing empty.
- The provider now reads the public profile page, which is still anonymous. It
  takes the currently-reading books and the avatar from **one** request instead
  of three.
- `decode()` no longer leaves named HTML entities alone. Its `&lt;`, `&gt;`,
  `&quot;`, `&apos;` and `&amp;` replacements had lost their entity text and
  were no-ops, which barely showed with RSS CDATA and matters when reading HTML.
- `.github/factory.yml` requires the CodeQL matrix legs, `Analyze (actions)` and
  `Analyze (javascript-typescript)`, instead of the `CodeQL` aggregate
  (adamsuk/software-factory#153). The aggregate reports `neutral` when the
  analysis has nothing to do for the changed paths, and `gate-issue.sh` counts
  every bucket but `pass` as red, so the gate returned `retry` on #21 while all
  three CodeQL checks were fine.

### Added

- `.github/factory.yml`, enrolling this repo in the software factory
  (adamsuk/software-factory#151). Without it station 04 could not run here:
  `gate-issue.sh` reads the file from a pull request's base ref, so it has to be
  on `main`. Grants no new permission — `agents.merge` is `false`. The file
  records that `npm test` runs in `deploy.yml` before deploying but on no
  pull request, so a red test is invisible until after merge.

## 2026-10-26 (task target)

### Added

- The live task form asks for one target repository.

### Added

- CHANGELOG.md, added by [gh-factory](https://github.com/adamsuk/gh-factory).
