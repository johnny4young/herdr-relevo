import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, flush, find, click, text } from './fake/ui.mjs';
import { newGoal, saveGoal, emptyGoals } from '../lib/goals.js';
const { Workflow } = await import('../workflow.js');
const goalFile = '/home/test/.config/herdr-app/relevo-goals.json';
const stateFile = '/home/test/.config/herdr-app/relevo-workflow/state.json';
beforeEach(resetFake);
const goal = () => ({ ...newGoal('g', 'Ship an accessible queue'), criteria: 'Keyboard and pointer operations preserve decisions', steps: [
  { id: 'a', title: 'Implement queue navigation', state: 'working' },
  { id: 'b', title: 'Verify empty states', state: 'todo' },
  { id: 'c', title: 'Review completed shortcuts', state: 'review' },
  { id: 'd', title: 'Preserve saved decisions', state: 'done' },
] });
async function setup() {
  fake.props = { goalId: 'g', overlay: 'o' };
  fake.files[goalFile] = JSON.stringify(saveGoal(emptyGoals(), goal(), 0));
  const v = new Workflow(), cx = fakeCx(); v.init({}, cx); await flush(); return { v, cx };
}
function configure(v) {
  fake.agents = [{ address: 'a', title: 'Build' }, { address: 'b', title: 'Review' }];
  v.form.root.set_value('/work/app'); v.executor = 'a'; v.reviewer = 'b';
}

test('goal entry offers an ordered plan without redoing review or validated outcomes', async () => {
  const { v, cx } = await setup(); assert.equal(v.tab, 'Plan');
  assert.deepEqual(v.planStepIds, ['a', 'b']);
  const tree = v.render(); assert.ok(find(tree, 'workflow-create-plan'));
  assert.equal(find(tree, 'workflow-plan-select-d'), null);
  assert.equal(find(tree, 'workflow-title'), null);
  assert.match(text(tree), /Your acceptance unlocks the next task automatically/);
  click(find(tree, 'workflow-plan-select-c'), cx); assert.deepEqual(v.planStepIds, ['a', 'b', 'c']);
  assert.equal(fake.execs.length, 0); v.close();
});

test('plan creation sends one ordered snapshot and stable retries without launching agents', async () => {
  const { v, cx } = await setup(); configure(v); v.planStepIds = ['b', 'a'];
  const payloads = [];
  fake.exec = async (_cmd, args) => { payloads.push(JSON.parse(args.at(-1))); return { code: 1, stdout: '{"error":"transport interrupted"}' }; };
  v.createPlan(cx); await flush(); v.createPlan(cx); await flush();
  assert.equal(payloads.length, 2); assert.deepEqual(payloads[0].stepIds, ['a', 'b']);
  assert.equal(payloads[0].action, 'create-plan'); assert.equal(payloads[0].goalVersion, 1);
  assert.equal(payloads[0].planId, payloads[1].planId); assert.equal(payloads[0].maxRounds, 2);
  v.form.maxRounds.set_value('1'); v.createPlan(cx); await flush();
  assert.notEqual(payloads[0].planId, payloads[2].planId);
  v.close();
});

test('polling retains a plan draft and rejects a changed goal until explicit refresh', async () => {
  const { v, cx } = await setup(); configure(v); v.planStepIds = ['b'];
  const doc = JSON.parse(fake.files[goalFile]); doc.goals[0].version++; doc.goals[0].steps[1].title = 'Verify recovery states';
  fake.files[goalFile] = JSON.stringify(doc); v.load(cx); await flush();
  assert.deepEqual(v.planStepIds, ['b']); assert.equal(v.planDraftGoal.version, 1);
  v.createPlan(cx); assert.match(v.error, /goal changed/); assert.equal(fake.execs.length, 0);
  click(find(v.render(), 'workflow-plan-refresh'), cx); assert.equal(v.planDraftGoal.version, 2);
  assert.equal(v.form.root.value(), '/work/app'); v.close();
});

test('linked outcomes cannot be scheduled twice and accepted results have clear provenance', async () => {
  const { v, cx } = await setup();
  const task = { id: 't', goalId: 'g', title: 'First outcome', state: 'accepted', goalStep: { id: 'a', title: v.goal.steps[0].title, criteria: v.goal.criteria } };
  v.applyState({ tasks: [task], plans: [], events: [] }); v.openPlan(cx, true);
  assert.deepEqual(v.planStepIds, ['b']);
  const tree = v.render(); assert.match(text(tree), /accepted in Workflow/);
  assert.equal(find(tree, 'workflow-plan-select-a'), null);
  click(find(tree, 'workflow-plan-task-a'), cx); assert.equal(v.selected, 't'); assert.equal(v.filter, 'Completed');
  v.close();
});

test('a saved plan starts once and paused drafts require explicit resume', async () => {
  const { v, cx } = await setup();
  const tasks = ['a', 'b'].map((id, index) => ({ id, planId: 'p', goalId: 'g', title: `Outcome ${id}`, state: 'planned', dependsOn: index ? ['a'] : [], paused: false }));
  const plan = { id: 'p', goalId: 'g', goalVersion: 1, taskIds: ['a', 'b'], state: 'planned' };
  const doc = { tasks, plans: [plan], events: [], engine: { enabled: false } };
  fake.files[stateFile] = JSON.stringify(doc); v.applyState(doc); v.openPlan(cx);
  assert.ok(find(v.render(), 'workflow-start-plan-p'));
  v.selected = 'a'; v.tab = 'Overview'; assert.equal(find(v.render(), 'workflow-action-start'), null);
  click(find(v.render(), 'workflow-action-plan'), cx);
  fake.exec = async (_cmd, args) => {
    assert.deepEqual(JSON.parse(args.at(-1)), { action: 'start-plan', planId: 'p' });
    const next = { ...doc, tasks: tasks.map((task) => ({ ...task, state: 'ready' })), plans: [{ ...plan, state: 'started' }], engine: { enabled: true } };
    fake.files[stateFile] = JSON.stringify(next); return { stdout: JSON.stringify({ doc: next }) };
  };
  click(find(v.render(), 'workflow-start-plan-p'), cx); await flush();
  assert.equal(fake.execs.length, 1); assert.equal(v.filter, 'In progress'); assert.equal(v.selected, 'a');
  v.applyState({ ...doc, tasks: tasks.map((task) => ({ ...task, paused: true })) }); v.openPlan(cx);
  assert.equal(find(v.render(), 'workflow-start-plan-p').isDisabled, false);
  assert.match(text(find(v.render(), 'workflow-start-plan-p')), /Resume & start plan/);
  fake.exec = async (_cmd, args) => { assert.deepEqual(JSON.parse(args.at(-1)), { action: 'start-plan', planId: 'p', resumePaused: true }); return { stdout: '{}' }; };
  click(find(v.render(), 'workflow-start-plan-p'), cx); await flush(); v.openPlan(cx);
  assert.ok(find(v.render(), 'workflow-cancel-plan-p'));
  const check = (node) => { assert.notEqual(node, null); assert.notEqual(node, undefined); for (const child of node?.items ?? []) check(child); }; check(v.render());
  v.close();
});

test('started plan tasks never ask for another Start and explain acceptance dependencies', async () => {
  const { v } = await setup();
  v.engine = { enabled: true };
  v.tasks = [{ id: 'first', goalId: 'g', state: 'needs_you', title: 'First result' },
    { id: 'next', goalId: 'g', state: 'ready', title: 'Next result', planId: 'p', dependsOn: ['first'] }];
  v.selected = 'next'; v.tab = 'Overview';
  assert.match(text(v.render()), /Waiting for your acceptance of First result/);
  assert.equal(find(v.render(), 'workflow-action-start'), null);
  v.tasks[0].state = 'accepted';
  assert.match(text(v.render()), /already started; no further action is needed/);
  v.tasks[0].state = 'blocked'; assert.match(text(v.render()), /to be resolved and accepted/);
  v.tasks[0].state = 'cancelled'; assert.match(text(v.render()), /cannot start automatically/);
  v.engine.enabled = false; assert.match(text(v.render()), /cannot start automatically/);
  assert.equal(find(v.render(), 'workflow-action-start'), null);
  v.tasks[0].state = 'blocked'; assert.match(text(v.render()), /to be resolved and accepted/);
  v.tasks[0].state = 'accepted'; assert.ok(find(v.render(), 'workflow-action-start'));
  v.close();
});
