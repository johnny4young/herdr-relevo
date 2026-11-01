// From this folder: node --test 'test/*.test.mjs'. Covers the pure helpers in lib/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ago, duration, windowOf, FIVE_HOURS } from "../lib/time.js";
import { diffRows, lineKey } from "../lib/diff.js";
import { ownerOf, contextFor } from "../lib/context.js";
import { totals, weekStart, week, weekTable } from "../lib/ledger.js";
import { keyMap, formatShortcut } from "../lib/keys.js";
import { mapMine, mapRequested, unresolved } from "../lib/github.js";

const now = () => Math.floor(Date.now() / 1000);

test("ago: minutes, then hours up to two days, then days", () => {
  assert.equal(ago(now() - 30), "now");
  assert.equal(ago(now() - 5 * 60), "5m ago");
  assert.equal(ago(now() - 47 * 3600), "47h ago");
  assert.equal(ago(now() - 3 * 86400), "3d ago");
});

test("duration: minutes under an hour, then hours and padded minutes", () => {
  assert.equal(duration(25 * 60), "25m");
  assert.equal(duration(3600 + 5 * 60), "1h 05m");
});

test("windowOf: a window past its reset reads as empty", () => {
  assert.equal(windowOf(null, 0, FIVE_HOURS), null);
  assert.deepEqual(windowOf(80, now() - 10, FIVE_HOURS), { pct: 0, resets: null, pace: null });
  const w = windowOf(42.4, now() + FIVE_HOURS / 2, FIVE_HOURS);
  assert.equal(w.pct, 42);
  assert.ok(Math.abs(w.pace - 0.5) < 0.01);
});

test("diffRows: skips the file header and numbers both sides", () => {
  const rows = diffRows(["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -10,3 +10,3 @@", " same", "-old", "+new"]);
  assert.deepEqual(rows.map((r) => [r.kind, r.number ?? null]), [["@", null], [" ", 10], ["-", 11], ["+", 11]]);
  assert.equal(lineKey(rows[2]), "-11");
  assert.equal(lineKey(rows[3]), "+11");
});

test("contextFor: the owner picks the context, ssh aliases included", () => {
  const contexts = [{ key: "home", account: "a" }, { key: "work", account: "b", orgs: ["Acme"] }];
  assert.equal(ownerOf("git@github-work:acme/api.git"), "acme");
  assert.equal(contextFor("acme/api", contexts).key, "work");
  assert.equal(contextFor("https://github.com/someone/api", contexts).key, "home");
  assert.equal(contextFor("", contexts).key, "home");
});

test("totals: overlapping stretches on one ticket count once", () => {
  const since = 1000;
  const rows = [
    { start: 1000, end: 1600, jira: "ABC-1", repo: "api" },
    { start: 1300, end: 1900, jira: "ABC-1", repo: "api" },
    { start: 500, end: 1100, jira: null, repo: "web" },
    { start: 2000, end: 2030, jira: null, repo: "tiny" },
  ];
  assert.deepEqual(totals(rows, since), [
    { key: "ABC-1", repo: "api", jira: "ABC-1", seconds: 900 },
    { key: "web", repo: "web", jira: null, seconds: 100 },
  ]);
});

test("shortcuts: first combo per action, macOS modifier order", () => {
  const map = keyMap({ "cmd-alt-d": "relevo.review", "ctrl-r": "relevo.review", "cmd-alt-shift-w": "relevo.worktree-open" });
  assert.equal(formatShortcut(map["relevo.review"]), "⌥⌘D");
  assert.equal(formatShortcut(map["relevo.worktree-open"]), "⌥⇧⌘W");
  assert.equal(formatShortcut(undefined), "");
});

const pr = (over) => ({
  number: 1, title: "t", url: "u1", isDraft: false, updatedAt: "2026-10-30T10:00:00Z", reviewDecision: null,
  repository: { nameWithOwner: "me/repo" },
  commits: { nodes: [{ commit: { committedDate: "2026-10-30T09:00:00Z", statusCheckRollup: { state: "SUCCESS" } } }] },
  reviews: { nodes: [] }, reviewThreads: { nodes: [] }, ...over,
});

test("mapMine: only PRs that need something, with why and which skill", () => {
  const data = { viewer: { login: "me", pullRequests: { nodes: [
    pr({ url: "quiet" }),
    pr({ url: "draft", isDraft: true, reviewDecision: "CHANGES_REQUESTED" }),
    pr({ url: "ci", commits: { nodes: [{ commit: { committedDate: "2026-10-30T09:00:00Z", statusCheckRollup: { state: "FAILURE" } } }] } }),
    pr({ url: "threads", reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] } }),
    pr({ url: "review", reviews: { nodes: [{ author: { login: "copilot-pull-request-reviewer" }, state: "COMMENTED", submittedAt: "2026-10-30T09:30:00Z" }] } }),
  ] } } };
  const byUrl = Object.fromEntries(mapMine(data).map((p) => [p.url, p]));
  assert.deepEqual(Object.keys(byUrl).sort(), ["ci", "review", "threads"]);
  assert.deepEqual(byUrl.ci.skills, ["fix"]);
  assert.equal(byUrl.ci.hot, true);
  assert.equal(byUrl.threads.threads, 1);
  assert.deepEqual(byUrl.threads.reasons, []);
  assert.deepEqual(byUrl.review.reasons, ["review from copilot"]);
});

test("mapRequested: newest first, with unresolved threads", () => {
  const data = { search: { nodes: [
    { url: "old", updatedAt: "2026-10-01T00:00:00Z", repository: { nameWithOwner: "o/a" }, reviewThreads: { nodes: [{ isResolved: false }] } },
    { url: "new", updatedAt: "2026-10-30T00:00:00Z", repository: { nameWithOwner: "o/b" } },
    {},
  ] } };
  const list = mapRequested(data);
  assert.deepEqual(list.map((p) => p.url), ["new", "old"]);
  assert.equal(list[1].threads, 1);
  assert.equal(unresolved({}), 0);
});

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime() / 1000;

test("weekStart: the Monday at midnight, local time", () => {
  const wed = at(2026, 10, 28, 15, 30);
  assert.equal(weekStart(wed), at(2026, 10, 26));
  assert.equal(weekStart(wed, -1), at(2026, 10, 19));
  assert.equal(weekStart(at(2026, 11, 1, 23)), at(2026, 10, 26));
});

test("week: splits a stretch at midnight and merges parallel agents per day", () => {
  const start = at(2026, 10, 26);
  const rows = [
    { start: at(2026, 10, 26, 23, 0), end: at(2026, 10, 27, 1, 0), jira: "ABC-1", repo: "api" },
    { start: at(2026, 10, 27, 0, 30), end: at(2026, 10, 27, 1, 30), jira: "ABC-1", repo: "api" },
    { start: at(2026, 10, 30, 9, 0), end: at(2026, 10, 30, 9, 45), jira: null, repo: "web" },
    { start: at(2026, 10, 20, 9, 0), end: at(2026, 10, 20, 12, 0), jira: null, repo: "old" },
  ];
  const w = week(rows, start);
  assert.deepEqual(w.rows.map((r) => [r.key, r.days]), [
    ["ABC-1", [3600, 5400, 0, 0, 0, 0, 0]],
    ["web", [0, 0, 0, 0, 2700, 0, 0]],
  ]);
  assert.deepEqual(w.dayTotals, [3600, 5400, 0, 0, 2700, 0, 0]);
  assert.equal(w.total, 11700);
});

test("weekTable: tab-separated with empty cells for idle days", () => {
  const w = { days: [1, 2, 3, 4, 5, 6, 7], rows: [{ key: "ABC-1", jira: "ABC-1", repo: "api", days: [3600, 0, 0, 0, 0, 0, 0], total: 3600 }],
    dayTotals: [3600, 0, 0, 0, 0, 0, 0], total: 3600 };
  const lines = weekTable(w, (s) => `D${s}`, (s) => `${s / 3600}h`).split("\n");
  assert.equal(lines[0], "Ticket\tRepo\tD1\tD2\tD3\tD4\tD5\tD6\tD7\tTotal");
  assert.equal(lines[1], "ABC-1\tapi\t1h\t\t\t\t\t\t\t1h");
  assert.equal(lines[2], "Total\t\t1h\t\t\t\t\t\t\t1h");
});
