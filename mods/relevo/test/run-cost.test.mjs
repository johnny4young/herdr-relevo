// Which transcript tokens an attempt and a goal are charged, from what the scanner keeps per run folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RUN_BUCKET_MS, addClaude, addCodex, cutDay, emptyState, prune, reportOf, runFolders } from "../lib/usage-scan.js";
import { runFolder } from "../lib/run-folder.js";
import { runSlug, worktreePath } from "../runtime/worktree.mjs";
import { attemptTokens, attemptWindow, goalCost } from "../lib/run-cost.js";
import { emptyGoals, newGoal, parseGoals, saveGoal } from "../lib/goals.js";

const DAY = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const at = (hhmmss) => `${DAY}T${hhmmss}.000Z`;
const WT = "/Users/me/.herdr/worktrees/app/fix-search-0a1b2c", OTHER = "/Users/me/.herdr/worktrees/app/other-run-ffffff";
let n = 0;
const msg = (ts, { sid = "s-exec", cwd = WT, input = 1, write = 100, read = 1000, output = 10, entrypoint = "cli" } = {}) =>
  ({ id: `msg_${String(++n).padStart(14, "0")}`, ts, model: "claude-x", entrypoint, input, write, read, output, h1: write, m5: 0, sid, cwd });
const claude = (state, msgs, path = "/h/.claude/projects/p/t.jsonl") =>
  addClaude(state, new Set(), { path, size: 1, msgs, titles: [] }, { account: "personal", kind: "main", project: () => "app", cut: cutDay() });
const codex = (state, path, cwd, events) =>
  addCodex(state, { path, size: 1, cwd, events: events.flatMap(([ts, total]) => [{ timestamp: ts }, { total_token_usage: total }]) }, { project: () => "app", cut: cutDay() });

const task = (attempts, extra = {}) => ({ id: "t1", goalId: "g1", maxMinutes: 20, worktree: { path: WT }, attempts, decisions: [], ...extra });
const attempt = (id, start, end, extra = {}) => ({ id, role: "executor", state: "reported", at: at(start), ...(end ? { endedAt: at(end) } : {}), ...extra });

test("the scanner keeps tokens by session and five minutes only for run worktrees, Codex too, and old ones age out", () => {
  assert.equal(runFolder(`${WT}/src/lib`), WT);
  assert.equal(runFolder("/Users/me/.herdr/worktrees/app/main"), null, "a worktree that is not a run's");
  assert.equal(runFolder("/Users/me/code/app"), null); assert.equal(runFolder(null), null);
  const made = worktreePath("/Users/me/code/app", runSlug("Fix: the Search!"), "/Users/me");
  assert.equal(runFolder(`${made}/src`), made, "the path the coordinator makes is one the scanner knows");

  const state = emptyState();
  claude(state, [msg(at("10:00:05")), msg(at("10:00:50"), { cwd: `${WT}/src` }), msg(at("10:07:00")), msg(at("10:04:00"), { cwd: "/Users/me/code/app" })]);
  codex(state, "/h/.codex/sessions/2026/rollout-abc.jsonl", WT, [
    [at("10:10:00"), { input_tokens: 300, cached_input_tokens: 100, output_tokens: 20 }],
    [at("10:16:00"), { input_tokens: 700, cached_input_tokens: 300, output_tokens: 50 }]]);
  codex(state, "/h/.codex/sessions/2026/rollout-else.jsonl", "/Users/me/code/app", [[at("10:10:00"), { input_tokens: 9, cached_input_tokens: 0, output_tokens: 9 }]]);
  const report = reportOf(state, 0), bucket = (hhmm) => Math.floor(Date.parse(at(`${hhmm}:00`)) / RUN_BUCKET_MS);
  assert.deepEqual(report.runs.map((s) => ({ ...s, spans: s.spans.length })), [
    { id: "rollout-abc", folder: WT, last: at("10:16:00"), spans: 2 }, { id: "s-exec", folder: WT, last: at("10:07:00"), spans: 2 }], "newest first");
  assert.deepEqual(report.runs.find((s) => s.id === "s-exec").spans, [[bucket("10:00"), 2202, 20], [bucket("10:05"), 1101, 10]]);
  assert.deepEqual(report.runs.find((s) => s.id === "rollout-abc").spans, [[bucket("10:10"), 300, 20], [bucket("10:15"), 400, 30]]);
  assert.deepEqual(Object.keys(report), ["updated", "rows", "sessions", "runs"], "the report only gained a field");
  assert.equal(report.rows.length > 0 && report.sessions.length > 0, true);

  const old = { v: 1, files: {}, projects: {}, rows: {}, sessions: {}, seen: {} };
  claude(old, [msg(at("10:00:05"))]);
  assert.equal(reportOf(old, 0).runs.length, 1, "a state saved before this still works");
  assert.deepEqual(reportOf(state, 0, new Set([OTHER])).runs, [], "a folder that is gone and out of the queue is left out");
  assert.equal(reportOf(state, 0, new Set([WT])).runs.length, 2); assert.deepEqual(runFolders(state), [WT]);
  prune(state, "9999-01-01", new Set());
  assert.deepEqual(reportOf(state, 0).runs, []);
});

test("the report's runs stay small however long and many the sessions", () => {
  const state = emptyState(), start = Date.now() - 20 * 86400000, stamp = (ms) => new Date(ms).toISOString();
  // One session writing every five minutes for twenty days, then two hundred sessions of five hours each.
  claude(state, Array.from({ length: 20 * 288 }, (_, i) => msg(stamp(start + i * RUN_BUCKET_MS), { sid: "s-long", read: 123456789, output: 123456 })));
  for (let run = 0; run < 200; run++) {
    const cwd = `/Users/me/.herdr/worktrees/app/run-${run}-abcdef`;
    claude(state, Array.from({ length: 60 }, (_, i) => msg(stamp(start + run * 3600000 + i * RUN_BUCKET_MS), { sid: `s-${run}`, cwd, read: 123456789, output: 123456 })));
  }
  const { runs } = reportOf(state, 0), spans = runs.reduce((count, s) => count + s.spans.length, 0);
  assert.ok(spans <= 8000, `${spans} spans`);
  assert.ok(JSON.stringify(runs).length < 250000, `${JSON.stringify(runs).length} bytes`);
  assert.ok(runs.some((s) => s.id === "s-long"), "the session still working is kept");
  assert.equal(runs.some((s) => s.id === "s-0"), false, "the oldest give way");
});

test("an attempt is charged the spans of its window, in its worktree, from its own session when known", () => {
  const state = emptyState();
  claude(state, [
    msg(at("09:59:00")), msg(at("10:00:30")), msg(at("10:05:00")), msg(at("10:09:59")), msg(at("10:11:00")),
    msg(at("10:05:00"), { sid: "s-review", output: 7 }), msg(at("10:20:30"), { sid: "s-review", output: 7 }),
    msg(at("10:05:00"), { sid: "s-other", cwd: OTHER, output: 500 }), msg(at("10:05:00"), { sid: "s-repo", cwd: "/Users/me/code/app", output: 500 }),
  ]);
  codex(state, "/h/.codex/sessions/rollout-run.jsonl", `${WT}/pkg`, [[at("10:06:00"), { input_tokens: 400, cached_input_tokens: 100, output_tokens: 40 }]]);
  const sessions = reportOf(state, 0).runs;
  const first = attempt("a1", "10:00:00", "10:09:00"), review = attempt("a2", "10:20:00", "10:25:30", { role: "reviewer" });
  const run = task([first, review]);

  // Three of the implementer's messages, the reviewer session's 10:05 one and Codex's: in the folder and in 10:00–10:10.
  assert.deepEqual(attemptTokens(first, run, sessions), { output: 30 + 7 + 40, context: 3 * 1101 + 1101 + 400, total: 77 + 4804, minutes: 9 });
  assert.deepEqual(attemptTokens(review, run, sessions), { output: 7, context: 1101, total: 1108, minutes: 5.5 });
  const own = { ...first, transcript: "/h/.claude/projects/p/s-exec.jsonl" };
  assert.deepEqual(attemptTokens(own, task([own, review]), sessions), { output: 30, context: 3303, total: 3333, minutes: 9 }, "its recorded session only");
  const restarted = { ...first, transcript: "/h/.claude/projects/p/s-gone.jsonl" };
  assert.equal(attemptTokens(restarted, task([restarted]), sessions).output, 77, "a transcript the folder never saw falls back to the folder");
  const codexOwn = { ...first, transcript: "/h/.codex/sessions/rollout-run.jsonl" };
  assert.deepEqual(attemptTokens(codexOwn, task([codexOwn]), sessions), { output: 40, context: 400, total: 440, minutes: 9 });

  const inPlace = task([first], { worktree: undefined });
  assert.deepEqual(attemptTokens(first, inPlace, sessions), { output: 0, context: 0, total: 0, minutes: 9 }, "existing sessions: time, no tokens");
  assert.deepEqual(attemptTokens(first, task([first], { worktree: { path: "/Users/me/.herdr/worktrees/app/fix-search-0a1b2" } }), sessions).total, 0, "a folder that only shares a prefix");
  assert.deepEqual(attemptTokens(first, run, null), { output: 0, context: 0, total: 0, minutes: 9 }, "no report yet");
});

test("a window ends at the report, else the next attempt, or now within the time limit", () => {
  const now = Date.parse(at("12:00:00"));
  const ended = attempt("a1", "10:00:00", "10:04:00");
  const old = attempt("a3", "10:20:00"), live = attempt("a4", "10:30:00", null, { state: "running" }), lost = attempt("a5", "11:00:00");
  const run = task([ended, old, live]), stale = task([ended, lost]);
  const minutes = (a, t = run, when = now) => { const w = attemptWindow(a, t, when); return w && (w.end - w.start) / 60000; };
  assert.deepEqual([ended, old].map((a) => minutes(a)), [4, 10]);
  assert.equal(minutes(live), 20, "a running attempt stops counting at its time limit");
  assert.equal(minutes(live, run, Date.parse(at("10:35:00"))), 5);
  assert.equal(minutes(lost, stale), null, "an old record with no end and nothing after it counts nothing");
  assert.equal(attemptWindow({ id: "x" }, run, now), null);
});

test("a goal adds up its own tasks and counts a shared span once", () => {
  const state = emptyState();
  claude(state, [msg(at("10:00:30")), msg(at("10:04:30")), msg(at("10:30:00")), msg(at("10:05:00"), { sid: "s-b", cwd: OTHER, output: 3 })]);
  const sessions = reportOf(state, 0).runs;
  // The implementer's report and the reviewer's assignment fall in the same five minutes.
  const one = task([attempt("a1", "10:00:00", "10:04:10"), attempt("a2", "10:04:20", "10:06:20", { role: "reviewer" })]);
  const two = task([attempt("b1", "10:05:00", "10:08:00")], { id: "t2", worktree: { path: OTHER } });
  const foreign = task([attempt("c1", "10:29:00", "10:31:00")], { id: "t3", goalId: "g2" });
  const each = [one, two].flatMap((t) => t.attempts.map((a) => attemptTokens(a, t, sessions)));
  assert.deepEqual(each.map((cost) => cost.output), [20, 0, 3], "the shared span goes to the earlier attempt");
  const whole = goalCost({ id: "g1" }, [one, two, foreign], sessions);
  assert.deepEqual(whole, { output: 23, context: 3303, total: 3326, minutes: 9.2 });
  assert.deepEqual(["output", "context", "total"].map((k) => each.reduce((n, cost) => n + cost[k], 0)), [whole.output, whole.context, whole.total], "the attempts add up to the goal");
  const edge = task([attempt("e1", "10:00:00", "10:30:00")]);
  assert.equal(attemptTokens(edge.attempts[0], edge, sessions).output, 20, "a span that starts as the window ends is the next attempt's");
  assert.equal(attemptWindow({ id: "r", at: at("10:00:00"), state: "running" }, { attempts: [] }, Date.parse(at("12:00:00"))).end, Date.parse(at("10:20:00")), "the coordinator's default limit");
  assert.deepEqual(goalCost({ id: "g2" }, [one, two, foreign], sessions), { output: 10, context: 1101, total: 1111, minutes: 2 });
  assert.deepEqual(goalCost({ id: "none" }, [one], sessions), { output: 0, context: 0, total: 0, minutes: 0 });
});

test("a goal's limits are optional whole numbers, and goals without them stay valid", () => {
  const goal = { ...newGoal("g1", "Usable search"), owner: "Human" };
  const saved = saveGoal(emptyGoals(), goal, 0);
  assert.equal("maxAgentMinutes" in saved.goals[0] || "maxTokens" in saved.goals[0], false, "none by default");
  assert.equal(parseGoals(JSON.stringify(saved)).goals.length, 1, "an older file reads as before");
  const capped = saveGoal(saved, { ...saved.goals[0], maxAgentMinutes: 90, maxTokens: 2000000 }, 1);
  assert.deepEqual([capped.goals[0].maxAgentMinutes, capped.goals[0].maxTokens], [90, 2000000]);
  assert.equal(saveGoal(capped, { ...capped.goals[0], maxAgentMinutes: null, maxTokens: undefined }, 2).goals[0].maxAgentMinutes, null);
  for (const bad of [{ maxAgentMinutes: 0 }, { maxAgentMinutes: 1.5 }, { maxAgentMinutes: "90" }, { maxAgentMinutes: 100001 }, { maxTokens: -1 }, { maxTokens: 1e13 }, { maxTokens: Infinity }]) {
    assert.throws(() => saveGoal(saved, { ...saved.goals[0], ...bad }, 1), /Invalid goal limit/, JSON.stringify(bad));
  }
});
