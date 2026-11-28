#!/usr/bin/env node
// check-missing.mjs — read-only report (TMDB only, never Torrentio, writes no data):
//   1. recent popular movies not tracked anywhere (specs, waiting, expired, skip)
//   2. tracked titles whose last check is older than OVERDUE_WEEKS (or never checked)
// `missing-ignore.json` ({ "tt…": "reason" }) silences a title.
//
// Usage: TMDB_API_KEY=... node check-missing.mjs [report.md]
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { IMDB_ID_RE } from "./lib.mjs"

export const OVERDUE_WEEKS = 12
const DAY = 86400000
const TMDB = "https://api.themoviedb.org/3"

/** Pure: ids tracked by the updater in any way. */
export function trackedIds(specs, state) {
  return new Set([...Object.keys(specs), ...Object.keys(state.waiting ?? {}), ...Object.keys(state.expired ?? {}), ...Object.keys(state.skip ?? {})])
}

/** Pure: popular ids nobody tracks and nobody ignored. */
export function findMissing(candidateIds, tracked, ignore = {}) {
  return [...new Set(candidateIds)].filter((id) => IMDB_ID_RE.test(id) && !tracked.has(id) && !(id in ignore))
}

/** Pure: known ids never checked or checked more than OVERDUE_WEEKS ago, oldest first. */
export function findOverdue(specs, checked = {}, ignore = {}, now = Date.now()) {
  const out = []
  for (const id of Object.keys(specs)) {
    if (id in ignore) continue
    const t = Date.parse(checked[id])
    if (!Number.isFinite(t) || now - t > OVERDUE_WEEKS * 7 * DAY) out.push({ id, checked: checked[id] ?? null })
  }
  return out.sort((a, b) => (a.checked ?? "") < (b.checked ?? "") ? -1 : (a.checked ?? "") > (b.checked ?? "") ? 1 : a.id < b.id ? -1 : 1)
}

export function renderReport({ date, missing, overdue, failed, total }) {
  const link = ({ id, title, year }) => `[${title ?? id}${year ? ` (${year})` : ""}](https://www.imdb.com/title/${id}/) \`${id}\``
  const lines = [`Ultimo controllo: ${date} (${total} film popolari recenti controllati su TMDB)`, ""]
  if (!missing.length && !overdue.length) lines.push("Tutto coperto e aggiornato.")
  if (missing.length) {
    lines.push(`**${missing.length} film popolari non tracciati:**`, "")
    for (const m of missing) lines.push(`- ${link(m)}`)
    lines.push("")
  }
  if (overdue.length) {
    lines.push(`**${overdue.length} titoli non controllati da più di ${OVERDUE_WEEKS} settimane:**`, "")
    for (const o of overdue.slice(0, 50)) lines.push(`- \`${o.id}\` — ${o.checked ?? "mai controllato"}`)
    if (overdue.length > 50) lines.push(`- … e altri ${overdue.length - 50}`)
    lines.push("")
  }
  if (failed) lines.push(`Non risolti su TMDB: ${failed} titoli`)
  return `${lines.join("\n").trimEnd()}\n`
}

async function tmdb(url, attempt = 1) {
  const res = await fetch(url, { headers: { "User-Agent": "Pictorium-quality-database/1.0" }, signal: AbortSignal.timeout(10000) })
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise((r) => setTimeout(r, 2000 * attempt))
    return tmdb(url, attempt + 1)
  }
  return res.ok ? res.json() : null
}

async function main() {
  const key = process.env.TMDB_API_KEY?.trim()
  if (!key) { console.error("TMDB_API_KEY is required"); process.exit(2) }
  const here = path.dirname(fileURLToPath(import.meta.url))
  const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(path.join(here, f), "utf8")) } catch { return fb } }
  const specs = readJson("av-specs.json", {})
  const state = readJson("state.json", {})
  const ignore = readJson("missing-ignore.json", {})
  const now = Date.now()
  const from = new Date(now - 90 * DAY).toISOString().slice(0, 10)
  const to = new Date(now).toISOString().slice(0, 10)

  const movies = []
  for (const page of [1, 2, 3]) {
    const json = await tmdb(`${TMDB}/discover/movie?primary_release_date.gte=${from}&primary_release_date.lte=${to}&sort_by=popularity.desc&page=${page}&api_key=${encodeURIComponent(key)}`)
    if (!json) { console.error("TMDB discover failed; aborting"); process.exit(1) }
    for (const m of json.results ?? []) if (Number.isInteger(m?.id)) movies.push(m)
  }

  const found = []
  let failed = 0
  for (const m of movies) {
    const ext = await tmdb(`${TMDB}/movie/${m.id}/external_ids?api_key=${encodeURIComponent(key)}`)
    if (!ext) failed += 1
    else if (ext.imdb_id) found.push({ id: ext.imdb_id, title: m.title, year: m.release_date?.slice(0, 4) })
  }
  if (failed > movies.length * 0.2) { console.error(`TMDB lookup failed for ${failed}/${movies.length}; aborting`); process.exit(1) }

  const ids = new Set(findMissing(found.map((f) => f.id), trackedIds(specs, state), ignore))
  const missing = found.filter((f) => ids.delete(f.id))
  const report = renderReport({ date: to, missing, overdue: findOverdue(specs, state.checked, ignore, now), failed, total: movies.length })
  fs.writeFileSync(process.argv[2] ?? "missing-report.md", report, "utf8")
  fs.writeFileSync(path.join(here, "missing.json"), `${JSON.stringify(missing.map((m) => m.id))}\n`, "utf8") // read by update.mjs, git-ignored
  console.log(report)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
