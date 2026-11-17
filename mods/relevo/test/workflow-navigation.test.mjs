import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceEffect, queueSummary, resultMeta, workflowCheckSummary, testCount, workflowItems } from '../lib/workflow-navigation.js';
import { runRow, runBucket } from '../lib/run-panel.js';
import { count, reportState } from '../lib/run-words.js';

test('ready decisions appear before historical blockers without hiding or mutating either', () => {
  const tasks = [
    { id: 'blocked', goalId: 'g', state: 'blocked', title: 'Earlier blocked attempt' },
    { id: 'review', goalId: 'g', state: 'needs_you', title: 'Current result' },
    { id: 'failed', goalId: 'g', state: 'failed', title: 'Another blocker' },
    { id: 'review2', goalId: 'g', state: 'needs_you', title: 'Second result' },
  ];
  assert.deepEqual(workflowItems(tasks, 'Needs me').map(task => task.id), ['review', 'review2', 'blocked', 'failed']);
  const row = runRow({ id: 'g' }, runBucket(tasks, 'g'), { engine: { enabled: true } });
  assert.deepEqual([row.turn, row.now, row.action.label], ['me', '2 results wait for your review', 'Review 2'], 'results that wait come before blockers');
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
  assert.deepEqual(workflowCheckSummary({ checks: [['npm', 'test'], ['npm', 'lint']], checksResult: [{ code: 0 }, { code: 0 }] }), { label: '2 checks passed', tone: 'normal' });
  assert.deepEqual(workflowCheckSummary({ checks: [['npm', 'test'], ['npm', 'lint']], checksResult: [{ code: 0 }] }), { label: '1 of 2 checks passed · incomplete', tone: 'muted' });
  assert.deepEqual(workflowCheckSummary({ checks: [['npm', 'test']], checksResult: [{ code: 0 }, { code: 0 }] }), { label: '2 checks passed', tone: 'normal' });
});

test('workflow check failures take priority and unknown exit codes stay incomplete', () => {
  assert.deepEqual(workflowCheckSummary({ checks: [['a'], ['b'], ['c']], checksResult: [{ code: 1 }, { code: 0 }] }), { label: '1 of 3 checks failed: a', tone: 'failure' });
  assert.deepEqual(workflowCheckSummary({ checks: [['a']], checksResult: [{ code: 0 }, { code: '0' }] }), { label: '1 of 2 checks passed · incomplete', tone: 'muted' });
});

test('a running executor hides stale check results until the current checks arrive', () => {
  assert.deepEqual(workflowCheckSummary({ checks: [['npm', 'test']], checksResult: [{ code: 1 }], attempts: [{ role: 'executor', state: 'running' }] }), { label: 'Awaiting tests', tone: 'muted' });
  assert.deepEqual(workflowCheckSummary({ checks: [['npm', 'test']], checksResult: [{ code: 1 }], attempts: [{ role: 'reviewer', state: 'running' }] }), { label: 'npm test failed', tone: 'failure' });
});

test('a blocked implementation does not revive prior-round checks and cancellation is not failure', () => {
  const checks = [['node', '--test']];
  assert.deepEqual(workflowCheckSummary({ checks, checksResult: [{ code: 0 }], attempts: [{ role: 'executor', state: 'reported', report: { status: 'blocked' } }] }), { label: 'Not run', tone: 'muted' });
  assert.deepEqual(workflowCheckSummary({ checks, checksResult: [{ code: 'timeout' }] }), { label: 'node --test failed', tone: 'failure' });
  assert.deepEqual(workflowCheckSummary({ checks, checksResult: [{ code: 'ENOENT' }] }), { label: 'node --test failed', tone: 'failure' });
  assert.deepEqual(workflowCheckSummary({ checks, checksResult: [{ code: 'cancelled' }] }), { label: '0 of 1 check passed · incomplete', tone: 'muted' });
  assert.deepEqual(workflowCheckSummary({ checks: [], attempts: [{ role: 'executor', state: 'running' }] }), { label: 'Not configured', tone: 'muted' });
});

test('result meta names the agents, round, checks, verdict and age', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const task = { executor: { label: 'Codex' }, reviewer: { label: 'Claude' }, round: 1, maxRounds: 2, checks: [['npm', 'test']],
    checksResult: [{ argv: ['npm', 'test'], code: 0 }],
    attempts: [{ role: 'executor', state: 'reported', report: { status: 'completed' }, at: '2026-01-01T09:00:00Z' },
      { role: 'reviewer', state: 'reported', report: { status: 'completed' }, at: '2026-01-01T10:00:00Z' }] };
  assert.equal(resultMeta(task, now), 'Codex → Claude · 1st try of 2 · npm test passed · reviewer approved · 2h ago');
  assert.equal(resultMeta({ attempts: [] }, now), 'tests not configured');
});

test('a stuck run is flagged for the blocked colour whatever its words say', () => {
  const row = (tasks, error = null) => runRow({ id: 'g' }, runBucket(tasks, 'g'), { engine: { enabled: true }, error });
  for (const state of ['blocked', 'failed']) assert.deepEqual([row([{ id: 'a', goalId: 'g', state, title: 'A' }]).turn, row([{ id: 'a', goalId: 'g', state, title: 'A' }]).hot], ['stuck', true]);
  assert.deepEqual([row([], 'unreadable').turn, row([], 'unreadable').hot], ['stuck', true]);
  assert.equal(row([{ id: 'a', goalId: 'g', state: 'needs_you', title: 'A' }]).turn, 'me');
});

test('report words and counts never show a raw status or NaN', () => {
  assert.equal(reportState('changes_requested', 'executor'), 'Asked for changes');
  assert.equal(reportState('completed', 'executor'), 'Completed');
  assert.equal(reportState('completed', 'reviewer'), 'Approved');
  assert.deepEqual([count(1, 'attempt'), count('3', 'attempt'), count('', 'attempt'), count('abc', 'attempt'), count(undefined, 'attempt')],
    ['1 attempt', '3 attempts', '? attempts', '? attempts', '? attempts']);
});

test('a check says what ran and, when its runner prints it, how many tests', () => {
  const node = '✔ one\nℹ tests 3\nℹ pass 3\n', jest = 'Tests:       12 passed, 12 total', vitest = ' Tests  5 passed (5)', mocha = '  7 passing (20ms)', pytest = '===== 4 passed in 0.12s =====';
  assert.deepEqual([node, jest, vitest, mocha, pytest, 'ok  example.com/pkg 0.2s', ''].map(testCount), [3, 12, 5, 7, 4, null, null]);
  const ran = (argv, code, stdout) => ({ argv, code, stdout });
  assert.equal(workflowCheckSummary({ checks: [['npm', 'test']], checksResult: [ran(['npm', 'test'], 0, node)] }).label, 'npm test passed · 3 tests');
  assert.equal(workflowCheckSummary({ checks: [['npm', 'test']], checksResult: [ran(['npm', 'test'], 0, 'done')] }).label, 'npm test passed');
  assert.equal(workflowCheckSummary({ checks: [['npm', 'test'], ['npm', 'run', 'e2e']], checksResult: [ran(['npm', 'test'], 0, node), ran(['npm', 'run', 'e2e'], 0, mocha)] }).label, '2 checks passed · 10 tests');
  assert.equal(workflowCheckSummary({ checks: [['npm', 'test'], ['npm', 'run', 'lint']], checksResult: [ran(['npm', 'test'], 0, node), ran(['npm', 'run', 'lint'], 0, '')] }).label, '2 checks passed');
  assert.equal(workflowCheckSummary({ checks: [['npm', 'test'], ['npm', 'run', 'lint']], checksResult: [ran(['npm', 'test'], 0, node), ran(['npm', 'run', 'lint'], 1, '')] }).label, '1 of 2 checks failed: npm run lint');
});
