// Queue navigation follows task outcomes; browsing never starts work.
import { verdictLine, attemptLabel } from "./run-words.js";

export const workflowBucket = (task) => ["needs_you", "blocked", "failed"].includes(task.state) ? "Needs me"
  : ["accepted", "cancelled"].includes(task.state) ? "Completed" : "In progress";

export const workflowItems = (tasks, bucket) => {
  const items = tasks.filter((task) => workflowBucket(task) === bucket);
  // Ready decisions stay reachable even when an older failed attempt needs recovery.
  return bucket === "Needs me" ? items.sort((a, b) => Number(b.state === "needs_you") - Number(a.state === "needs_you")) : items;
};

// A decision is only for the revision on screen, and only while that task still waits.
export function decideGuard(task, tasks) {
  const current = (tasks ?? []).find((item) => item.id === task.id);
  return task.state === "needs_you" && Boolean(current) && current.revision === task.revision && current.state === "needs_you";
}
export const decidePayload = (task, outcome, text = "") => ({ action: "decide", taskId: task.id, outcome, text, revision: task.revision ?? "" });
// A arms the acceptance of one revision; Enter confirms it only while it is still that revision.
export const armAccept = (task) => ({ id: task.id, revision: task.revision });
export const acceptArmed = (intent, task) => intent?.id === task.id && intent.revision === task.revision;

const checkName = (check) => {
  const name = Array.isArray(check?.argv) ? check.argv.join(" ") : "";
  return name.length > 32 ? `${name.slice(0, 31)}…` : name;
};
// The tests a check ran, from the summary line of common runners (node --test, Jest, Vitest, Mocha, pytest); else null.
export function testCount(output) {
  const text = String(output ?? "");
  const n = /^[ℹ#] tests (\d+)$/m.exec(text)?.[1] ?? /Tests:?\s+(\d+) passed/.exec(text)?.[1] ?? /(\d+) passing\b/.exec(text)?.[1]
    ?? /=+ (\d+) passed\b/.exec(text)?.[1];
  return n == null ? null : Number(n);
}
const tests = (n) => (n == null ? "" : ` · ${n} ${n === 1 ? "test" : "tests"}`);
export const checks = (n) => `${n} ${n === 1 ? "check" : "checks"}`;

// A run's checks in a line: what ran and how it went, or "tests not configured" and the like.
const checkWords = (task) => { const c = workflowCheckSummary(task); return ["normal", "failure"].includes(c.tone) ? c.label : `tests ${c.label.toLowerCase()}`; };

// Says which command ran and, when its runner prints it, how many tests: "npm test passed · 3 tests". Several
// commands are counted as checks, since one command can run any number of tests.
export function workflowCheckSummary(task) {
  const results = Array.isArray(task.checksResult) ? task.checksResult : [];
  const latest = Array.isArray(task.attempts) ? task.attempts.at(-1) : null;
  const configured = Array.isArray(task.checks) ? task.checks.length : 0;
  if (!configured && !results.length) return { label: 'Not configured', tone: 'muted' };
  if (latest?.role === 'executor' && latest.state === 'running') return { label: 'Awaiting tests', tone: 'muted' };
  // A non-completed implementation does not run checks; the store can still
  // contain a preceding round's results for its history.
  if (latest?.role === 'executor' && latest.state === 'reported' && latest.report?.status && latest.report.status !== 'completed') {
    return { label: 'Not run', tone: 'muted' };
  }
  if (configured && !results.length) return { label: 'Not run', tone: 'muted' };

  const total = Math.max(configured, results.length);
  const passed = results.filter((result) => Number.isFinite(result?.code) && result.code === 0).length;
  const failures = results.filter((result) => {
    const code = result?.code;
    return (Number.isFinite(code) && code !== 0) ||
      (typeof code === 'string' && code.trim() !== '' && !['0', 'cancelled'].includes(code));
  }).length;
  const failed = (result) => (Number.isFinite(result?.code) && result.code !== 0) ||
    (typeof result?.code === 'string' && result.code.trim() !== '' && !['0', 'cancelled'].includes(result.code));
  // Older records keep the command only in the task's checks.
  const nameAt = (i) => checkName(results[i]) || checkName({ argv: task.checks?.[i] });
  const one = total === 1 && results.length === 1 && nameAt(0);
  if (failures) {
    if (one) return { label: `${one} failed`, tone: 'failure' };
    const first = nameAt(results.findIndex(failed));
    return { label: `${failures} of ${checks(total)} failed${first ? `: ${first}` : ''}`, tone: 'failure' };
  }

  const complete = results.length >= configured && results.every((result) => Number.isFinite(result?.code));
  if (!complete) return { label: `${passed} of ${checks(total)} passed · incomplete`, tone: 'muted' };
  if (one) return { label: `${one} passed${tests(testCount(results[0].stdout))}`, tone: 'normal' };
  const counts = results.map((result) => testCount(result.stdout));
  return { label: `${checks(total)} passed${counts.every((n) => n != null) ? tests(counts.reduce((a, b) => a + b, 0)) : ''}`, tone: 'normal' };
}

export function acceptanceEffect(task, tasks, engine) {
  const next = tasks.filter((item) => item.dependsOn?.includes(task.id) && !["accepted", "cancelled"].includes(item.state));
  if (!next.length) return "Accepting finishes this task. No follow-up task is defined.";
  const ready = next.filter((item) => item.state === "ready" && !item.paused && item.dependsOn.every((id) =>
    id === task.id || tasks.some((parent) => parent.id === id && parent.state === "accepted")));
  if (engine?.enabled && ready.length) return `${ready.length} follow-up ${ready.length === 1 ? "task" : "tasks"} will continue automatically when their agents are available.`;
  if (next.some((item) => item.paused) || !engine?.enabled) return "Follow-up work is paused. Accepting saves your decision; it does not resume stopped work.";
  if (next.some((item) => item.state === "planned")) return "A follow-up is planned but has not been started. Your decision will be saved.";
  return "Follow-up work is waiting for its remaining dependencies.";
}

export function queueSummary(tasks, engine) {
  const active = workflowItems(tasks, "In progress");
  const accepted = tasks.filter((task) => task.state === "accepted").length;
  if (!active.length) return { title: "You're all caught up", detail: accepted
    ? `${accepted} ${accepted === 1 ? "task" : "tasks"} accepted. No further work is scheduled for this goal.` : "No decisions are waiting for you." };
  if (active.every((task) => task.state === "planned")) return { title: "No decisions waiting", detail: `${active.length} ${active.length === 1 ? "task is" : "tasks are"} planned but not started.` };
  if (!engine?.enabled || active.every((task) => task.paused)) return { title: "No decisions waiting", detail: "Work is paused. Your decisions are saved; resume a task when you want to continue." };
  return { title: "Work continues", detail: "The next result will come back here." };
}

const since = (ms, now) => {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

// The reviewer's latest report on a task, if any.
export const lastReview = (task) => [...(task.attempts ?? [])].reverse().find((attempt) => attempt.role === 'reviewer' && attempt.report);

// What a reviewer needs before opening a result: who, how far, tests, verdict, age.
export function resultMeta(task, now = Date.now()) {
  const review = lastReview(task);
  const agents = [task.executor?.label ?? task.executor?.address, task.reviewer?.label ?? task.reviewer?.address].filter(Boolean).join(' → ');
  const at = Date.parse(review?.at ?? task.attempts?.at(-1)?.at ?? '');
  return [agents, attemptLabel(task.round, task.maxRounds), checkWords(task),
    review ? verdictLine(review.report.status).toLowerCase() : null, Number.isFinite(at) ? since(at, now) : null].filter(Boolean).join(' · ');
}
