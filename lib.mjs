// Pure logic for the weekly A/V specs updater (no I/O, no network).
//
// Declared-label parser and additive merge ported from Pictorium
// `scripts/torrentio-av-import.mjs` (parseTorrentioRecord, selectCandidate,
// classifyFindResult, mergeAdditive). Torrentio labels are DECLARED, never
// verified: they say "a release with this label exists", not what a stream
// delivers.

export const QUALITY_ORDER = { SD: 0, HD: 1, FHD: 2, "4K": 3 }
export const FORMAT_ORDER = ["dv", "hdr", "hdr10plus", "atmos"]
// imax is observed by the parser but NEVER merged (curated-only).
export const ALLOWED_MERGE_FORMATS = ["dv", "hdr", "hdr10plus", "atmos"]
export const KNOWN_QUALITIES = ["4K", "FHD", "HD", "SD"]
export const WAITING_TTL_DAYS = 56
export const RECENT_WEEKS = 12
export const CAPS = { issues: 30, waiting: 40, priority: 40, strict: 80, discovery: 60, refresh: 100 }
// Films released before this year are classic titles: dv/hdr/hdr10plus/atmos
// labels there usually come from fan upscales, so a format needs several
// concordant releases before it is stored.
export const STRICT_BEFORE_YEAR = 1990
export const STRICT_MIN_RELEASES = 2
// IMDb ids below this are the old catalog: used only to pick which seed
// entries get the strict recheck first (the real gate is the TMDB year).
export const LEGACY_ID_LIMIT = 1000000
export const IMDB_ID_RE = /^tt\d{7,10}$/
const STOP_STATUSES = new Set([401, 403, 429])

const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v)

// ---- declared-label parser --------------------------------------------------

const tokenize = (s) => s.split(/\s+/).filter(Boolean)

function qualityFromText(text) {
  if (!text) return { quality: null, numeric: false }
  const t = text.toLowerCase().replace(/[._\-+]+/g, " ")
  if (t.includes("2160")) return { quality: "4K", numeric: true }
  if (/\b(1080[pi]?|fhd|fullhd)\b/.test(t)) return { quality: "FHD", numeric: true }
  if (/\b(720[pi]?|hd|hdtv)\b/.test(t)) return { quality: "HD", numeric: true }
  if (/\b(480[pi]?|576[pi]?|sd|dvdrip|cam|ts|telesync|hdts|hdcam)\b/.test(t)) return { quality: "SD", numeric: true }
  if (tokenize(t).some((k) => k === "4k" || k === "uhd" || k.startsWith("4k") || k.startsWith("uhd"))) {
    return { quality: "4K", numeric: false }
  }
  return { quality: null, numeric: false }
}

function formatsFromText(raw) {
  if (!raw) return []
  const low = String(raw).toLowerCase()
  const plus = /hdr[\s._\-]*10[\s._\-]*\+/.test(low) || low.includes("hdr10plus")
  const t = low.replace(/[._\-+]+/g, " ")
  const tokens = new Set(tokenize(t))
  const out = []
  if (plus || tokens.has("hdr10plus")) out.push("hdr10plus")
  else if (tokens.has("hdr10") || tokens.has("hdr")) out.push("hdr")
  if (tokens.has("dv") || tokens.has("dovi") || tokens.has("dolbyvision") || /\bdolby\s*vision\b/.test(t)) out.push("dv")
  if (tokens.has("atmos")) out.push("atmos")
  if (tokens.has("imax")) out.push("imax")
  return out
}

function field(rec, name) {
  if (name === "filename" || name === "bingeGroup") {
    const h = rec.behaviorHints
    return (isRecord(h) && typeof h[name] === "string" && h[name]) || ""
  }
  return (typeof rec[name] === "string" && rec[name]) || ""
}

export function parseTorrentioRecord(rec) {
  if (!isRecord(rec)) return { quality: null, formats: [], numeric: false }
  const filename = field(rec, "filename")
  const others = [field(rec, "title"), field(rec, "name"), field(rec, "bingeGroup")]
  const fileQ = qualityFromText(filename)
  let quality = null
  let numeric = false
  if (fileQ.quality) {
    quality = fileQ.quality
    numeric = fileQ.numeric
  } else {
    for (const text of others) {
      const q = qualityFromText(text)
      if (q.quality && (quality === null || (q.numeric && !numeric))) {
        quality = q.quality
        numeric = q.numeric
        if (numeric) break
      }
    }
    if (!quality) {
      const labelQ = qualityFromText(others.join(" "))
      if (labelQ.quality && !labelQ.numeric) quality = labelQ.quality
    }
  }
  const seen = new Set()
  const formats = []
  for (const text of [filename, ...others]) {
    for (const f of formatsFromText(text)) if (!seen.has(f)) { seen.add(f); formats.push(f) }
  }
  return { quality, formats, numeric }
}

/** Highest-tier single release; formats are never combined across releases. */
export function selectCandidate(streams) {
  if (!Array.isArray(streams) || streams.length === 0) return null
  let best = null
  for (let index = 0; index < streams.length; index += 1) {
    const p = parseTorrentioRecord(streams[index])
    if (!p.quality) continue
    const rank = QUALITY_ORDER[p.quality]
    const incumbent = best ? QUALITY_ORDER[best.quality] : -1
    if (!best || rank > incumbent || (rank === incumbent && p.numeric && !best.numeric)) {
      best = { index, quality: p.quality, formats: p.formats, numeric: p.numeric }
    }
  }
  return best
}

export function classifyFindResult(json) {
  const movies = Array.isArray(json?.movie_results) ? json.movie_results : null
  const series = Array.isArray(json?.tv_results) ? json.tv_results : null
  if (!movies || !series) return "unknown"
  if (movies.length > 0 && series.length === 0) return "movie"
  if (series.length > 0 && movies.length === 0) return "series"
  if (movies.length > 0 && series.length > 0) return "ambiguous"
  return "unknown"
}

/** Release year from a TMDB /find result (first movie hit), or null. */
export function releaseYear(json) {
  const d = json?.movie_results?.[0]?.release_date
  const y = typeof d === "string" ? Number(d.slice(0, 4)) : NaN
  return Number.isInteger(y) && y > 1800 ? y : null
}

/** Releases that must declare a format before it is stored (1 = no extra rule). */
export const minReleasesFor = (year) => (year !== null && year !== undefined && year < STRICT_BEFORE_YEAR ? STRICT_MIN_RELEASES : 1)

export function shouldStopOnHttpStatus(status, headers) {
  if (STOP_STATUSES.has(status)) return true
  try {
    return !!headers && typeof headers.get === "function" && headers.get("retry-after") !== null
  } catch {
    return false
  }
}

// ---- admission & merge ------------------------------------------------------

const orderedFormats = (formats) => FORMAT_ORDER.filter((f) => formats.includes(f) && ALLOWED_MERGE_FORMATS.includes(f))

/**
 * A NEW title enters only with a 4K release, or an FHD release that declares
 * dv/hdr10plus/atmos. CAM/TS (SD), plain HD and unlabeled FHD wait instead.
 */
export function admitNew(candidate) {
  if (!candidate) return false
  if (candidate.quality === "4K") return true
  return candidate.quality === "FHD" && candidate.formats.some((f) => f === "dv" || f === "hdr10plus" || f === "atmos")
}

export function buildNewEntry(candidate) {
  return { quality: candidate.quality, formats: orderedFormats(candidate.formats) }
}

/**
 * Title-level observation: best quality seen and the union of allowlisted
 * formats declared by releases at 1080p or better (declared labels, edition
 * union: not "all in one stream"). null when no stream carried a quality.
 */
export function observeTitle(streams, minReleases = 1) {
  if (!Array.isArray(streams)) return null
  let quality = null
  const counts = new Map()
  for (const s of streams) {
    const p = parseTorrentioRecord(s)
    if (!p.quality) continue
    if (quality === null || QUALITY_ORDER[p.quality] > QUALITY_ORDER[quality]) quality = p.quality
    if (QUALITY_ORDER[p.quality] >= QUALITY_ORDER.FHD) for (const f of new Set(p.formats)) counts.set(f, (counts.get(f) ?? 0) + 1)
  }
  const formats = [...counts].filter(([, n]) => n >= minReleases).map(([f]) => f)
  return quality ? { quality, formats: orderedFormats(formats) } : null
}

/**
 * Overwrite an existing entry with a fresh observation (curated or not):
 * formats are REPLACED by the observed set, quality moves up but is never
 * lowered by a single observation, imax is kept (Torrentio never reports it).
 * No observation (no quality seen) changes nothing. Entries whose formats
 * already match keep their stored order.
 */
export function overwriteEntry(existing, obs) {
  const base = isRecord(existing) ? existing : {}
  const current = Array.isArray(base.formats) ? base.formats.filter((f) => typeof f === "string") : []
  if (!obs) return { entry: base, changed: false }
  const wanted = new Set(obs.formats)
  if (current.includes("imax")) wanted.add("imax")
  const kept = current.filter((f) => wanted.has(f))
  const formats = [...kept, ...FORMAT_ORDER.concat("imax").filter((f) => wanted.has(f) && !kept.includes(f))]
  const entry = { ...base, formats }
  const cur = base.quality
  if (cur === undefined || cur === null || QUALITY_ORDER[obs.quality] > (QUALITY_ORDER[cur] ?? -1)) entry.quality = obs.quality
  const changed = entry.quality !== base.quality || formats.length !== current.length || formats.some((f, i) => f !== current[i])
  return { entry, changed, previous: { quality: base.quality ?? null, formats: current } }
}

// ---- issues -----------------------------------------------------------------

/**
 * Reads ONLY the form field section of an issue-form body and returns the
 * first IMDb id in it. Nothing else of the issue text is used or echoed.
 */
export function parseIssueTitleId(body) {
  if (typeof body !== "string") return null
  const m = body.match(/###[ \t]*IMDb id or link[^\n]*\n+([\s\S]*?)(?=\n###|$)/i)
  if (!m) return null
  const id = m[1].match(/tt\d{7,10}/i)
  return id ? id[0].toLowerCase() : null
}

// ---- queue ------------------------------------------------------------------

export function isExpired(entry, now) {
  const t = Date.parse(entry?.firstSeen)
  return !Number.isFinite(t) || now - t > WAITING_TTL_DAYS * 86400000
}

/**
 * Bot-created entries worth rechecking every run: still below 4K, or added
 * within the last RECENT_WEEKS (new releases keep gaining formats).
 */
export function priorityIds(specs, provenance, now) {
  const ids = []
  for (const [id, p] of Object.entries(provenance)) {
    if (p?.created !== true || !specs[id]) continue
    const added = Date.parse(p.addedAt ?? p.observedAt)
    const recent = Number.isFinite(added) && now - added < RECENT_WEEKS * 7 * 86400000
    if (specs[id].quality !== "4K" || recent) ids.push(id)
  }
  return ids
}

/**
 * Seed entries from the old catalog that still carry a quality-sensitive
 * format and were never rechecked under the strict rule (`provenance.strict`).
 */
export function strictIds(specs, provenance) {
  const out = []
  for (const [id, e] of Object.entries(specs)) {
    if (!IMDB_ID_RE.test(id) || Number(id.slice(2)) >= LEGACY_ID_LIMIT || provenance[id]?.strict) continue
    if (Array.isArray(e?.formats) && e.formats.some((f) => ALLOWED_MERGE_FORMATS.includes(f))) out.push(id)
  }
  return out
}

const byOldestChecked = (checked) => (a, b) => {
  const ca = checked[a] ?? ""
  const cb = checked[b] ?? ""
  return ca < cb ? -1 : ca > cb ? 1 : a < b ? -1 : 1
}

/**
 * Ordered, deduplicated work list: issues, waiting, priority rechecks,
 * discovery, then a refresh slice of the oldest-checked known ids.
 */
export function buildQueue({ issueIds, waitingIds, priorityIds: priority = [], strictIds: strict = [], discoveryIds, known, checked, skip, caps = CAPS }) {
  const queue = []
  const taken = new Set()
  const push = (ids, via, cap, filter) => {
    let n = 0
    for (const id of ids) {
      if (n >= cap) break
      if (taken.has(id) || skip[id] || !IMDB_ID_RE.test(id) || (filter && !filter(id))) continue
      taken.add(id)
      queue.push({ id, via })
      n += 1
    }
  }
  push(issueIds, "issue", caps.issues)
  push(waitingIds, "waiting", caps.waiting)
  push([...priority].sort(byOldestChecked(checked)), "priority", caps.priority)
  push([...strict].sort(byOldestChecked(checked)), "strict", caps.strict ?? 0)
  push(discoveryIds, "discovery", caps.discovery, (id) => !known.has(id))
  push([...known].sort(byOldestChecked(checked)), "refresh", caps.refresh)
  return queue
}
