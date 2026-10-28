# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 2026-10-26

### Fixed

- Last.fm profile picture is taken from the current `user.getInfo` image. When that image is missing or the request fails, `profilePicture` is empty so the site can use its GitHub fallback.

## [Unreleased]

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
