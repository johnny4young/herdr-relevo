import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceEffect, queueSummary, workflowItems } from '../lib/workflow-navigation.js';
import { missionNextAction } from '../lib/goal-workflow.js';

test('ready decisions appear before historical blockers without hiding or mutating either', () => {
  const tasks = [
    { id: 'blocked', goalId: 'g', state: 'blocked', title: 'Earlier blocked attempt' },
    { id: 'review', goalId: 'g', state: 'needs_you', title: 'Current result' },
    { id: 'failed', goalId: 'g', state: 'failed', title: 'Another blocker' },
    { id: 'review2', goalId: 'g', state: 'needs_you', title: 'Second result' },
  ];
  assert.deepEqual(workflowItems(tasks, 'Needs you').map(task => task.id), ['review', 'review2', 'blocked', 'failed']);
  assert.equal(missionNextAction({ id: 'g' }, tasks, { enabled: true }).detail, 'Current result');
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
