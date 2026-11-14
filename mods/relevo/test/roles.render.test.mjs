import { test } from "node:test";
import assert from "node:assert/strict";
import { renderRole } from "../runtime/roles.mjs";
import { cleanProgress, progressLine, reportNotes, reviewStatus } from "../lib/run-report.js";

const values = { taskId: "t", attemptId: "a", title: "T", criteria: "one\n\ntwo {{mustFix}}", root: "/r", feedback: "", maxMinutes: "5", mustFix: "major",
  checks: "c", checkResults: "[]", preferences: "", statusFile: "/s", statusExample: "{}", reportFile: "/f", reportExample: "{}" };

test("a role's file fills in, drops what is empty and never reads a value as a name", () => {
  const out = renderRole("reviewer", values);
  assert.match(out, /Expected outcome: one\n\ntwo \{\{mustFix\}\}/);
  assert.doesNotMatch(out, /Requested corrections/);
  assert.match(renderRole("reviewer", { ...values, feedback: "Fix it" }), /Requested corrections: Fix it/);
});

test("a name the coordinator doesn't give stops the prompt", () => {
  const { mustFix, ...rest } = values;
  assert.equal(mustFix, "major");
  assert.throws(() => renderRole("reviewer", rest), /uses \{\{mustFix\}\}/);
});

test("progress reads as one line, and the bar decides a review with findings", () => {
  assert.equal(progressLine(cleanProgress({ line: "Fixing tests", done: 40, left: 75 })), "Fixing tests · 40% · ~1h 15m left");
  assert.equal(progressLine(cleanProgress({ line: "Reading", done: "x", left: -3 })), "Reading");
  assert.equal(cleanProgress({ done: 5 }), null);
  const minor = [{ level: "minor" }], major = [{ level: "major" }];
  assert.equal(reviewStatus("changes_requested", minor, "major"), "completed");
  assert.equal(reviewStatus("changes_requested", minor, "minor"), "changes_requested");
  assert.equal(reviewStatus("completed", major, "blocker"), "completed");
  assert.equal(reviewStatus("blocked", major, "major"), "blocked");
});

test("a working run says what its agent last said, and when that was long ago", async () => {
  const { runProgress } = await import("../lib/goal-workflow.js");
  const now = Date.parse("2026-01-02T03:20:00Z");
  const task = (at) => [{ goalId: "g", state: "running", executor: { label: "Codex" }, reviewer: { label: "Claude" },
    attempts: [{ role: "executor", state: "running", delivery: "acknowledged", progress: { line: "Fixing tests", done: 40, left: 12, at } }] }];
  assert.equal(runProgress("g", task("2026-01-02T03:18:00Z"), { enabled: true }, null, now), "Codex: Fixing tests · 40% · ~12m left. Next: checks and independent review.");
  assert.match(runProgress("g", task("2026-01-02T03:00:00Z"), { enabled: true }, null, now), /~12m left · said 20m ago\. Next:/);
  const silent = task(); delete silent[0].attempts[0].progress;
  assert.match(runProgress("g", silent, { enabled: true }, null, now), /^Awaiting implementation report from Codex\./);
});

test("a report's notes list findings first, then what was not run or proven", () => {
  assert.deepEqual(reportNotes({ findings: [{ level: "major", where: "a.js:1", issue: "Wrong", fix: "Right" }], notRun: ["e2e"], notProven: ["offline"] }),
    ["[major] a.js:1: Wrong Fix: Right", "Not run: e2e", "Not proven: offline"]);
  assert.deepEqual(reportNotes({ status: "completed", summary: "old report" }), []);
});
