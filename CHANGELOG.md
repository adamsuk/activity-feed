# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 2026-10-26

### Fixed

- Last.fm profile picture is taken from the current `user.getInfo` image. When that image is missing or the request fails, `profilePicture` is empty so the site can use its GitHub fallback.

## [Unreleased]

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
