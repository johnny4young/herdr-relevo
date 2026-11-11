import fs from 'node:fs';
import path from 'node:path';
import { privateDir } from './store.mjs';

export { MAX_TASKS } from './store.mjs';
const DAY = 86400000;

const lastActivity = (task, events) => Math.max(Date.parse(task.createdAt ?? 0) || 0,
  ...[...task.attempts, ...task.decisions, ...events].map((item) => Date.parse(item.at) || 0));

// Finished tasks idle for `days`, unless live work still depends on them, their plan is unfinished,
// or their worktree still exists (its branch can still be proposed or removed from the queue).
export function archivable(doc, { days, now }) {
  const eventsOf = Map.groupBy(doc.events, (e) => e.taskId);
  const candidates = new Set(doc.tasks.filter((task) => ['accepted', 'cancelled'].includes(task.state) &&
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

// Appends the selection to a monthly JSONL file and removes it from the state. Runs inside a transaction.
export function archiveInto(doc, dir, selection, now) {
  const ids = new Set(selection.taskIds), planIds = new Set(selection.planIds);
  if (!ids.size) return 0;
  const file = path.join(privateDir(path.join(dir, 'archive')), `${new Date(now).toISOString().slice(0, 7)}.jsonl`);
  const lines = [
    ...doc.tasks.filter((task) => ids.has(task.id)).map((task) => ({ task, events: doc.events.filter((e) => e.taskId === task.id) })),
    ...(doc.plans ?? []).filter((plan) => planIds.has(plan.id)).map((plan) => ({ plan })),
  ].map((entry) => `${JSON.stringify({ archivedAt: new Date(now).toISOString(), ...entry })}\n`).join('');
  fs.appendFileSync(file, lines, { mode: 0o600 });
  doc.tasks = doc.tasks.filter((task) => !ids.has(task.id));
  doc.events = doc.events.filter((e) => !ids.has(e.taskId));
  if (doc.plans) doc.plans = doc.plans.filter((plan) => !planIds.has(plan.id));
  return ids.size;
}
