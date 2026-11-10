import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkedDecision, runProgress } from '../lib/goal-workflow.js';
const goal = { id: 'g', decision: 'Accept search?', decisionLink: { taskId: 't', question: 'Accept search?' } };
const task = { id: 't', goalId: 'g', state: 'needs_you', revision: 'r1', decisions: [] };

test('explicitly linked questions follow their result, while unrelated and edited questions stay separate', () => {
  assert.equal(linkedDecision(goal, [task]).state, 'linked');
  assert.equal(linkedDecision({ ...goal, decision: 'Ship publicly?' }, [task]).state, 'separate');
  assert.equal(linkedDecision(goal, [{ ...task, goalId: 'other' }]).state, 'separate');
  assert.equal(linkedDecision(goal, [task], 'unreadable').state, 'separate');
});

test('only explicit acceptance of the current revision resolves a linked question', () => {
  const accepted = { ...task, state: 'accepted', decisions: [{ outcome: 'accept', revision: 'r1' }] };
  assert.equal(linkedDecision(goal, [accepted]).state, 'resolved');
  assert.equal(linkedDecision(goal, [{ ...accepted, revision: 'r2' }]).state, 'separate');
  assert.equal(linkedDecision(goal, [{ ...accepted, decisions: [] }]).state, 'separate');
  assert.equal(linkedDecision(goal, [{ ...accepted, state: 'cancelled' }]).state, 'separate');
  assert.equal(linkedDecision(goal, [{ ...accepted, state: 'needs_you' }]).state, 'linked');
});

test('run progress distinguishes active reviewer, paused scheduling and blocked prerequisites', () => {
  const reviewing = { ...task, state: 'needs_review', reviewer: { label: 'Reviewer' }, attempts: [{ role: 'reviewer', state: 'running' }] };
  assert.match(runProgress('g', [reviewing], { enabled: false }), /Awaiting review report from Reviewer/);
  assert.match(runProgress('g', [reviewing], { enabled: false }), /Next: your review/);
  assert.match(runProgress('g', [{ ...task, state: 'ready', dependsOn: ['parent'] }], { enabled: true }), /Waiting for.*prerequisite/);
  assert.match(runProgress('g', [{ ...task, state: 'running', paused: true, attempts: [] }], { enabled: false }), /Paused/);
});

test('sending and uncertain transport never claim that an agent is already working', () => {
  const sending = { ...task, state: 'running', executor: { label: 'Builder' }, attempts: [{ role: 'executor', state: 'running', delivery: 'sending' }] };
  assert.equal(runProgress('g', [sending], { enabled: true }), 'Sending implementation assignment to Builder.');
  const uncertain = { ...sending, attempts: [{ role: 'executor', state: 'running', delivery: 'uncertain' }] };
  assert.match(runProgress('g', [uncertain], { enabled: true }), /unconfirmed/);
});

test('ready and historical tasks do not add redundant progress text', () => {
  assert.equal(runProgress('g', [task], { enabled: true }), '');
  assert.equal(runProgress('g', [], { enabled: false }), '');
  assert.equal(runProgress('g', [{ ...task, state: 'accepted' }], { enabled: false }), '');
  assert.match(runProgress('g', [task, { ...task, id: 'blocked', state: 'blocked' }], { enabled: true }), /1 other task is blocked/);
});
