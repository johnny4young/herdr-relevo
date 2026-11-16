// Tasks that need the run coordinator alive: an attempt still out, or work it should start or deliver.
export const needsEngine = (tasks = []) => tasks.some((task) => !["accepted", "cancelled"].includes(task.state) &&
  (task.attempts?.at(-1)?.state === "running" || task.state === "running" || (!task.paused &&
    (["ready", "needs_review"].includes(task.state) || task.messages?.some((message) => message.status === "queued")))));
