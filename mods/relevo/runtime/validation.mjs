import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { taskById, uid } from './store.mjs';
import { RUN_BRANCH, BASE_BRANCH } from './worktree.mjs';
import { MAX_TASKS } from './archive.mjs';
import { TEXT_MAX, DEFAULT_MAX_MINUTES } from '../lib/run-report.js';

export const terminalStates = new Set(['accepted', 'cancelled']);
export const text = (value, max = 4000) => typeof value === 'string' && value.trim() && value.length <= max;
export const PR_URL = /^https:\/\/github\.com\/[^\s]+\/pull\/\d+$/;
export const recipient = (actor) => actor && /^[a-zA-Z0-9][-a-zA-Z0-9_/]*$/.test(actor.address ?? '');
// Reports prove their attempt with a token only the prompt carries; state keeps its hash.
export const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex');
export const statusOf = (actor) => typeof actor.status === 'string' ? actor.status : actor.status?.state;
// An unreported attempt keeps its checkout and agents until it reports or a human reconciles it.
export const holdsCheckout = (task) => task.attempts.at(-1)?.state === 'running';
export const agentName = (actor) => actor.label || actor.address;

// Why a task that could start must wait, or null. A cancelled task's unreconciled attempt still holds its checkout
// and agents, but not one of the run slots.
export function slotWait(doc, task, actor) {
  const active = doc.tasks.filter((other) => other.id !== task.id && holdsCheckout(other));
  const same = active.find((other) => other.root === task.root);
  if (same) return `Waits for “${same.title}”, which works in the same checkout.`;
  const busy = active.find((other) => [other.executor?.address, other.reviewer?.address].includes(actor.address));
  if (busy) return `Waits for ${agentName(actor)}, which works on “${busy.title}”.`;
  const max = doc.engine.maxConcurrent;
  if (active.filter((other) => !terminalStates.has(other.state)).length < max) return null;
  return `Waits for a free slot: ${max} ${max === 1 ? 'task runs' : 'tasks run'} at once.`;
}

export const checkoutBusy = (doc, task, actor) => Boolean(slotWait(doc, task, actor));
// When an attempt's limit falls: its start plus the time the machine slept (`pausedMs`), which no agent works through.
export const attemptDue = (attempt, maxMinutes) => Date.parse(attempt.at) + (attempt.pausedMs ?? 0) + maxMinutes * 60000;
export const roomFor = (doc, count) => { if (doc.tasks.length + count > MAX_TASKS) throw Error(`The queue holds ${MAX_TASKS} tasks; archive finished ones before adding more`); };

export function validateTask(input, doc, { home, clock, allowedNewDependencies = [] }) {
  if (!input || !text(input.goalId, 100) || !text(input.title, 240) || !text(input.criteria, TEXT_MAX) || !path.isAbsolute(input.root ?? '')) throw Error('Choose a goal, title, repository and expected outcome');
  const goals = JSON.parse(fs.readFileSync(path.join(home, 'relevo-goals.json'), 'utf8'));
  if (!goals.goals?.some((g) => g.id === input.goalId && g.state !== 'completed')) throw Error('Choose an open goal');
  // A pull request's review has no writer here: its findings go to a draft review or a fix run, not to an agent.
  const prReview = input.reviewOnly === true && !input.worktree && PR_URL.test(input.pr?.url ?? '') && /^[0-9a-f]{40}$/.test(input.reviewBase ?? '');
  if (prReview && input.prChecks !== undefined && (typeof input.prChecks !== 'string' || input.prChecks.length > 4000)) throw Error('PR checks are a short text');
  if (prReview && input.checksFrom !== undefined && !doc.tasks.some((t) => t.id === input.checksFrom && t.goalId === input.goalId && t.pr?.url === input.pr.url)) throw Error('Tests can come only from another review of this pull request');
  if (prReview && (!Number.isInteger(input.pr.number) || !BASE_BRANCH.test(input.pr.headRef ?? '') || input.pr.headRef.includes('..') || !path.isAbsolute(input.pr.clone ?? ''))) throw Error('Choose the pull request to review');
  // A reviewer opened later, when the writing is done: the task names its account until then.
  const later = !input.reviewer && !prReview && input.reviewLater && text(input.reviewLater.account, 100) ? { account: input.reviewLater.account, label: String(input.reviewLater.label ?? input.reviewLater.account).slice(0, 100) } : null;
  if ((!later && !recipient(input.reviewer)) || (!prReview && (!recipient(input.executor) || input.executor.address === input.reviewer?.address))) throw Error('Select different executor and reviewer agents');
  if ([prReview ? null : input.executor, input.reviewer].filter(Boolean).some((actor) => actor.address.includes('/'))) throw Error('This workflow requires local agents in the selected checkout');
  if (!Array.isArray(input.checks ?? []) || (input.checks?.length ?? 0) > 10 || (input.checks ?? []).some((args) => !Array.isArray(args) || !args.length || args.length > 30 || args.some((a) => typeof a !== 'string' || a.length > 2000 || a.includes('\0')))) throw Error('Checks must be JSON arrays of command arguments');
  const dependencies = input.dependsOn ?? [];
  if (!Array.isArray(dependencies) || new Set(dependencies).size !== dependencies.length || dependencies.some((id) =>
    !doc.tasks.some((t) => t.id === id && t.goalId === input.goalId) && !allowedNewDependencies.includes(id))) throw Error('Dependencies must be existing tasks in this goal');
  const maxRounds = input.maxRounds ?? 2, maxMinutes = input.maxMinutes ?? DEFAULT_MAX_MINUTES;
  if (input.worktree && (!RUN_BRANCH.test(input.worktree.branch ?? '') || !path.isAbsolute(input.worktree.base ?? ''))) throw Error('A worktree run needs its run/ branch and repository');
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5 || !Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 120) throw Error('Use 1–5 attempts and a 1–120 minute limit');
  return { id: uid(), goalId: input.goalId, title: input.title.trim(), criteria: input.criteria.trim(), root: fs.realpathSync(input.root),
    executor: prReview ? null : { address: input.executor.address, label: input.executor.label || input.executor.address },
    reviewer: later ? null : { address: input.reviewer.address, label: input.reviewer.label || input.reviewer.address }, ...(later ? { reviewLater: later } : {}),
    checks: input.checks ?? [], dependsOn: dependencies, maxRounds, maxMinutes, round: 0, state: 'planned', paused: false,
    ...(input.reviewOnly === true && !input.worktree ? { reviewOnly: true } : {}),
    ...(prReview ? { reviewBase: input.reviewBase, pr: { url: input.pr.url, number: input.pr.number, headRef: input.pr.headRef, clone: input.pr.clone, ...(/^[0-9a-f]{40}$/.test(input.pr.head ?? '') ? { head: input.pr.head } : {}) },
      ...(input.prChecks ? { prChecks: input.prChecks } : {}), ...(input.checksFrom ? { checksFrom: input.checksFrom } : {}) } : {}),
    ...(input.worktree ? { worktree: { path: fs.realpathSync(input.root), branch: String(input.worktree.branch ?? ''), base: fs.realpathSync(input.worktree.base),
      ...(/^[0-9a-f]{40}$/.test(input.worktree.baseCommit ?? '') ? { baseCommit: input.worktree.baseCommit } : {}),
      ...(BASE_BRANCH.test(input.worktree.baseBranch ?? '') ? { baseBranch: input.worktree.baseBranch } : {}),
      ...(BASE_BRANCH.test(input.worktree.prHead ?? '') && !input.worktree.prHead.includes('..') ? { prHead: input.worktree.prHead } : {}),
      ...(/^https:\/\/github\.com\/[^\s]+\/pull\/\d+$/.test(input.worktree.prUrl ?? '') ? { prUrl: input.worktree.prUrl } : {}) } } : {}),
    attempts: [], messages: [], evidence: [], decisions: [], checksResult: [], revision: '', createdAt: new Date(clock()).toISOString(), error: null };
}

export function planScopeIssue(task, doc, home) {
  if (!task.planId) return null;
  const plan = (doc.plans ?? []).find((item) => item.id === task.planId);
  if (!plan || plan.state !== 'started') return 'The linked goal plan is no longer active; inspect it before continuing.';
  const goal = JSON.parse(fs.readFileSync(path.join(home, 'relevo-goals.json'), 'utf8')).goals?.find((item) => item.id === task.goalId);
  if (!goal) return 'The linked goal was removed; inspect this task before continuing.';
  if ((goal.state ?? 'active') !== 'active') return 'The linked goal is not active; reopen it before continuing this task.';
  const step = (goal.steps ?? []).find((item) => item.id === task.goalStep?.id);
  if (!step || step.title !== task.goalStep?.title || step.state === 'done' || goal.criteria !== task.goalStep?.criteria) {
    return 'The linked goal step or acceptance criteria changed after this plan started; review the plan before continuing.';
  }
  return null;
}

export function dependencyWaitReason(task, doc) {
  const pending = task.dependsOn.map((id) => taskById(doc, id)).filter((dependency) => dependency.state !== 'accepted');
  if (!pending.length) return null;
  const attention = pending.filter((dependency) => ['cancelled', 'blocked', 'failed'].includes(dependency.state));
  if (attention.length) {
    const summaries = attention.slice(0, 3).map((dependency) => `“${dependency.title}” (${dependency.state})`);
    const more = attention.length > 3 ? ` and ${attention.length - 3} more` : '';
    return `Waiting on prerequisite ${summaries.join(', ')}${more}. Resolve or replace the prerequisite to continue.`.slice(0, 1000);
  }
  const titles = pending.slice(0, 3).map((dependency) => `“${dependency.title}”`);
  const more = pending.length > 3 ? ` and ${pending.length - 3} more` : '';
  return `Waiting for human acceptance of ${titles.join(', ')}${more}.`.slice(0, 1000);
}
