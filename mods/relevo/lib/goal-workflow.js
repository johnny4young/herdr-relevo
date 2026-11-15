import { progressLine } from './run-report.js';
import { role } from './run-words.js';
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

// A status the agent wrote this long ago may no longer be what it does.
const STALE_MS = 10 * 60000;

export function runProgress(goalId, tasks, engine, error = null, now = Date.now()) {
  if (error) return 'Status unavailable. Open run details to retry.';
  const own = tasks.filter((task) => task.goalId === goalId);
  const active = own.filter((task) => !['accepted', 'cancelled'].includes(task.state));
  const live = active.find((task) => task.attempts?.some((attempt) => attempt.state === 'running'));
  if (live) {
    const attempt = [...live.attempts].reverse().find((attempt) => attempt.state === 'running');
    const reviewer = attempt.role === 'reviewer', words = role(attempt.role);
    const person = (reviewer ? live.reviewer : live.executor)?.label || words.name;
    if (attempt.delivery === 'uncertain') return `Assignment to ${person} is unconfirmed. Check delivery before retrying.`;
    if (attempt.delivery === 'sending') return `Sending the ${words.noun}'s assignment to ${person}.`;
    const said = progressLine(attempt.progress), age = now - Date.parse(attempt.progress?.at ?? '');
    if (said) return `${person}: ${said}${age > STALE_MS ? ` · said ${Math.round(age / 60000)}m ago` : ''}. Next: ${reviewer ? 'your review' : 'tests and review'}.${!engine?.enabled || live.paused ? ' Further dispatches paused.' : ''}`;
    return `Awaiting the ${words.noun}'s report from ${person}. Next: ${reviewer ? 'your review' : 'tests and review'}.${!engine?.enabled || live.paused ? ' Further dispatches paused.' : ''}`;
  }
  const pending = active.find((task) => task.state === 'needs_you');
  if (pending) {
    const blocked = active.filter((task) => ['blocked', 'failed'].includes(task.state)).length;
    return blocked ? `${blocked} other ${blocked === 1 ? 'task is' : 'tasks are'} stuck. Review the ready result first.` : '';
  }
  const blocked = active.find((task) => ['blocked', 'failed'].includes(task.state));
  if (blocked) return `Stuck: ${blocked.error || 'open the findings to resolve the issue.'}`;
  if (!active.length) return '';
  if (active.every((task) => task.state === 'planned')) return 'Not started. Review the assignment before starting.';
  if (!engine?.enabled || active.every((task) => task.paused)) return 'Paused. Resume when you want agents to continue.';
  const waiting = active.find((task) => task.dependsOn?.some((id) => !own.some((parent) => parent.id === id && parent.state === 'accepted')));
  if (waiting) return 'Waiting for prerequisite acceptance. Eligible work continues automatically.';
  if (active.some((task) => task.state === 'needs_review')) return 'Queued for review. Next: your decision.';
  return 'Waiting for the next coordinator check. Next: assignment to an agent.';
}
