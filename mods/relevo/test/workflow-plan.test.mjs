import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRuntime } from '../runtime/coordinator.mjs';
import { main } from '../runtime/cli.mjs';
import { transaction } from '../runtime/store.mjs';

async function fixture({ failReviewer = false } = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'relevo-plan-'));
  const home = path.join(base, 'home'), root = path.join(base, 'repo');
  fs.mkdirSync(home); fs.mkdirSync(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), 'plan fixture\n');
  const writeGoal = (overrides = {}) => fs.writeFileSync(path.join(home, 'relevo-goals.json'), JSON.stringify({
    version: 1, revision: 1, goals: [{ id: 'g1', title: 'Goal', version: 3, state: 'active', criteria: 'Goal criteria',
      steps: [{ id: 's1', title: 'First outcome', state: 'todo' }, { id: 's2', title: 'Second outcome', state: 'working' }], ...overrides }], history: [],
  }));
  writeGoal();
  let reviewerCalls = 0;
  let onGet;
  const sends = [];
  const runCommand = async ([, ...args]) => {
    if (args[0] === 'get') {
      if (onGet) { const callback = onGet; onGet = null; callback(); }
      if (args[2] === 'review-agent') reviewerCalls++;
      if (failReviewer && args[2] === 'review-agent') return { code: 1, stdout: '', stderr: 'offline' };
      return { code: 0, stdout: JSON.stringify({ state: 'live', status: { state: 'idle' }, cwd: root, turn: 1 }) };
    }
    if (args[0] === 'send') { sends.push(args); return { code: 0, stdout: '' }; }
    throw Error(`unexpected hc ${args[0]}`);
  };
  const runtime = createRuntime({ home, runCommand, fingerprintImpl: async () => 'fingerprint' });
  const request = { action: 'create-plan', planId: 'stable-plan-1', goalId: 'g1', goalVersion: 3, stepIds: ['s1', 's2'],
    root, executor: { address: 'exec-agent', label: 'Executor' }, reviewer: { address: 'review-agent', label: 'Reviewer' },
    checks: [['npm', 'test']], maxRounds: 2, maxMinutes: 10 };
  return { base, home, root, runtime, request, writeGoal, sends, setOnGet(callback) { onGet = callback; }, get reviewerCalls() { return reviewerCalls; } };
}

test('create-plan creates an ordered dependency chain and start-plan enables it once', async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const created = await f.runtime.command(f.request);
  assert.equal(created.result.existing, false);
  const doc = f.runtime.read();
  assert.equal(doc.plans[0].state, 'planned');
  assert.deepEqual(doc.plans[0].stepIds, ['s1', 's2']);
  assert.equal(doc.tasks.length, 2);
  const [first, second] = doc.tasks;
  assert.deepEqual(first.dependsOn, []);
  assert.deepEqual(second.dependsOn, [first.id]);
  assert.equal(first.goalStep.id, 's1');
  assert.equal(first.goalStep.criteria, 'Goal criteria');
  assert.match(first.criteria, /Step expected outcome: First outcome/);
  assert.equal(second.planId, 'stable-plan-1');
  assert.equal(doc.engine.enabled, false);

  const started = await f.runtime.command({ action: 'start-plan', planId: 'stable-plan-1' });
  assert.equal(started.result.existing, false);
  assert.deepEqual(f.runtime.read().tasks.map((task) => task.state), ['ready', 'ready']);
  assert.equal(f.runtime.read().engine.enabled, true);
  assert.equal(f.runtime.read().plans[0].state, 'started');
  const again = await f.runtime.command({ action: 'start-plan', planId: 'stable-plan-1' });
  assert.equal(again.result.existing, true);
});

test('create-plan is idempotent by stable plan ID and rejects conflicting reuse', async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const first = await f.runtime.command(f.request);
  const repeat = await f.runtime.command(f.request);
  assert.equal(repeat.result.existing, true);
  assert.deepEqual(repeat.result.taskIds, first.result.taskIds);
  assert.equal(f.runtime.read().tasks.length, 2);
  await assert.rejects(f.runtime.command({ ...f.request, stepIds: ['s1'] }), /already in use/);
  assert.equal(f.runtime.read().tasks.length, 2);
});

test('create-plan retries remain idempotent when goal criteria contain boundary whitespace or the outcome delimiter', async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  f.writeGoal({ criteria: ' Goal criteria\n\nStep expected outcome: exact evidence ' });
  const created = await f.runtime.command(f.request);
  const repeat = await f.runtime.command(f.request);
  assert.equal(repeat.result.existing, true);
  assert.deepEqual(repeat.result.taskIds, created.result.taskIds);
});

test('idempotency normalizes step order and canonicalizes the repository path', async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const alias = path.join(f.base, 'repo-alias'); fs.symlinkSync(f.root, alias, 'dir');
  const reverse = { ...f.request, root: alias, stepIds: ['s2', 's1'] };
  const first = await f.runtime.command(reverse);
  const repeated = await f.runtime.command(reverse);
  assert.equal(repeated.result.existing, true);
  assert.deepEqual(f.runtime.read().plans[0].stepIds, ['s1', 's2']);
  assert.deepEqual(first.result.taskIds, repeated.result.taskIds);
});

test('goal version, step validity, duplicates and existing linked work reject without partial creation', async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const count = () => f.runtime.read().tasks.length;
  await assert.rejects(f.runtime.command({ ...f.request, goalVersion: 2 }), /goal changed/);
  await assert.rejects(f.runtime.command({ ...f.request, stepIds: ['s1', 'missing'] }), /existing goal steps/);
  await assert.rejects(f.runtime.command({ ...f.request, stepIds: ['s1', 's1'] }), /unique/);
  assert.equal(count(), 0);
  f.writeGoal({ steps: [{ id: 's1', title: 'First outcome', state: 'done' }, { id: 's2', title: 'Second outcome', state: 'todo' }] });
  await assert.rejects(f.runtime.command(f.request), /not already done/);
  assert.equal(count(), 0);
});

test('actor validation failure and existing linked work leave no partial plan', async (t) => {
  const f = await fixture({ failReviewer: true }); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await assert.rejects(f.runtime.command(f.request), /Agent review-agent is unavailable/);
  assert.equal(f.runtime.read().tasks.length, 0);
  assert.equal(f.runtime.read().plans, undefined);

  const linked = await fixture(); t.after(() => fs.rmSync(linked.base, { recursive: true, force: true }));
  const created = await linked.runtime.command(linked.request);
  transaction(linked.home, (doc) => { doc.tasks[0].state = 'accepted'; });
  await assert.rejects(linked.runtime.command({ ...linked.request, planId: 'another-plan', stepIds: ['s1'] }), /already has a noncancelled task/);
  assert.equal(linked.runtime.read().tasks.length, created.result.taskIds.length);
});

test('start-plan checks the saved step snapshot and respects individually paused planned work', async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command(f.request);
  f.writeGoal({ criteria: 'Edited without a version bump' });
  await assert.rejects(f.runtime.command({ action: 'start-plan', planId: 'stable-plan-1' }), /no longer matches/);
  f.writeGoal();
  await f.runtime.command({ action: 'pause', taskId: f.runtime.read().tasks[0].id });
  await assert.rejects(f.runtime.command({ action: 'start-plan', planId: 'stable-plan-1' }), /paused/);
  await assert.rejects(f.runtime.command({ action: 'start', taskId: f.runtime.read().tasks[1].id }), /Start this work through Start plan/);
  await assert.rejects(f.runtime.command({ action: 'resume', taskId: f.runtime.read().tasks[0].id }), /Start this work through Start plan/);
  assert.deepEqual(f.runtime.read().tasks.map((task) => task.state), ['planned', 'planned']);
});

test('starting an already-started plan after stop does not resume paused tasks or launch the CLI engine', async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command(f.request);
  await f.runtime.command({ action: 'start-plan', planId: 'stable-plan-1' });
  await f.runtime.command({ action: 'stop' });
  const paused = f.runtime.read().tasks.map((task) => ({ state: task.state, paused: task.paused }));
  const repeated = await f.runtime.command({ action: 'start-plan', planId: 'stable-plan-1', resumePaused: true });
  assert.equal(repeated.result.existing, true);
  assert.deepEqual(f.runtime.read().tasks.map((task) => ({ state: task.state, paused: task.paused })), paused);
  let launches = 0;
  const cliResult = await main(['--home', f.home, 'command', JSON.stringify({ action: 'start-plan', planId: 'stable-plan-1', resumePaused: true })], {
    runtimeFactory: () => f.runtime, ensureEngine: async () => { launches++; },
  });
  assert.equal(cliResult.code, 0);
  assert.equal(launches, 0);
  assert.deepEqual(f.runtime.read().tasks.map((task) => ({ state: task.state, paused: task.paused })), paused);
  assert.equal(f.runtime.read().engine.enabled, false);
});

test('a stopped planned draft resumes only when explicitly requested', async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const other = await f.runtime.command({ action: 'create', task: { goalId: 'g1', title: 'Unrelated task', criteria: 'Other outcome', root: f.root,
    executor: { address: 'exec-agent' }, reviewer: { address: 'review-agent' } } });
  await f.runtime.command(f.request);
  await f.runtime.command({ action: 'stop' });
  await assert.rejects(f.runtime.command({ action: 'start-plan', planId: 'stable-plan-1' }), /resumePaused to true/);
  assert.equal(f.runtime.read().engine.enabled, false);
  await f.runtime.command({ action: 'start-plan', planId: 'stable-plan-1', resumePaused: true });
  const doc = f.runtime.read();
  assert.equal(doc.engine.enabled, true);
  const planTasks = doc.tasks.filter((task) => task.planId === 'stable-plan-1');
  assert.deepEqual(planTasks.map((task) => ({ state: task.state, paused: task.paused })), [
    { state: 'ready', paused: false }, { state: 'ready', paused: false },
  ]);
  const unrelated = doc.tasks.find((task) => task.id === other.result.taskId);
  assert.equal(unrelated.state, 'planned');
  assert.equal(unrelated.paused, true);
});

test('CLI does not ensure the engine again for an already-started plan', async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command(f.request);
  await f.runtime.command({ action: 'start-plan', planId: 'stable-plan-1' });
  let launches = 0;
  const result = await main(['--home', f.home, 'command', JSON.stringify({ action: 'start-plan', planId: 'stable-plan-1' })], {
    runtimeFactory: () => f.runtime, ensureEngine: async () => { launches++; },
  });
  assert.equal(result.code, 0);
  assert.equal(launches, 0);
});

test('owner and display-title edits stay valid, while stale outcome scope blocks dispatch and acceptance', async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command(f.request);
  await f.runtime.command({ action: 'start-plan', planId: 'stable-plan-1' });
  f.writeGoal({ title: 'Renamed goal', owner: 'New owner', version: 4 });
  await f.runtime.tick();
  assert.equal(f.sends.length, 1, 'an owner-only edit does not stale the plan');

  const dependent = await fixture(); t.after(() => fs.rmSync(dependent.base, { recursive: true, force: true }));
  await dependent.runtime.command(dependent.request);
  await dependent.runtime.command({ action: 'start-plan', planId: 'stable-plan-1' });
  transaction(dependent.home, (doc) => { doc.tasks[0].state = 'accepted'; });
  dependent.writeGoal({ criteria: 'Updated acceptance criteria' });
  await dependent.runtime.tick();
  assert.equal(dependent.sends.length, 0, 'a dependent task is not sent under a renamed goal');
  assert.equal(dependent.runtime.read().tasks[1].state, 'blocked');
  assert.match(dependent.runtime.read().tasks[1].error, /acceptance criteria changed/);
  await transaction(dependent.home, (doc) => { doc.tasks[0].state = 'needs_you'; doc.tasks[0].revision = 'fingerprint'; });
  await assert.rejects(dependent.runtime.command({ action: 'decide', taskId: dependent.runtime.read().tasks[0].id,
    outcome: 'accept', revision: 'fingerprint' }), /acceptance criteria changed/);
});

test('dispatch rechecks plan scope after asynchronous agent lookup and does not send stale work', async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command(f.request);
  await f.runtime.command({ action: 'start-plan', planId: 'stable-plan-1' });
  f.setOnGet(() => f.writeGoal({ criteria: 'Changed during dispatch lookup' }));
  await f.runtime.tick();
  assert.equal(f.sends.length, 0);
  assert.equal(f.runtime.read().tasks[0].state, 'blocked');
  assert.match(f.runtime.read().tasks[0].error, /acceptance criteria changed/);
});

test('pending dependencies persist an actionable reason without polling writes', async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command(f.request);
  await f.runtime.command({ action: 'start-plan', planId: 'stable-plan-1' });
  const [prerequisite, dependent] = f.runtime.read().tasks;
  await f.runtime.command({ action: 'cancel', taskId: prerequisite.id });
  await f.runtime.dispatch(dependent.id);
  const firstWait = f.runtime.read(), waitingTask = firstWait.tasks.find((task) => task.id === dependent.id);
  assert.equal(waitingTask.state, 'ready');
  assert.match(waitingTask.waitingReason, /First outcome.*cancelled/);
  const revision = firstWait.revision, events = firstWait.events.length;
  await f.runtime.dispatch(dependent.id);
  const repeatedWait = f.runtime.read();
  assert.equal(repeatedWait.revision, revision);
  assert.equal(repeatedWait.events.length, events);
});

test('blocked dependency reason clears when acceptance unlocks dispatch', async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command(f.request);
  await f.runtime.command({ action: 'start-plan', planId: 'stable-plan-1' });
  const [prerequisite, dependent] = f.runtime.read().tasks;
  transaction(f.home, (doc) => { doc.tasks.find((task) => task.id === prerequisite.id).state = 'blocked'; });
  await f.runtime.dispatch(dependent.id);
  assert.match(f.runtime.read().tasks.find((task) => task.id === dependent.id).waitingReason, /First outcome.*blocked/);
  transaction(f.home, (doc) => { doc.tasks.find((task) => task.id === prerequisite.id).state = 'accepted'; });
  await f.runtime.dispatch(dependent.id);
  const current = f.runtime.read().tasks.find((task) => task.id === dependent.id);
  assert.equal(current.waitingReason, null);
  assert.equal(current.state, 'running');
  assert.equal(f.sends.length, 1);
});

test('acceptance clears the prerequisite reason even while another task holds the checkout', async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const other = await f.runtime.command({ action: 'create', task: { goalId: 'g1', title: 'Checkout holder', criteria: 'Other outcome', root: f.root,
    executor: { address: 'other-exec' }, reviewer: { address: 'other-review' } } });
  await f.runtime.command(f.request);
  await f.runtime.command({ action: 'start-plan', planId: 'stable-plan-1' });
  const [prerequisite, dependent] = f.runtime.read().tasks.filter((task) => task.planId === 'stable-plan-1');
  transaction(f.home, (doc) => { doc.tasks.find((task) => task.id === prerequisite.id).state = 'blocked'; });
  await f.runtime.dispatch(dependent.id);
  assert.match(f.runtime.read().tasks.find((task) => task.id === dependent.id).waitingReason, /blocked/);
  transaction(f.home, (doc) => {
    doc.tasks.find((task) => task.id === prerequisite.id).state = 'accepted';
    doc.tasks.find((task) => task.id === other.result.taskId).state = 'running';
  });
  await f.runtime.dispatch(dependent.id);
  const current = f.runtime.read().tasks.find((task) => task.id === dependent.id);
  assert.equal(current.state, 'ready');
  assert.equal(current.waitingReason, null);
  assert.equal(f.sends.length, 0);
});

test('cancel-plan removes every task from an unstarted draft and does not cancel a started plan', async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command(f.request);
  await f.runtime.command({ action: 'cancel', taskId: f.runtime.read().tasks[0].id });
  await f.runtime.command({ action: 'cancel-plan', planId: 'stable-plan-1' });
  assert.deepEqual(f.runtime.read().tasks.map((task) => task.state), ['cancelled', 'cancelled']);
  assert.equal(f.runtime.read().plans[0].state, 'cancelled');
  assert.equal((await f.runtime.command({ action: 'cancel-plan', planId: 'stable-plan-1' })).result.existing, true);
  await f.runtime.command({ ...f.request, planId: 'started-plan' });
  await f.runtime.command({ action: 'start-plan', planId: 'started-plan' });
  await assert.rejects(f.runtime.command({ action: 'cancel-plan', planId: 'started-plan' }), /active plan/);
});
