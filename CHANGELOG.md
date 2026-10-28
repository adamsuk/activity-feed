# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 2026-10-26

### Fixed

- Last.fm profile picture is taken from the current `user.getInfo` image. When that image is missing or the request fails, `profilePicture` is empty so the site can use its GitHub fallback.

## [Unreleased]

### Added

- `.github/factory.yml`, enrolling this repo in the software factory
  (adamsuk/software-factory#151). Without it station 04 could not run here:
  `gate-issue.sh` reads the file from a pull request's base ref, so it has to be
  on `main`. Grants no new permission — `agents.merge` is `false`.

## 2026-10-26 (task target)

### Added

- The live task form asks for one target repository.

### Added

- CHANGELOG.md, added by [gh-factory](https://github.com/adamsuk/gh-factory).
