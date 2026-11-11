import './fake/register.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
const { createWorkflowDrafts, restoreWorkflowDraftAgents, workflowDraftKey } = await import('../workflow-drafts.js');

const draft = (overrides = {}) => ({
  title: 'Implement search', root: '/work/app', criteria: 'Search works', checks: '[["npm","test"]]',
  maxRounds: '2', maxMinutes: '20', checkPreset: 'custom', executor: 'agent:builder', reviewer: 'agent:reviewer', dependsOn: ['task-a'],
  ...overrides,
});

test('draft survives close and reopen as a per-goal local record', () => {
  resetFake();
  const first = createWorkflowDrafts();
  assert.deepEqual(first.save('goal-a', draft()), { ok: true, draft: draft() });
  const reopened = createWorkflowDrafts();
  assert.deepEqual(reopened.load('goal-a'), draft());
  assert.match(fake.stored[workflowDraftKey('goal-a')], /"version":1/);
});

test('each run has an isolated draft key', () => {
  resetFake();
  const drafts = createWorkflowDrafts();
  drafts.save('goal/a', draft({ title: 'First run' }));
  drafts.save('goal-b', draft({ title: 'Second run' }));
  assert.notEqual(workflowDraftKey('goal/a'), workflowDraftKey('goal-b'));
  assert.equal(drafts.load('goal/a').title, 'First run');
  assert.equal(drafts.load('goal-b').title, 'Second run');
});

test('loading an empty editor does not overwrite an existing candidate', () => {
  resetFake();
  let writes = 0;
  const drafts = createWorkflowDrafts({ read: (key) => fake.stored[key], write: (key, value) => { writes++; fake.stored[key] = value; } });
  drafts.save('goal-a', draft());
  const before = fake.stored[workflowDraftKey('goal-a')];
  assert.equal(drafts.load('goal-a').title, draft().title);
  assert.equal(writes, 1);
  assert.equal(fake.stored[workflowDraftKey('goal-a')], before);
});

test('explicit discard and successful-create cleanup clear only the selected run draft', () => {
  resetFake();
  const drafts = createWorkflowDrafts();
  drafts.save('goal-a', draft()); drafts.save('goal-b', draft({ title: 'Other run' }));
  drafts.clear('goal-a');
  assert.equal(drafts.load('goal-a'), null);
  assert.equal(drafts.load('goal-b').title, 'Other run');
  drafts.clear('goal-b'); // Workflow calls this only after successful task creation.
  assert.equal(drafts.load('goal-b'), null);
});

test('agent addresses restore only for live sessions in the saved repository', () => {
  const agents = [{ address: 'agent:builder', pane: 'pane-a' }, { address: 'agent:reviewer', cwd: '/work/other' }];
  const panes = [{ pane: 'pane-a', cwd: '/work/app' }];
  assert.deepEqual(restoreWorkflowDraftAgents(draft(), { agents, panes }), { executor: 'agent:builder', reviewer: '', warnings: ['Reviewer agent:reviewer was not restored; choose a live session in the saved repository.'] });
  assert.deepEqual(restoreWorkflowDraftAgents(draft(), { agents: [], panes: [] }), {
    executor: '', reviewer: '', warnings: [
      'Implementer agent:builder was not restored; choose a live session in the saved repository.',
      'Reviewer agent:reviewer was not restored; choose a live session in the saved repository.',
    ],
  });
  assert.deepEqual(restoreWorkflowDraftAgents(draft({ reviewer: '' }), { agents: [{ address: 'agent:builder' }], panes: [] }), {
    executor: '', reviewer: '', warnings: ['Implementer agent:builder was not restored; choose a live session in the saved repository.'],
  });
});

test('malformed, unsupported or oversized records are rejected without clamping or overwriting', () => {
  resetFake();
  const drafts = createWorkflowDrafts();
  drafts.save('goal-a', draft());
  const key = workflowDraftKey('goal-a'), valid = fake.stored[key];
  fake.stored[key] = JSON.stringify({ ...JSON.parse(valid), version: 2 });
  assert.equal(drafts.load('goal-a'), null);
  fake.stored[key] = valid;
  assert.deepEqual(drafts.save('goal-a', draft({ maxRounds: '6' })), { ok: true, draft: draft({ maxRounds: '6' }) });
  assert.equal(drafts.load('goal-a').maxRounds, '6', 'restoring preserves the entered value instead of clamping the limit');
  const afterLimitEdit = fake.stored[key];
  assert.deepEqual(drafts.save('goal-a', { ...draft(), maxRounds: 6 }), { ok: false, reason: 'Draft fields are invalid or exceed their supported limits.' });
  assert.equal(fake.stored[key], afterLimitEdit);
  assert.deepEqual(drafts.save('goal-a', { ...draft(), evidence: ['do not persist'] }), { ok: false, reason: 'Draft fields are invalid or exceed their supported limits.' });
  assert.deepEqual(drafts.save('goal-a', draft({ checks: 'x'.repeat(64 * 1024) })), { ok: false, reason: 'Draft is too large to save.' });
  fake.stored[key] = JSON.stringify({ ...JSON.parse(valid), draft: { ...draft(), feedback: 'private' } });
  assert.equal(drafts.load('goal-a'), null);
});
