import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceEffect, queueSummary, resultMeta, workflowCheckSummary, workflowItems } from '../lib/workflow-navigation.js';
import { runNextAction } from '../lib/goal-workflow.js';

test('ready decisions appear before historical blockers without hiding or mutating either', () => {
  const tasks = [
    { id: 'blocked', goalId: 'g', state: 'blocked', title: 'Earlier blocked attempt' },
    { id: 'review', goalId: 'g', state: 'needs_you', title: 'Current result' },
    { id: 'failed', goalId: 'g', state: 'failed', title: 'Another blocker' },
    { id: 'review2', goalId: 'g', state: 'needs_you', title: 'Second result' },
  ];
  assert.deepEqual(workflowItems(tasks, 'Needs you').map(task => task.id), ['review', 'review2', 'blocked', 'failed']);
  assert.equal(runNextAction({ id: 'g' }, tasks, { enabled: true }).detail, 'Current result');
  assert.deepEqual(tasks.map(task => task.id), ['blocked', 'review', 'failed', 'review2']);
});

test('acceptance previews real continuation and never promises to resume paused or unstarted work', () => {
  const parent = { id: 'p', state: 'needs_you' }, next = { id: 'n', state: 'ready', dependsOn: ['p'], paused: false };
  assert.match(acceptanceEffect(parent, [parent], { enabled: true }), /No follow-up/);
  assert.match(acceptanceEffect(parent, [parent, next], { enabled: true }), /continue automatically/);
  assert.match(acceptanceEffect(parent, [parent, next], { enabled: false }), /does not resume/);
  assert.match(acceptanceEffect(parent, [parent, { ...next, state: 'planned' }], { enabled: true }), /not been started/);
  assert.match(acceptanceEffect(parent, [parent, { ...next, dependsOn: ['p', 'other'] }], { enabled: true }), /remaining dependencies/);
});

test('empty decision queues distinguish completion from ongoing, planned and stopped work', () => {
  assert.match(queueSummary([{ state: 'accepted' }], {}).detail, /No further work/);
  assert.match(queueSummary([{ state: 'planned' }], { enabled: true }).detail, /not started/);
  assert.match(queueSummary([{ state: 'ready' }], { enabled: false }).detail, /paused/);
  assert.equal(queueSummary([{ state: 'running' }], { enabled: true }).title, 'Work continues');
});

test('workflow check summary distinguishes unconfigured, unrun, complete and incomplete checks', () => {
  assert.deepEqual(workflowCheckSummary({ checks: [], checksResult: [] }), { label: 'Not configured', tone: 'muted' });
  assert.deepEqual(workflowCheckSummary({ checks: [['npm', 'test']], checksResult: [] }), { label: 'Not run', tone: 'muted' });
  assert.deepEqual(workflowCheckSummary({ checks: [['npm', 'test'], ['npm', 'lint']], checksResult: [{ code: 0 }, { code: 0 }] }), { label: '2/2 passed', tone: 'normal' });
  assert.deepEqual(workflowCheckSummary({ checks: [['npm', 'test'], ['npm', 'lint']], checksResult: [{ code: 0 }] }), { label: '1/2 passed · incomplete', tone: 'muted' });
  assert.deepEqual(workflowCheckSummary({ checks: [['npm', 'test']], checksResult: [{ code: 0 }, { code: 0 }] }), { label: '2/2 passed', tone: 'normal' });
});

test('workflow check failures take priority and unknown exit codes stay incomplete', () => {
  assert.deepEqual(workflowCheckSummary({ checks: [['a'], ['b'], ['c']], checksResult: [{ code: 1 }, { code: 0 }] }), { label: '1 failed · 1/3 passed', tone: 'failure' });
  assert.deepEqual(workflowCheckSummary({ checks: [['a']], checksResult: [{ code: 0 }, { code: '0' }] }), { label: '1/2 passed · incomplete', tone: 'muted' });
});

test('a running executor hides stale check results until the current checks arrive', () => {
  assert.deepEqual(workflowCheckSummary({ checks: [['npm', 'test']], checksResult: [{ code: 1 }], attempts: [{ role: 'executor', state: 'running' }] }), { label: 'Awaiting checks', tone: 'muted' });
  assert.deepEqual(workflowCheckSummary({ checks: [['npm', 'test']], checksResult: [{ code: 1 }], attempts: [{ role: 'reviewer', state: 'running' }] }), { label: '1 failed · 0/1 passed', tone: 'failure' });
});

test('a blocked implementation does not revive prior-round checks and cancellation is not failure', () => {
  const checks = [['node', '--test']];
  assert.deepEqual(workflowCheckSummary({ checks, checksResult: [{ code: 0 }], attempts: [{ role: 'executor', state: 'reported', report: { status: 'blocked' } }] }), { label: 'Not run', tone: 'muted' });
  assert.deepEqual(workflowCheckSummary({ checks, checksResult: [{ code: 'timeout' }] }), { label: '1 failed · 0/1 passed', tone: 'failure' });
  assert.deepEqual(workflowCheckSummary({ checks, checksResult: [{ code: 'ENOENT' }] }), { label: '1 failed · 0/1 passed', tone: 'failure' });
  assert.deepEqual(workflowCheckSummary({ checks, checksResult: [{ code: 'cancelled' }] }), { label: '0/1 passed · incomplete', tone: 'muted' });
  assert.deepEqual(workflowCheckSummary({ checks: [], attempts: [{ role: 'executor', state: 'running' }] }), { label: 'Not configured', tone: 'muted' });
});

test('result meta names the agents, round, checks, verdict and age', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const task = { executor: { label: 'Codex' }, reviewer: { label: 'Claude' }, round: 1, maxRounds: 2, checks: [['npm', 'test']],
    checksResult: [{ argv: ['npm', 'test'], code: 0 }],
    attempts: [{ role: 'executor', state: 'reported', report: { status: 'completed' }, at: '2026-01-01T09:00:00Z' },
      { role: 'reviewer', state: 'reported', report: { status: 'completed' }, at: '2026-01-01T10:00:00Z' }] };
  assert.equal(resultMeta(task, now), 'Codex → Claude · round 1/2 · checks 1/1 passed · review approved · 2h ago');
  assert.equal(resultMeta({ attempts: [] }, now), 'checks not configured');
});
