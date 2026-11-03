import { test } from "node:test";
import assert from "node:assert/strict";
import { AWAY_AFTER, leftAt, awaySummary, timeWithin } from "../lib/away.js";
import { parseIndex, parseDetails, titleOf, inRepo, matches } from "../lib/sessions.js";

test("leftAt: behind other apps, or a gap in the ticks because the Mac slept", () => {
  assert.equal(leftAt({ active: true, now: 100, lastTick: 99 }), null);
  assert.equal(leftAt({ active: false, now: 100, lastTick: 99 }), 100);
  assert.equal(leftAt({ active: true, now: 5 + AWAY_AFTER, lastTick: 5 }), 5);
});

test("awaySummary: what finished, waits, changed on your PRs and was spent, or nothing", () => {
  const agents = [{ address: "t1", status: "done" }, { address: "t2", status: "working" }, { address: "t3", status: "blocked" },
    { address: "t4", status: "idle" }];
  const events = [{ title: "CI failed · api #1", url: "u1", kind: "ci-failed" }, { title: "CI failed · api #1", url: "u1", kind: "ci-failed" },
    { title: "Merged · api #2", url: "u2", kind: "merged" }];
  const s = awaySummary({
    since: 0, now: 1, agents, worked: new Set(["t1", "t2"]), events, labels: { p: "Personal" },
    quotasBefore: { p: { h5: { pct: 10 }, d7: { pct: 40 } }, t: { h5: { pct: 5 } } },
    quotasNow: { p: { h5: { pct: 22 }, d7: { pct: 40 } }, t: { h5: { pct: 5 } }, x: { h5: { pct: 50 } } },
  });
  assert.deepEqual(s.finished, ["t1"]);
  assert.deepEqual(s.waiting, ["t3"]);
  assert.deepEqual(s.prs.map((p) => p.title), ["CI failed · api #1", "Merged · api #2"]);
  assert.deepEqual(s.quota, [{ key: "p", label: "Personal", h5: 12, d7: 0 }]);
  assert.equal(awaySummary({ since: 0, now: 1, agents: [{ address: "t4", status: "idle" }], worked: new Set(), events: [] }), null);
});

test("timeWithin: only the part of each stretch inside the window", () => {
  assert.equal(timeWithin([{ start: 0, end: 100 }, { start: 150, end: 400 }, { start: 500, end: 600 }], 50, 300), 50 + 150);
});

test("parseIndex: newest per account and session, malformed lines skipped", () => {
  const text = ["p\t100\t/a\ts1", "p\t300\t/a\ts1", "t\t200\t/b\ts1", "p\tx\t/a\ts2", "bad"].join("\n");
  assert.deepEqual(parseIndex(text), [{ account: "p", at: 300, project: "/a", id: "s1" }, { account: "t", at: 200, project: "/b", id: "s1" }]);
});

test("parseDetails: last field wins, a cut string is closed, a half escape dropped", () => {
  const text = ['s1\t"file":true', 's1\t"gitBranch":"old"', 's1\t"gitBranch":"main"', 's1\t"prNumber":12',
    's2\t"file":true', 's2\t"lastPrompt":"a long prompt cut', 's3\t"lastPrompt":"cut in an escape \\u00', "no tab"].join("\n");
  const d = parseDetails(text);
  assert.deepEqual(d.s1, { file: true, gitBranch: "main", prNumber: 12 });
  assert.equal(titleOf(d.s2), "a long prompt cut");
  assert.equal(titleOf(d.s3), "cut in an escape");
  assert.equal(titleOf({ customTitle: "Named", lastPrompt: "x" }), "Named");
});

test("inRepo and matches", () => {
  assert.ok(inRepo("/r/app", "/r/app", "app", "/h"));
  assert.ok(inRepo("/r/app/sub", "/r/app", "app", "/h"));
  assert.ok(inRepo("/h/.herdr/worktrees/app/feat", "/r/app", "app", "/h"));
  assert.ok(!inRepo("/r/app2", "/r/app", "app", "/h"));
  assert.ok(!inRepo("/r/app", null, "app", "/h"));
  const row = { title: "Fix the CI", project: "/r/portavoz", branch: "feat/trim", account: "personal" };
  assert.ok(matches(row, "ci portavoz"));
  assert.ok(matches(row, "TRIM"));
  assert.ok(!matches(row, "ci gancho"));
});
