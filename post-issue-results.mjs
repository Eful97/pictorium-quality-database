#!/usr/bin/env node
// Answers and closes the title-request issues processed by update.mjs.
// Runs AFTER the data commit is pushed, so a comment never claims a change
// that did not land. Comments come from fixed templates; only the validated
// IMDb id is interpolated — issue text is never echoed.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { IMDB_ID_RE } from "./lib.mjs"

const MESSAGES = {
  added: (id) => `\`${id}\` was added to the database. Pictorium instances pick it up within 24 hours.`,
  updated: (id) => `\`${id}\` was updated with newly found formats. Pictorium instances pick it up within 24 hours.`,
  present: (id) => `\`${id}\` is already covered, nothing new was found.`,
  waiting: (id) => `No 4K or HDR release was found for \`${id}\` yet. It stays on the watch list and is re-checked every week for 8 weeks, no need to reopen this issue.`,
  "not-movie": (id) => `\`${id}\` is not a movie TMDB can confirm. Only movies are supported.`,
  invalid: () => "No valid IMDb id (like `tt1234567`) was found in the form. Please open a new request.",
}
const NOT_PLANNED = new Set(["not-movie", "invalid"])

async function api(token, repo, method, route, body) {
  const res = await fetch(`https://api.github.com/repos/${repo}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "Pictorium-quality-database/1.0" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status}`)
}

const dir = path.dirname(fileURLToPath(import.meta.url))
const token = process.env.GITHUB_TOKEN
const repo = process.env.GITHUB_REPOSITORY
if (!token || !repo) {
  console.log("no GITHUB_TOKEN/GITHUB_REPOSITORY: skipped")
  process.exit(0)
}
let results = []
try {
  results = JSON.parse(fs.readFileSync(path.join(dir, "issue-results.json"), "utf8"))
} catch { /* nothing processed */ }

for (const r of Array.isArray(results) ? results : []) {
  const make = MESSAGES[r?.outcome]
  if (!make || !Number.isInteger(r.number)) continue
  const id = typeof r.id === "string" && IMDB_ID_RE.test(r.id) ? r.id : ""
  try {
    await api(token, repo, "POST", `/issues/${r.number}/comments`, { body: make(id) })
    await api(token, repo, "PATCH", `/issues/${r.number}`, { state: "closed", state_reason: NOT_PLANNED.has(r.outcome) ? "not_planned" : "completed" })
  } catch (err) {
    console.error(err instanceof Error ? err.message : err) // keep going: other issues still get answered
  }
}
