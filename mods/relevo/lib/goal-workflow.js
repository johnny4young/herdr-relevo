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
  const attention = current.find((task) => task.state === 'needs_you') ?? current.find((task) => ['blocked', 'failed'].includes(task.state));
  if (attention) return { status: attention.state === 'needs_you' ? 'Ready for your review' : 'Needs attention', detail: attention.title,
    label: attention.state === 'needs_you' ? 'Review result' : 'Resolve blocker', action: 'workflow', attention: true };
  if (current.length) {
    const planned = current.every((task) => task.state === 'planned');
    const live = current.find((task) => task.attempts?.some((attempt) => attempt.state === "running"));
    const paused = !live && (!engine?.enabled || current.every((task) => task.paused));
    return { status: planned ? 'Ready to start' : paused ? 'Automation paused' : 'Agents working',
      detail: current.find((task) => task.state === 'running')?.title ?? current[0].title,
      label: planned ? 'Review plan' : paused ? 'Continue work' : 'View progress', action: 'workflow' };
  }
  if (tasks.some((task) => task.goalId === goal.id && task.state === 'accepted')) return {
    status: 'Results accepted', detail: 'Review remaining outcomes or plan the next task.', label: 'Open mission', action: 'workflow' };
  if (goal.decision?.trim() && linkedDecision(goal, tasks, error).state === "separate") return { status: 'Decision needed', detail: goal.decision.trim(), label: 'Review decision', action: 'decision', attention: true };
  if (reviewCount) return { status: 'Changes to review', detail: `${reviewCount} linked ${reviewCount === 1 ? 'change' : 'changes'}`, label: 'Review changes', action: 'review' };
  return { status: goal.state === 'completed' ? 'Mission completed' : 'Ready to plan',
    detail: goal.state === 'completed' ? 'Saved outcomes and decisions remain available.' : 'Set the outcome. Assign agents. Review their result.',
    label: goal.state === 'completed' ? 'View history' : 'Plan agent work', action: 'workflow' };
}

// Linking is explicit and bound to the question text. Never infer human consent
// from matching prose, a finished agent, a cancelled task or an old revision.
export function linkedDecision(goal, tasks, error = null) {
  const separate = { state: 'separate', task: null };
  const link = goal.decisionLink;
  if (error || !goal.decision?.trim() || !link || link.question !== goal.decision.trim()) return separate;
  const task = tasks.find((task) => task.id === link.taskId && task.goalId === goal.id);
  if (!task || task.state === 'cancelled') return separate;
  if (task.state === 'accepted') {
    const latest = task.decisions?.at(-1);
    return latest?.outcome === 'accept' && Boolean(task.revision) && latest.revision === task.revision
      ? { state: 'resolved', task } : separate;
  }
  return ['planned', 'ready', 'running', 'needs_review', 'needs_you', 'blocked', 'failed'].includes(task.state)
    ? { state: 'linked', task } : separate;
}

export function runProgress(goalId, tasks, engine, error = null) {
  if (error) return 'Status unavailable. Open run details to retry.';
  const own = tasks.filter((task) => task.goalId === goalId);
  const active = own.filter((task) => !['accepted', 'cancelled'].includes(task.state));
  const live = active.find((task) => task.attempts?.some((attempt) => attempt.state === 'running'));
  if (live) {
    const attempt = [...live.attempts].reverse().find((attempt) => attempt.state === 'running');
    const reviewer = attempt.role === 'reviewer';
    const person = (reviewer ? live.reviewer : live.executor)?.label || (reviewer ? 'Reviewer' : 'Executor');
    if (attempt.delivery === 'uncertain') return `Assignment to ${person} is unconfirmed. Check delivery before retrying.`;
    if (attempt.delivery === 'sending') return `Sending ${reviewer ? 'review' : 'implementation'} assignment to ${person}.`;
    return `Awaiting ${reviewer ? 'review' : 'implementation'} report from ${person}. Next: ${reviewer ? 'your review' : 'checks and independent review'}.${!engine?.enabled || live.paused ? ' Further dispatches paused.' : ''}`;
  }
  const pending = active.find((task) => task.state === 'needs_you');
  if (pending) {
    const blocked = active.filter((task) => ['blocked', 'failed'].includes(task.state)).length;
    return blocked ? `${blocked} other ${blocked === 1 ? 'task is' : 'tasks are'} blocked. Review the ready result first.` : '';
  }
  const blocked = active.find((task) => ['blocked', 'failed'].includes(task.state));
  if (blocked) return `Blocked: ${blocked.error || 'open the findings to resolve the issue.'}`;
  if (!active.length) return '';
  if (active.every((task) => task.state === 'planned')) return 'Not started. Review the assignment before starting.';
  if (!engine?.enabled || active.every((task) => task.paused)) return 'Paused. Resume when you want agents to continue.';
  const waiting = active.find((task) => task.dependsOn?.some((id) => !own.some((parent) => parent.id === id && parent.state === 'accepted')));
  if (waiting) return 'Waiting for prerequisite acceptance. Eligible work continues automatically.';
  if (active.some((task) => task.state === 'needs_review')) return 'Queued for independent review. Next: your decision.';
  return 'Waiting for the next coordinator check. Next: assignment to an agent.';
}
