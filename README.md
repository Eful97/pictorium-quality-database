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
