import test from "node:test"
import assert from "node:assert/strict"
import { findMissing, findOverdue, renderReport, trackedIds } from "../check-missing.mjs"

const NOW = Date.parse("2026-11-28T00:00:00Z")

test("trackedIds covers specs, waiting, expired, skip", () => {
  const t = trackedIds({ tt1111111: {} }, { waiting: { tt2222222: {} }, expired: { tt3333333: "x" }, skip: { tt4444444: 1 } })
  assert.deepEqual([...t].sort(), ["tt1111111", "tt2222222", "tt3333333", "tt4444444"])
})

test("findMissing drops tracked, ignored, invalid and duplicate ids", () => {
  const out = findMissing(["tt1111111", "tt5555555", "tt5555555", "tt6666666", "bad"], new Set(["tt1111111"]), { tt6666666: "n/a" })
  assert.deepEqual(out, ["tt5555555"])
})

test("findOverdue: never-checked and >12 weeks, oldest first, ignore respected", () => {
  const specs = { tt1111111: {}, tt2222222: {}, tt3333333: {}, tt4444444: {} }
  const checked = { tt1111111: "2026-11-20", tt2222222: "2026-01-01", tt4444444: "2026-02-01" }
  const out = findOverdue(specs, checked, { tt4444444: "x" }, NOW)
  assert.deepEqual(out.map((o) => o.id), ["tt3333333", "tt2222222"])
})

test("renderReport: all clear vs findings", () => {
  assert.match(renderReport({ date: "2026-11-28", missing: [], overdue: [], failed: 0, total: 60 }), /Tutto coperto/)
  const r = renderReport({ date: "2026-11-28", missing: [{ id: "tt5555555", title: "Film", year: "2026" }], overdue: [{ id: "tt2222222", checked: null }], failed: 1, total: 60 })
  assert.match(r, /1 film popolari non tracciati/)
  assert.match(r, /mai controllato/)
  assert.match(r, /Non risolti su TMDB: 1/)
})
