# Pictorium Quality Database

A/V quality data for [Pictorium](https://github.com/Eful97/Pictorium) quality badges.

`av-specs.json` maps an IMDb id to the best known quality and A/V formats:

```json
{ "tt15239678": { "quality": "4K", "formats": ["dv", "atmos", "hdr"] } }
```

- `quality`: `4K` | `FHD` | `HD` | `SD`
- `formats`: any of `dv`, `hdr`, `hdr10plus`, `atmos`, `imax`

It means "this title exists in that quality/format somewhere", not what a given stream delivers.
Pictorium downloads this file every 24 h and falls back to its bundled copy when unreachable.

## How it stays up to date

Two GitHub Actions do the work. Both only use TMDB and Torrentio, and only look at movies.

**Weekly update** (Mondays and Thursdays) checks a batch of titles on Torrentio and commits the changes:

- Titles come from open `title-request` issues, the watch list, recent popular movies (including the ones found by the missing check below) and the titles checked longest ago, so every title is looked at again about every 12 weeks.
- A new title is added only with a 4K release, or a 1080p release with Dolby Vision, HDR10+ or Atmos. Otherwise it waits on a watch list for 8 weeks, then is dropped. A new issue for it lifts that.
- An existing title is updated to what Torrentio declares. New formats are added at once; a stored format is removed only after 2 consecutive checks without it. Quality never goes down because of one observation, and IMAX is kept.
- Films released before 1990 need 2 separate releases declaring a format before it is stored, because old films often get fake labels from fan upscales.
- Requests go one at a time. If Torrentio blocks the run (401/403/429), progress is kept and the run ends red, so you get an email.

**Weekly missing-title check** (Mondays) writes no data. It opens or updates one issue with the label `missing-check`, listing popular movies not tracked yet and titles not checked for over 12 weeks. Titles listed in `missing-ignore.json` are skipped.

Other files: `provenance.json` says where each value came from and what it was before. `state.json` keeps the watch list and the last check dates.

## Setup

Add the repo secret `TMDB_API_KEY`.

To run a workflow by hand: Actions → pick the workflow → Run workflow. For Weekly update, the default `dry_run` does 3 real requests and writes nothing.
