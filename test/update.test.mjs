import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { run } from "../update.mjs"

const NOW = Date.parse("2026-12-01T00:00:00Z")

function setup(specs, state = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qdb-"))
  fs.writeFileSync(path.join(dir, "av-specs.json"), JSON.stringify(specs))
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ waiting: {}, checked: {}, skip: {}, expired: {}, ...state }))
  fs.writeFileSync(path.join(dir, "provenance.json"), "{}")
  return dir
}
const read = (dir, n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"))

/** Routes by URL. `streams[id]` = array | status number; `kind[id]` = movie|series. */
function fakeFetch({ streams = {}, kind = {}, issues = [], discover = [], imdb = {}, log = [] } = {}) {
  return async (url) => {
    log.push(url)
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status })
    let m
    if (url.includes("api.github.com")) return json(issues)
    if (url.includes("/discover/movie")) return json({ results: discover.map((id) => ({ id })) })
    if ((m = url.match(/\/movie\/(\d+)\/external_ids/))) return json({ imdb_id: imdb[m[1]] ?? null })
    if ((m = url.match(/\/find\/(tt\d+)/))) {
      const k = kind[m[1]] ?? "movie"
      return json({ movie_results: k === "movie" ? [{}] : [], tv_results: k === "series" ? [{}] : [] })
    }
    if ((m = url.match(/\/stream\/movie\/(tt\d+)\.json/))) {
      const s = streams[m[1]] ?? []
      return typeof s === "number" ? new Response("x", { status: s }) : json({ streams: s })
    }
    throw new Error(`unexpected ${url}`)
  }
}
const base = { env: { TMDB_API_KEY: "k" }, now: NOW, sleep: async () => {}, log: () => {} }

test("no TMDB key: nothing changes, no requests", async () => {
  const dir = setup({ tt1000001: { quality: "4K", formats: [] } })
  const log = []
  const r = await run({ ...base, dir, env: {}, fetchImpl: fakeFetch({ log }) })
  assert.equal(r.reason, "no-tmdb-key")
  assert.equal(log.length, 0)
})

test("discovered 4K title is added with provenance; no-4K title waits", async () => {
  const dir = setup({ tt0000001: { quality: "4K", formats: ["dv"] } }, { checked: { tt0000001: "2026-11-30" } })
  const f = fakeFetch({
    discover: [1, 2],
    imdb: { 1: "tt5000001", 2: "tt5000002" },
    streams: { tt5000001: [{ title: "Film 2160p DV" }], tt5000002: [{ title: "Film CAM" }], tt0000001: [] },
  })
  const r = await run({ ...base, dir, fetchImpl: f })
  assert.equal(r.changed, true)
  const specs = read(dir, "av-specs.json")
  assert.deepEqual(specs.tt5000001, { quality: "4K", formats: ["dv"] })
  assert.equal(specs.tt5000002, undefined)
  assert.equal(read(dir, "provenance.json").tt5000001.created, true)
  assert.ok(read(dir, "state.json").waiting.tt5000002.firstSeen)
})

test("issue flow: results for added, present, not-movie, invalid; curated entry is overwritten", async () => {
  const dir = setup({ tt0000009: { quality: "4K", formats: [] }, tt0000008: { quality: "FHD", formats: ["dv"] } })
  const issues = [
    { number: 1, body: "### IMDb id or link\n\ntt5000001" },
    { number: 2, body: "### IMDb id or link\n\ntt0000009" },
    { number: 3, body: "### IMDb id or link\n\ntt5000003" },
    { number: 4, body: "### IMDb id or link\n\nnothing" },
    { number: 5, body: "### IMDb id or link\n\ntt0000008" },
    { number: 6, pull_request: {}, body: "### IMDb id or link\n\ntt9999999" },
  ]
  const f = fakeFetch({
    issues, kind: { tt5000003: "series" },
    streams: { tt5000001: [{ title: "X 2160p" }], tt0000008: [{ title: "X 2160p HDR10+" }] },
  })
  await run({ ...base, dir, env: { ...base.env, GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r" }, fetchImpl: f })
  const results = Object.fromEntries(read(dir, "issue-results.json").map((r) => [r.number, r.outcome]))
  assert.deepEqual(results, { 1: "added", 2: "present", 3: "not-movie", 4: "invalid", 5: "updated" })
  const specs = read(dir, "av-specs.json")
  assert.equal(specs.tt0000008.quality, "4K")
  assert.deepEqual(specs.tt0000008.formats, ["hdr10plus"])
  assert.deepEqual(read(dir, "provenance.json").tt0000008.previous, { quality: "FHD", formats: ["dv"] })
  assert.equal(read(dir, "state.json").skip.tt5000003, "series")
})

test("429 stops the run, keeps earlier progress, leaves the rest of the issues open", async () => {
  const dir = setup({})
  const issues = [
    { number: 1, body: "### IMDb id or link\n\ntt5000001" },
    { number: 2, body: "### IMDb id or link\n\ntt5000002" },
  ]
  const f = fakeFetch({ issues, streams: { tt5000001: [{ title: "X 2160p" }], tt5000002: 429 } })
  const r = await run({ ...base, dir, env: { ...base.env, GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r" }, fetchImpl: f })
  assert.equal(r.stopped, 429)
  assert.deepEqual(read(dir, "issue-results.json").map((x) => x.number), [1])
  assert.ok(read(dir, "av-specs.json").tt5000001)
})

test("dry-run: at most 3 queue items, nothing written", async () => {
  const specs = Object.fromEntries(["tt0000001", "tt0000002", "tt0000003", "tt0000004", "tt0000005"].map((id) => [id, { quality: "4K", formats: [] }]))
  const dir = setup(specs)
  const log = []
  const before = fs.readFileSync(path.join(dir, "av-specs.json"), "utf8")
  const r = await run({ ...base, dir, dryRun: true, fetchImpl: fakeFetch({ log, streams: { tt0000001: [{ title: "X 2160p HDR10+" }] } }) })
  assert.equal(r.requests, 3)
  assert.equal(fs.readFileSync(path.join(dir, "av-specs.json"), "utf8"), before)
  assert.equal(fs.existsSync(path.join(dir, "issue-results.json")), false)
  assert.equal(log.filter((u) => u.includes("/stream/")).length, 3)
})

test("expired waiting titles are dropped and not rediscovered", async () => {
  const dir = setup({}, { waiting: { tt5000002: { firstSeen: "2026-09-01T00:00:00Z" } } })
  const f = fakeFetch({ discover: [2], imdb: { 2: "tt5000002" }, streams: { tt5000002: [{ title: "Film CAM" }] } })
  await run({ ...base, dir, fetchImpl: f })
  const st = read(dir, "state.json")
  assert.equal(st.waiting.tt5000002, undefined)
  assert.ok(st.expired.tt5000002)
})
