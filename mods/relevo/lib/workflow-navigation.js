// Queue navigation follows task outcomes; browsing never starts work.
export const workflowBucket = (task) => ["needs_you", "blocked", "failed"].includes(task.state) ? "Needs you"
  : ["accepted", "cancelled"].includes(task.state) ? "Completed" : "In progress";

export const workflowItems = (tasks, bucket) => {
  const items = tasks.filter((task) => workflowBucket(task) === bucket);
  // Ready decisions stay reachable even when an older failed attempt needs recovery.
  return bucket === "Needs you" ? items.sort((a, b) => Number(b.state === "needs_you") - Number(a.state === "needs_you")) : items;
};

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
  return { title: "Work continues", detail: "The coordinator will bring the next result here. You can leave this screen." };
}
