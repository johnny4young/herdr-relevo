import fs from 'node:fs';
import path from 'node:path';
import { privateDir, uid } from './store.mjs';

export { MAX_TASKS } from './store.mjs';
const DAY = 86400000;

const lastActivity = (task, events) => Math.max(Date.parse(task.createdAt ?? 0) || 0,
  ...[...task.attempts, ...task.decisions, ...events].map((item) => Date.parse(item.at) || 0));

// While a run is open, its plan reads a step as done from the accepted task and its decision from the linked one.
function heldByGoal(task, goal) {
  if (!goal || goal.state === 'completed') return false;
  return goal.decisionLink?.taskId === task.id || (task.state === 'accepted' && Boolean(task.goalStep));
}

// Finished tasks idle for `days`, unless their open run still reads them, live work depends on them,
// their plan is unfinished, or their worktree still exists. `goals` null means the goals file is unreadable.
export function archivable(doc, { days, now, goals, goalId }) {
  const eventsOf = Map.groupBy(doc.events, (e) => e.taskId);
  const goalOf = new Map((goals ?? []).map((goal) => [goal.id, goal]));
  const candidates = new Set(doc.tasks.filter((task) => ['accepted', 'cancelled'].includes(task.state) &&
    (!goalId || task.goalId === goalId) && goals && !heldByGoal(task, goalOf.get(task.goalId)) &&
    now - lastActivity(task, eventsOf.get(task.id) ?? []) >= days * DAY &&
    !(task.worktree && !task.worktree.removed && fs.existsSync(task.worktree.path))).map((task) => task.id));
  for (let changed = true; changed;) {
    changed = false;
    for (const task of doc.tasks) {
      if (candidates.has(task.id)) continue;
      for (const id of task.dependsOn) if (candidates.delete(id)) changed = true;
    }
    for (const plan of doc.plans ?? []) {
      if (plan.taskIds.every((id) => candidates.has(id))) continue;
      for (const id of plan.taskIds) if (candidates.delete(id)) changed = true;
    }
  }
  const plans = (doc.plans ?? []).filter((plan) => plan.taskIds.length && plan.taskIds.every((id) => candidates.has(id)));
  return { taskIds: [...candidates], planIds: plans.map((plan) => plan.id) };
}

// Removes the selection from the state and stages its records in a pending file: the caller
// publishes them only after the state commits, so a failed write never duplicates a record.
export function stageArchive(doc, dir, selection, now) {
  const ids = new Set(selection.taskIds), planIds = new Set(selection.planIds);
  if (!ids.size) return null;
  const tasks = doc.tasks.filter((task) => ids.has(task.id));
  const lines = [
    ...tasks.map((task) => ({ task, events: doc.events.filter((e) => e.taskId === task.id) })),
    ...(doc.plans ?? []).filter((plan) => planIds.has(plan.id)).map((plan) => ({ plan })),
  ].map((entry) => `${JSON.stringify({ archivedAt: new Date(now).toISOString(), ...entry })}\n`).join('');
  const folder = privateDir(path.join(dir, 'archive')), pending = path.join(folder, `.pending-${uid()}.jsonl`);
  fs.writeFileSync(pending, lines, { flag: 'wx', mode: 0o600 });
  doc.tasks = doc.tasks.filter((task) => !ids.has(task.id));
  doc.events = doc.events.filter((e) => !ids.has(e.taskId));
  if (doc.plans) doc.plans = doc.plans.filter((plan) => !planIds.has(plan.id));
  return { pending, file: path.join(folder, `${new Date(now).toISOString().slice(0, 7)}.jsonl`), count: ids.size,
    taskIds: [...ids], attemptIds: tasks.flatMap((task) => task.attempts.map((attempt) => attempt.id)) };
}

// After the state commit: the records join the monthly file, and the tasks' evidence and reports leave the disk.
export function publishArchive(dir, staged) {
  fs.appendFileSync(staged.file, fs.readFileSync(staged.pending), { mode: 0o600 });
  fs.rmSync(staged.pending, { force: true });
  const safe = /^[A-Za-z0-9-]+$/;
  for (const id of staged.taskIds.filter((id) => safe.test(id))) fs.rmSync(path.join(dir, 'artifacts', id), { recursive: true, force: true });
  for (const id of staged.attemptIds.filter((id) => safe.test(id))) fs.rmSync(path.join(dir, 'reports', `${id}.json`), { force: true });
}
