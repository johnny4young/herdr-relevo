// Queue navigation follows task outcomes; browsing never starts work.
export const workflowBucket = (task) => ["needs_you", "blocked", "failed"].includes(task.state) ? "Needs you"
  : ["accepted", "cancelled"].includes(task.state) ? "Completed" : "In progress";

export const workflowItems = (tasks, bucket) => {
  const items = tasks.filter((task) => workflowBucket(task) === bucket);
  // Ready decisions stay reachable even when an older failed attempt needs recovery.
  return bucket === "Needs you" ? items.sort((a, b) => Number(b.state === "needs_you") - Number(a.state === "needs_you")) : items;
};

export function workflowCheckSummary(task) {
  const results = Array.isArray(task.checksResult) ? task.checksResult : [];
  const latest = Array.isArray(task.attempts) ? task.attempts.at(-1) : null;
  const configured = Array.isArray(task.checks) ? task.checks.length : 0;
  if (!configured && !results.length) return { label: 'Not configured', tone: 'muted' };
  if (latest?.role === 'executor' && latest.state === 'running') return { label: 'Awaiting checks', tone: 'muted' };
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
  if (failures) return { label: `${failures} failed · ${passed}/${total} passed`, tone: 'failure' };

  const complete = results.length >= configured && results.every((result) => Number.isFinite(result?.code));
  return complete
    ? { label: `${passed}/${total} passed`, tone: 'normal' }
    : { label: `${passed}/${total} passed · incomplete`, tone: 'muted' };
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

const VERDICT = { completed: 'review approved', changes_requested: 'changes requested', blocked: 'review blocked' };
const since = (ms, now) => {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

// What a reviewer needs before opening a result: who, how far, checks, verdict, age.
export function resultMeta(task, now = Date.now()) {
  const review = [...(task.attempts ?? [])].reverse().find((attempt) => attempt.role === 'reviewer' && attempt.report);
  const agents = [task.executor?.label ?? task.executor?.address, task.reviewer?.label ?? task.reviewer?.address].filter(Boolean).join(' → ');
  const at = Date.parse(review?.at ?? task.attempts?.at(-1)?.at ?? '');
  return [agents, task.maxRounds ? `round ${task.round ?? 0}/${task.maxRounds}` : null, `checks ${workflowCheckSummary(task).label.toLowerCase()}`,
    review ? VERDICT[review.report.status] ?? review.report.status : null, Number.isFinite(at) ? since(at, now) : null].filter(Boolean).join(' · ');
}
