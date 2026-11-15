// What a run's attempts cost, from the token scanner's report (`report.runs`); pure, so the tests can feed it fixtures.
// A session counts for an attempt only when its folder is the run's worktree or inside it, and only for the
// five-minute spans its window touches. An attempt whose recorded transcript is among those sessions counts that one
// alone. A run on existing sessions has no worktree, so it counts time and no tokens.
import { RUN_BUCKET_MS, sessionOf } from "./usage-scan.js";

const time = (iso) => { const at = Date.parse(iso ?? ""); return Number.isFinite(at) ? at : null; };

// From the assignment to the report, timeout or reconciliation. An older record without an end takes the next
// attempt's start; one still running takes now, up to its time limit.
export function attemptWindow(attempt, task, now = Date.now(), index = task.attempts.findIndex((a) => a.id === attempt?.id)) {
  const start = time(attempt?.at);
  if (start == null) return null;
  const running = attempt.state === "running" ? Math.min(now, start + (task.maxMinutes ?? 120) * 60000) : null;
  const end = time(attempt.endedAt) ?? time(task.attempts[index + 1]?.at) ?? running;
  return end != null && end >= start ? { start, end } : null;
}

// The sessions that worked in the task's worktree.
function sessionsOf(task, sessions) {
  const root = task.worktree?.path;
  return root ? (sessions ?? []).filter((s) => typeof s?.folder === "string" && (s.folder === root || s.folder.startsWith(`${root}/`))) : [];
}

const tally = () => ({ output: 0, context: 0, ms: 0, seen: new Set() });

// Adds one attempt to the tally; a span another attempt already took is not counted again.
function add(sum, attempt, index, task, here, now) {
  const window = attemptWindow(attempt, task, now, index);
  if (!window) return;
  sum.ms += window.end - window.start;
  const from = Math.floor(window.start / RUN_BUCKET_MS), to = Math.floor(window.end / RUN_BUCKET_MS);
  const id = typeof attempt.transcript === "string" ? sessionOf(attempt.transcript) : null, own = here.some((s) => s.id === id);
  for (const s of here) {
    if (own && s.id !== id) continue;
    for (const [bucket, context, output] of s.spans ?? []) {
      const key = `${s.folder}\t${s.id}\t${bucket}`;
      if (bucket < from || bucket > to || sum.seen.has(key)) continue;
      sum.seen.add(key);
      sum.context += context;
      sum.output += output;
    }
  }
}

const result = ({ output, context, ms }) => ({ output, context, total: output + context, minutes: Math.round(ms / 6000) / 10 });

export function attemptTokens(attempt, task, sessions, now = Date.now()) {
  const sum = tally();
  add(sum, attempt, task.attempts.findIndex((a) => a.id === attempt.id), task, sessionsOf(task, sessions), now);
  return result(sum);
}

// Every attempt of the goal's tasks still in the queue.
export function goalCost(goal, tasks, sessions, now = Date.now()) {
  const sum = tally();
  for (const task of tasks ?? []) {
    if (task.goalId !== goal.id) continue;
    const here = sessionsOf(task, sessions);
    task.attempts.forEach((attempt, index) => add(sum, attempt, index, task, here, now));
  }
  return result(sum);
}
