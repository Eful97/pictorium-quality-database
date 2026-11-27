#!/usr/bin/env node
// Weekly A/V specs updater. Low volume, serial, additive.
//
//   node update.mjs             # normal run (writes files)
//   node update.mjs --dry-run   # at most 3 real requests, writes nothing
//
// Env: TMDB_API_KEY (required: without it nothing is changed), GITHUB_TOKEN +
// GITHUB_REPOSITORY (optional: reads open `title-request` issues).
// Torrentio is queried serially (>= 1100 ms apart); 401/403/429/Retry-After
// stops the run, keeps the progress made so far and leaves unprocessed
// issues open. No raw responses, links or hashes are stored.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  CAPS, IMDB_ID_RE, admitNew, buildNewEntry, buildQueue, classifyFindResult, isExpired,
  observeTitle, overwriteEntry, parseIssueTitleId, priorityIds, selectCandidate, shouldStopOnHttpStatus,
} from "./lib.mjs"

const TORRENTIO = "https://torrentio.strem.fun"
const TMDB = "https://api.themoviedb.org/3"
const SPACING_MS = 1100
const TIMEOUT_MS = 10000
const DRY_LIMIT = 3
const DAY = 86400000

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return fallback }
}
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n")

async function get(fetchImpl, url, headers) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await fetchImpl(url, { headers: { "User-Agent": "Pictorium-quality-database/1.0", ...headers }, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function loadIssues(fetchImpl, env) {
  const repo = env.GITHUB_REPOSITORY
  if (!env.GITHUB_TOKEN || !repo) return []
  try {
    const res = await get(
      fetchImpl,
      `https://api.github.com/repos/${repo}/issues?state=open&labels=title-request&sort=created&direction=asc&per_page=100`,
      { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    )
    if (!res.ok) return []
    const list = await res.json()
    return (Array.isArray(list) ? list : []).filter((i) => i && !i.pull_request).map((i) => ({ number: i.number, body: i.body }))
  } catch {
    return []
  }
}

/** Resolves recent popular movies to IMDb ids (TMDB). Never throws. */
async function discover(fetchImpl, key, now, limit) {
  const ids = []
  const from = new Date(now - 90 * DAY).toISOString().slice(0, 10)
  const to = new Date(now).toISOString().slice(0, 10)
  try {
    for (const page of [1, 2]) {
      const res = await get(fetchImpl, `${TMDB}/discover/movie?primary_release_date.gte=${from}&primary_release_date.lte=${to}&sort_by=popularity.desc&page=${page}&api_key=${encodeURIComponent(key)}`)
      if (!res.ok) break
      const json = await res.json()
      for (const m of json?.results ?? []) if (Number.isInteger(m?.id)) ids.push(m.id)
      if (ids.length >= limit * 3) break
    }
  } catch { /* fail-closed: fewer candidates */ }
  return ids
}

async function tmdbToImdb(fetchImpl, key, tmdbId) {
  try {
    const res = await get(fetchImpl, `${TMDB}/movie/${tmdbId}/external_ids?api_key=${encodeURIComponent(key)}`)
    if (!res.ok) return null
    const id = (await res.json())?.imdb_id
    return typeof id === "string" && IMDB_ID_RE.test(id) ? id : null
  } catch {
    return null
  }
}

export async function run({ dir, env = process.env, fetchImpl = fetch, now = Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), dryRun = false, log = console.log }) {
  const file = (n) => path.join(dir, n)
  const key = (env.TMDB_API_KEY ?? "").trim()
  if (!key) {
    log("TMDB_API_KEY missing: nothing changed")
    return { changed: false, reason: "no-tmdb-key" }
  }
  const specs = readJson(file("av-specs.json"), null)
  if (!specs || typeof specs !== "object") throw new Error("av-specs.json unreadable")
  const state = { waiting: {}, checked: {}, skip: {}, expired: {}, ...readJson(file("state.json"), {}) }
  const provenance = readJson(file("provenance.json"), {})
  const nowIso = new Date(now).toISOString()
  const results = []
  const budget = dryRun ? DRY_LIMIT : Infinity
  let requests = 0
  let stopped = null
  let dirty = false

  // 1. Issues -> ids (already-4K and invalid ones are answered without network).
  const issueIds = []
  const issueById = new Map()
  for (const issue of await loadIssues(fetchImpl, env)) {
    const id = parseIssueTitleId(issue.body)
    if (!id) { results.push({ number: issue.number, outcome: "invalid" }); continue }
    if (specs[id]?.quality === "4K") { results.push({ number: issue.number, id, outcome: "present" }); continue }
    if (state.skip[id]) { results.push({ number: issue.number, id, outcome: "not-movie" }); continue }
    delete state.expired[id] // an explicit request lifts an earlier expiry
    if (!issueById.has(id)) { issueById.set(id, []); issueIds.push(id) }
    issueById.get(id).push(issue.number)
  }

  // 2. Discovery + queue.
  const waitingIds = Object.keys(state.waiting).filter((id) => {
    if (isExpired(state.waiting[id], now)) { delete state.waiting[id]; state.expired[id] = nowIso.slice(0, 10); dirty = true; return false }
    return true
  })
  const known = new Set(Object.keys(specs))
  const discoveryIds = []
  if (!dryRun) {
    for (const tmdbId of await discover(fetchImpl, key, now, CAPS.discovery)) {
      if (discoveryIds.length >= CAPS.discovery * 2) break
      const id = await tmdbToImdb(fetchImpl, key, tmdbId)
      if (id && !known.has(id) && !state.expired[id] && !state.waiting[id]) discoveryIds.push(id)
    }
  }
  const queue = buildQueue({ issueIds, waitingIds, priorityIds: priorityIds(specs, provenance, now), discoveryIds, known, checked: state.checked, skip: state.skip })
  log(`queue: ${queue.length} (issues ${issueIds.length}, waiting ${waitingIds.length}, discovery ${discoveryIds.length}, via ${[...new Set(queue.map((q) => q.via))].join("/")})`)

  // 3. Process serially.
  const issueDone = (id, outcome) => { for (const number of issueById.get(id) ?? []) results.push({ number, id, outcome }) }
  for (const { id, via } of queue) {
    if (requests >= budget) break
    if (requests > 0) await sleep(SPACING_MS)
    requests += 1

    // Authoritative TMDB gate: movies only.
    let kind = "unknown"
    try {
      const res = await get(fetchImpl, `${TMDB}/find/${encodeURIComponent(id)}?external_source=imdb_id&api_key=${encodeURIComponent(key)}`)
      if (res.ok) kind = classifyFindResult(await res.json())
      else { log(`tmdb find ${id}: ${res.status}`); continue }
    } catch { continue }
    if (kind !== "movie") {
      state.skip[id] = kind
      delete state.waiting[id]
      issueDone(id, "not-movie")
      dirty = true
      continue
    }

    let streams = null
    try {
      const res = await get(fetchImpl, `${TORRENTIO}/stream/movie/${encodeURIComponent(id)}.json`)
      log(`torrentio ${id}: ${res.status}`)
      if (shouldStopOnHttpStatus(res.status, res.headers)) { stopped = res.status; break }
      if (res.ok) {
        const body = await res.json()
        streams = Array.isArray(body?.streams) ? body.streams : null
      }
    } catch { streams = null }
    if (!streams) continue // transient failure: leave issue open, retry next run

    const candidate = selectCandidate(streams)
    state.checked[id] = nowIso.slice(0, 10)
    dirty = true
    const prov = (extra) => ({ source: "torrentio", verification: "declared", observedAt: nowIso, via, ...extra })

    if (specs[id]) {
      const merged = overwriteEntry(specs[id], observeTitle(streams))
      if (merged.changed) {
        specs[id] = merged.entry
        provenance[id] = { ...provenance[id], ...prov({ previous: merged.previous }) }
        issueDone(id, "updated")
      } else {
        issueDone(id, "present")
      }
    } else if (admitNew(candidate)) {
      specs[id] = buildNewEntry(candidate)
      provenance[id] = prov({ created: true, addedAt: nowIso })
      delete state.waiting[id]
      issueDone(id, "added")
    } else {
      state.waiting[id] ??= { firstSeen: nowIso }
      issueDone(id, "waiting")
    }
  }

  if (dryRun) {
    log(`dry-run: ${requests} requests, nothing written${stopped ? `, stopped on ${stopped}` : ""}`)
    return { changed: false, requests, stopped }
  }
  if (dirty) {
    writeJson(file("av-specs.json"), specs)
    writeJson(file("provenance.json"), provenance)
    writeJson(file("state.json"), state)
  }
  writeJson(file("issue-results.json"), results)
  if (stopped) log(`::warning::stopped on HTTP ${stopped}; progress kept, remaining work next run`)
  return { changed: dirty, requests, stopped, results }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  run({ dir, dryRun: process.argv.includes("--dry-run") }).catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
