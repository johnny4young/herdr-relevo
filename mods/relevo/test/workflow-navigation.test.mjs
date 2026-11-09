import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceEffect, queueSummary } from '../lib/workflow-navigation.js';

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
