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

## Weekly update

A GitHub Action (`weekly-update.yml`, Mondays and Thursdays 03:17 UTC) keeps the file fresh with low volume and additive rules:

- **Sources per run (caps):** open `title-request` issues (30), the watch list (40), priority rechecks (40: bot-added titles still below 4K or added in the last 12 weeks), a one-off strict recheck of old-catalog seed entries (80: ids below tt1000000 that still carry dv/hdr/hdr10plus/atmos and were never rechecked), recent popular movies from TMDB plus ids from `missing.json` (60 together; `check-missing.mjs` writes that git-ignored file just before the update, TMDB only, and also feeds the weekly `missing-check` issue) and the 100 oldest-checked known titles, so every title is looked at again roughly every 12 weeks.
- **Torrentio** is queried serially, one request per 1.1 s, for the *declared* stream labels. 401/403/429 stops the run and keeps the progress made so far.
- **Movies only**, confirmed by a TMDB `/find` check.
- **New titles** enter only with a 4K release, or a 1080p release declaring Dolby Vision, HDR10+ or Atmos. Others wait on a watch list for 8 weeks, then are dropped (a new issue lifts that).
- **Existing titles** (curated or not) are overwritten by what Torrentio declares: formats are replaced by the union of formats declared by 1080p+ releases, quality moves up but is never lowered by one observation, IMAX is kept, and a title with no usable observation is left alone.
- **Classic films (released before 1990, year from TMDB):** dv/hdr/hdr10plus/atmos are stored only when at least 2 distinct 1080p+ releases declare them, because those labels on old films mostly come from fan upscales. Checked entries get `strict: true` in `provenance.json`.
- **Blocked runs are loud:** if Torrentio answers 401/403/429 the run keeps and commits its progress, then the workflow ends red (GitHub emails the owner) instead of looking green. The previous value is stored in `provenance.json` (`previous`) and in git history.
- `provenance.json` records source `torrentio`, `declared`, and the date; `state.json` holds the watch list and check dates.
- Issues get a fixed-template answer and are closed after the data commit lands. Issue text is read only for an IMDb id and never echoed or executed.

Setup: add the repo secret `TMDB_API_KEY`. Manual run: Actions → Weekly update → Run workflow (the default `dry_run` does 3 real requests and writes nothing).
