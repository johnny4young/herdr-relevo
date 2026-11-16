// What the Runs panel says about a run's cost, a task's attempts and a selection of results; pure, so the tests can run it under Node.
import { count, role, VERDICT } from "./run-words.js";
import { checks, lastReview, workflowCheckSummary } from "./workflow-navigation.js";
import { batchScope } from "./workflow-preferences.js";
import { attemptTokens, attemptWindow } from "./run-cost.js";
import { compact } from "./usage.js";

const TERMINAL = ["accepted", "cancelled"];
const firstLine = (s, limit = 80) => {
  const line = String(s ?? "").trim().split("\n")[0];
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};
const person = (task, key) => task[key]?.label ?? task[key]?.address ?? role(key).name;
const minutes = (ms) => (ms == null ? null : ms < 30000 ? "under 1 min" : `${Math.round(ms / 60000)} min`);

// The run's cost against its caps, then what the cost bought. A cap is display only.
export function runCostLine(goal, bucket, cost, prs = 0) {
  const meter = (used, cap, words, unit) => ({ used, cap: cap ?? null, pct: cap ? Math.round((used / cap) * 100) : null, over: Boolean(cap) && used >= cap,
    text: `${cap ? `${words(used)} of ${words(cap)}` : words(used)} ${unit}` });
  const attempts = bucket.all.reduce((n, task) => n + (task.attempts ?? []).filter((attempt) => attempt.role !== "reviewer").length, 0);
  let passed = 0, total = 0;
  for (const task of bucket.all) {
    const results = task.checksResult ?? [];
    total += Math.max(task.checks?.length ?? 0, results.length);
    passed += results.filter((check) => check?.code === 0).length;
  }
  return { minutes: meter(cost.minutes, goal.maxAgentMinutes, (n) => String(Math.round(n)), "agent min"),
    tokens: cost.total > 0 || goal.maxTokens ? meter(cost.total, goal.maxTokens, compact, "tokens") : null,
    rest: [count(attempts, "attempt"), total ? `${passed} of ${checks(total)} passed` : null, prs ? `${count(prs, "PR")} shipped` : null].filter(Boolean) };
}

// Paused work that was under way: what Resume automation resumes. Planned and stuck tasks stay as they are.
export const resumable = (bucket) => bucket.all.filter((task) => task.paused && ["ready", "running", "needs_review"].includes(task.state));

// A task's attempts: each time it was written, with the review that followed.
export function taskRounds(task) {
  const rounds = [];
  for (const attempt of task.attempts ?? []) {
    if (attempt.role !== "reviewer") rounds.push({ n: rounds.length + 1, writer: attempt, reviewer: null });
    else if (rounds.length) rounds.at(-1).reviewer = attempt;
  }
  return rounds;
}
export const canCompare = (task) => taskRounds(task).length >= 2;
export const tookWords = (task) => `took ${count(taskRounds(task).length, "attempt")}`;

const roundMs = (round, task, now) => {
  const start = attemptWindow(round.writer, task, now), end = (round.reviewer && attemptWindow(round.reviewer, task, now)) ?? start;
  return start && end ? Math.max(0, end.end - start.start) : null;
};

function roundVerdict({ writer, reviewer }) {
  const status = reviewer?.report?.status;
  if (status) return { ok: status === "completed", word: (VERDICT[status] ?? status).toLowerCase() };
  if (reviewer?.state === "running") return { ok: null, word: "reviewing" };
  if (writer.state === "running") return { ok: null, word: "writing" };
  if (writer.timedOut) return { ok: false, word: "timed out" };
  if (writer.report && writer.report.status !== "completed") return { ok: false, word: "could not finish" };
  if (writer.tests && writer.tests.passed < writer.tests.total) return { ok: false, word: "tests failed" };
  return { ok: null, word: "not reviewed" };
}

// "attempt 2: Codex Luna → Team Haiku · 9 min · approved", one line per attempt.
export function attemptHistory(task, now = Date.now()) {
  return taskRounds(task).map((round) => {
    const verdict = roundVerdict(round);
    return { n: round.n, ok: verdict.ok,
      text: [`attempt ${round.n}: ${person(task, "executor")}${round.reviewer ? ` → ${person(task, "reviewer")}` : ""}`, minutes(roundMs(round, task, now)), verdict.word]
        .filter(Boolean).join(" · ") };
  });
}

export const COMPARE_COLUMNS = 3;
const NOT_KEPT = { text: "not kept", quiet: true }, NONE = { text: "none", quiet: true };

// The table of the compare view: one column per attempt (the last three), one row per question.
export function compareAttempts(task, sessions = [], now = Date.now()) {
  const all = taskRounds(task), rounds = all.slice(-COMPARE_COLUMNS), decisions = task.decisions ?? [];
  const noteOf = (round) => {
    const from = Date.parse(round.writer.at ?? ""), until = Date.parse(all[round.n]?.writer.at ?? "");
    return decisions.filter((d) => d.text?.trim() && Date.parse(d.at) >= from && !(Date.parse(d.at) >= until)).at(-1)?.text;
  };
  const cells = {
    said: (round) => {
      const verdict = roundVerdict(round), report = round.reviewer?.report;
      const finding = verdict.ok === false && report ? firstLine(report.findings?.[0]?.issue ?? report.summary, 60) : "";
      return { text: finding ? `${verdict.word}: ${finding}` : verdict.word, ok: verdict.ok };
    },
    tests: (round) => (round.writer.tests ? { text: `${round.writer.tests.passed} of ${checks(round.writer.tests.total)} passed`, ok: round.writer.tests.passed === round.writer.tests.total }
      : round.writer.report && round.writer.report.status !== "completed" ? { text: "not run", quiet: true }
      : round.n === all.length && task.checks?.length ? { text: workflowCheckSummary(task).label.toLowerCase() } : task.checks?.length ? NOT_KEPT : { text: "not configured", quiet: true }),
    change: ({ writer }) => (writer.change ? { text: count(writer.change.files, "file"), added: writer.change.added, removed: writer.change.removed } : NOT_KEPT),
    took: (round) => ({ text: minutes(roundMs(round, task, now)) ?? "unknown" }),
    cost: ({ writer, reviewer }) => {
      const total = [writer, reviewer].filter(Boolean).reduce((n, attempt) => n + attemptTokens(attempt, task, sessions, now).total, 0);
      return total ? { text: `${compact(total)} tokens` } : { text: task.worktree ? "no tokens read" : "not counted", quiet: true };
    },
    note: (round) => { const note = noteOf(round); return note ? { text: firstLine(note, 120) } : NONE; },
  };
  const row = (key, label) => ({ key, label, cells: rounds.map(cells[key]) });
  return { took: tookWords(task), columns: rounds.map((round) => ({ n: round.n, label: `Attempt ${round.n}` })),
    rows: [row("said", "Reviewer said"), row("tests", "Tests"), row("change", "Change"), row("took", "Took"), row("cost", "Cost"), row("note", "Your note")],
    // The two attempts "See what changed between them" compares.
    diff: all.length >= 2 && task.worktree && !task.worktree.removed ? { from: all.at(-2).writer.id, to: all.at(-1).writer.id } : null };
}

export const DIFF_FILES = 50;
// The files of an attempt-diff answer, capped, with how many it leaves out.
export function diffFiles(result) {
  const list = (result?.list ?? []).slice(0, DIFF_FILES), files = result?.files ?? list.length;
  return { head: `${count(files, "file")} changed`, added: result?.added ?? 0, removed: result?.removed ?? 0, list, more: Math.max(0, files - list.length) };
}

// What accepting does next, short enough for a row.
export function thenWords(task, tasks, engine) {
  const next = tasks.filter((item) => item.dependsOn?.includes(task.id) && !TERMINAL.includes(item.state));
  if (!next.length) return "then: done";
  const accepted = (id) => id === task.id || tasks.some((item) => item.id === id && item.state === "accepted");
  const ready = next.filter((item) => item.state === "ready" && !item.paused && engine?.enabled && item.dependsOn.every(accepted));
  return ready.length ? `then: ${count(ready.length, "follow-up")} ${ready.length === 1 ? "starts" : "start"}` : `then: ${count(next.length, "follow-up")} still ${next.length === 1 ? "waits" : "wait"}`;
}

// The results a selection holds: what is true of all of them, or what isn't, and whether one command can take them.
export function batchSummary(picked) {
  const scopes = new Set(picked.map(batchScope));
  const rejected = picked.filter((task) => lastReview(task)?.report?.status !== "completed").length;
  const failing = picked.filter((task) => workflowCheckSummary(task).tone === "failure").length;
  const untested = picked.filter((task) => !["normal", "failure"].includes(workflowCheckSummary(task).tone)).length;
  const issues = [scopes.size > 1 ? "more than one repository" : null, rejected ? `${rejected} not approved` : null,
    failing ? `${failing} with failing tests` : null, untested ? `${untested} without test results` : null].filter(Boolean);
  return { ok: picked.length > 0 && scopes.size === 1, clean: !issues.length, text: issues.join(" · ") || "all approved, all tests pass",
    repository: scopes.size === 1 ? String([...scopes][0] ?? "").split("/").pop() : null };
}

// Every result of the run in the same repository as `task`.
export const sameRepository = (task, tasks) => tasks.filter((item) => item.state === "needs_you" && batchScope(item) === batchScope(task));
