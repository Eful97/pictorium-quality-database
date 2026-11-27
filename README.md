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

A GitHub Action (`weekly-update.yml`, Mondays 03:17 UTC) keeps the file fresh with low volume and additive rules:

- **Sources per run (caps):** open `title-request` issues (30), the watch list (40), recent popular movies from TMDB (30) and the 20 oldest-checked known titles.
- **Torrentio** is queried serially, one request per 1.1 s, for the *declared* stream labels. 401/403/429 stops the run and keeps the progress made so far.
- **Movies only**, confirmed by a TMDB `/find` check.
- **New titles** enter only with a 4K release, or a 1080p release declaring Dolby Vision, HDR10+ or Atmos. Others wait on a watch list for 8 weeks, then are dropped (a new issue lifts that).
- **Existing titles** only gain formats. Curated entries never change quality; entries the bot created may move up in quality, never down. IMAX is never added from Torrentio.
- `provenance.json` records source `torrentio`, `declared`, and the date; `state.json` holds the watch list and check dates.
- Issues get a fixed-template answer and are closed after the data commit lands. Issue text is read only for an IMDb id and never echoed or executed.

Setup: add the repo secret `TMDB_API_KEY`. Manual run: Actions → Weekly update → Run workflow (the default `dry_run` does 3 real requests and writes nothing).
