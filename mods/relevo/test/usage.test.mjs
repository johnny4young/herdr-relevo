import { test } from "node:test";
import assert from "node:assert/strict";
import { cacheLeft, compact, dayKey, lastDays, modelName, summarize } from "../lib/usage.js";

const NOW = new Date(2026, 10, 5, 12);
const TODAY = dayKey(NOW);
const row = (over = {}) => ({
  day: TODAY, account: "personal", surface: "desktop", project: "app", kind: "main", model: "m",
  input: 0, write: 100, read: 1000, output: 10, msgs: 1, pause_write: 0, pauses: 0, ...over,
});

test("the range keeps only its days", () => {
  const old = dayKey(new Date(2026, 9, 1));
  assert.equal(summarize({ rows: [row(), row({ day: old })] }, 7, null, NOW).total.write, 100);
  assert.equal(summarize({ rows: [row(), row({ day: old })] }, 1, null, NOW).days.length, 1);
});

test("each surface says its share of the output", () => {
  const s = summarize({ rows: [row({ output: 75 }), row({ surface: "terminal", output: 25 })] }, 1, null, NOW);
  assert.deepEqual(s.surfaces.map((x) => [x.label, x.share]), [["Desktop", 0.75], ["Terminal", 0.25]]);
});

test("a surface with nothing stays out", () => {
  assert.deepEqual(summarize({ rows: [row()] }, 1, null, NOW).surfaces.map((x) => x.key), ["desktop"]);
});

test("the account filter narrows rows and sessions", () => {
  const report = {
    rows: [row(), row({ account: "work", write: 7 })],
    sessions: [{ id: "a", account: "personal", last: `${TODAY}T10:00:00Z` }, { id: "b", account: "work", last: `${TODAY}T10:00:00Z` }],
  };
  const s = summarize(report, 1, "work", NOW);
  assert.equal(s.total.write, 7);
  assert.deepEqual(s.sessions.map((x) => x.id), ["b"]);
});

test("projects sort by new context", () => {
  const s = summarize({ rows: [row({ project: "a", write: 1 }), row({ project: "b", write: 9 }), row({ project: "a", write: 2 })] }, 1, null, NOW);
  assert.deepEqual(s.projects.map((p) => [p.key, p.write]), [["b", 9], ["a", 3]]);
});

test("subagents go by type and the small ones fold together", () => {
  const types = ["a", "b", "c", "d", "e", "f"];
  const s = summarize({ rows: [row({ write: 1000 }), ...types.map((k, i) => row({ kind: `sub:${k}`, write: 100 - i }))] }, 1, null, NOW);
  assert.equal(s.kinds[0].key, "Main conversations");
  assert.deepEqual(s.kinds.find((k) => k.key === "Other subagents").write, 96 + 95);
  assert.ok(s.kinds.find((k) => k.key === "a").sub);
});

test("a pause adds up without counting twice in the total", () => {
  const s = summarize({ rows: [row({ write: 500, pause_write: 400, pauses: 2 })] }, 1, null, NOW);
  assert.deepEqual([s.total.write, s.paused.write, s.paused.count], [500, 400, 2]);
});

test("lastDays ends today and crosses a month", () => {
  assert.deepEqual(lastDays(6, NOW).slice(0, 2), ["2026-10-31", "2026-11-01"]);
  assert.equal(lastDays(6, NOW).at(-1), TODAY);
});

test("compact keeps numbers short", () => {
  assert.deepEqual([12, 1500, 2_340_000, 238_000_000, 15_700_000_000].map(compact), ["12", "2k", "2.3M", "238M", "15.7B"]);
});

test("modelName reads a model id", () => {
  assert.equal(modelName("claude-opus-5-5"), "Opus 5.5");
  assert.equal(modelName("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(modelName("gpt-5"), "gpt-5");
  assert.equal(modelName(null), "");
});

test("cacheLeft runs out at the message's age plus its lifetime", () => {
  assert.equal(cacheLeft({ at: 1000, ttl: 300 }, 1100), 200);
  assert.equal(cacheLeft({ at: 1000, ttl: 300 }, 2000), 0);
  assert.equal(cacheLeft(null, 2000), 0);
});
