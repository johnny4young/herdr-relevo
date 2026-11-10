// Readiness describes what can be inspected, never approval or task completion.
export function reviewableWork(items, clones) {
  return items.filter((s) => !s.addressed && !s.draft && (s.kind === "local"
    ? s.item.kind === "diff" && Boolean(s.item.top)
    : s.kind === "pr" && Boolean(clones[s.pr.repo])));
}

export function scopeGoals(projection, id) {
  const selected = projection.groups.find((g) => g.goal.id === id);
  if (!selected) return { ...projection, scope: null, outsideCount: 0, outsideBlockers: 0 };
  const keys = new Set(selected.items.map((s) => s.key));
  const outside = projection.sources.filter((s) => !keys.has(s.key));
  return { ...projection, groups: [selected], unlinked: [], scope: selected.goal,
    outsideCount: outside.length, outsideBlockers: outside.filter((s) => s.blocked && !s.addressed).length };
}

// Task records drive the next action; saved free-form notes never override them.
export function missionNextAction(goal, tasks, engine, error, reviewCount = 0) {
  const current = tasks.filter((task) => task.goalId === goal.id && !['accepted', 'cancelled'].includes(task.state));
  if (error) return { status: 'Status unavailable', detail: 'Open mission control to reload task status.', label: 'Open mission', action: 'workflow', attention: true };
  const attention = current.find((task) => ['needs_you', 'blocked', 'failed'].includes(task.state));
  if (attention) return { status: attention.state === 'needs_you' ? 'Ready for your review' : 'Needs attention', detail: attention.title,
    label: attention.state === 'needs_you' ? 'Review result' : 'Resolve blocker', action: 'workflow', attention: true };
  if (current.length) {
    const planned = current.every((task) => task.state === 'planned');
    const paused = !engine?.enabled || current.every((task) => task.paused);
    return { status: planned ? 'Ready to start' : paused ? 'Automation paused' : 'Agents working',
      detail: current.find((task) => task.state === 'running')?.title ?? current[0].title,
      label: planned ? 'Review plan' : paused ? 'Continue work' : 'View progress', action: 'workflow' };
  }
  if (tasks.some((task) => task.goalId === goal.id && task.state === 'accepted')) return {
    status: 'Results accepted', detail: 'Review remaining outcomes or plan the next task.', label: 'Open mission', action: 'workflow' };
  if (goal.decision?.trim()) return { status: 'Decision needed', detail: goal.decision.trim(), label: 'Review decision', action: 'decision', attention: true };
  if (reviewCount) return { status: 'Changes to review', detail: `${reviewCount} linked ${reviewCount === 1 ? 'change' : 'changes'}`, label: 'Review changes', action: 'review' };
  return { status: goal.state === 'completed' ? 'Mission completed' : 'Ready to plan',
    detail: goal.state === 'completed' ? 'Saved outcomes and decisions remain available.' : 'Set the outcome. Assign agents. Review their result.',
    label: goal.state === 'completed' ? 'View history' : 'Plan agent work', action: 'workflow' };
}
