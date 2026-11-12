import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, flush, find, click, text } from './fake/ui.mjs';
import { newGoal, saveGoal, emptyGoals } from '../lib/goals.js';
const { Workflow } = await import('../workflow.js');
const goalFile = '/home/test/.config/herdr-app/relevo-goals.json';
const stateFile = '/home/test/.config/herdr-app/relevo-workflow/state.json';
beforeEach(() => { resetFake(); fake.stored['relevo.runs.mode'] = 'sessions'; });
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
  assert.match(text(tree), /Choose outcomes/);
  assert.ok(find(tree, 'workflow-plan-config'));
  assert.equal(find(tree, 'workflow-root'), null);
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

test('plan checks use a simple preset and reveal JSON only for custom checks', async () => {
  const { v, cx } = await setup(); configure(v); v.planConfigOpen = true;
  v.planStepIds = ['a'];
  v.checkPreset = "custom"; v.form.checks.set_value('[["git","status"]]');
  let tree = v.render();
  assert.ok(find(tree, 'workflow-plan-check-none'));
  assert.ok(find(tree, 'workflow-plan-check-npm-test'));
  assert.ok(find(tree, 'workflow-checks'));
  click(find(tree, 'workflow-plan-check-npm-test'), cx);
  const payloads = [];
  fake.exec = async (_cmd, args) => { payloads.push(JSON.parse(args.at(-1))); return { code: 1, stdout: '{"error":"transport interrupted"}' }; };
  v.createPlan(cx); await flush();
  assert.deepEqual(payloads[0].checks, [['npm', 'test']]);
  click(find(v.render(), 'workflow-plan-check-none'), cx);
  v.createPlan(cx); await flush();
  assert.deepEqual(payloads[1].checks, []);
  click(find(v.render(), 'workflow-plan-check-custom'), cx);
  tree = v.render();
  assert.ok(find(tree, 'workflow-checks'));
  v.createPlan(cx); await flush();
  assert.deepEqual(payloads[2].checks, [['git', 'status']]);
  v.close();
});

test('a run without outcomes can open one prefilled task without dispatching', async () => {
  const { v, cx } = await setup();
  v.goal = { ...v.goal, steps: [] }; v.planDraftGoal = v.goal; v.planStepIds = [];
  let tree = v.render();
  assert.match(text(tree), /This run has no outcomes/);
  click(find(tree, 'workflow-plan-create-first-task'), cx);
  tree = v.render();
  assert.equal(v.tab, 'Overview');
  assert.equal(v.explicitNew, true);
  assert.equal(v.form.title.value(), v.goal.title);
  assert.equal(v.form.criteria.value(), v.goal.criteria);
  assert.equal(v.taskSetupOpen, true);
  assert.ok(find(tree, 'workflow-create'));
  assert.equal(fake.execs.length, 0);
  v.close();
});

test('runs without outcomes show brief work and existing standalone tasks separately', async () => {
  const { v, cx } = await setup();
  v.goal = { ...v.goal, steps: [] }; v.planDraftGoal = v.goal; v.planStepIds = [];
  let tree = v.render();
  assert.match(text(tree), /Work from brief/);
  assert.doesNotMatch(text(tree), /0\/0 outcomes validated/);
  assert.equal(find(tree, 'workflow-plan-refresh'), null);
  assert.doesNotMatch(text(tree), /Choose outcomes|Select the work to include/);
  assert.equal(text(find(tree, 'workflow-plan-create-first-task')), 'Create first task');
  const standalone = { id: 'standalone', goalId: 'g', title: 'Fix the queue', state: 'needs_you' };
  const cancelled = { id: 'cancelled', goalId: 'g', title: 'Old experiment', state: 'cancelled' };
  const planned = { id: 'planned', goalId: 'g', planId: 'p', title: 'Planned step', state: 'planned' };
  v.applyState({ tasks: [standalone, cancelled, planned], plans: [], events: [] });
  tree = v.render();
  assert.match(text(tree), /Fix the queue · Needs your review/);
  assert.match(text(tree), /Old experiment · Cancelled/);
  assert.doesNotMatch(text(tree), /Planned step/);
  assert.equal(text(find(tree, 'workflow-plan-create-first-task')), 'Add task');
  v.explicitNew = true; v.compactQueueOpen = true;
  click(find(tree, 'workflow-plan-standalone-standalone'), cx);
  assert.equal(v.selected, 'standalone');
  assert.equal(v.tab, 'Overview');
  assert.equal(v.explicitNew, false); assert.equal(v.compactQueueOpen, false);
  v.tab = 'Plan'; v.selected = null; v.compactQueueOpen = true;
  click(find(v.render(), 'workflow-plan-standalone-cancelled'), cx);
  assert.equal(v.selected, 'cancelled');
  assert.equal(v.filter, 'Completed');
  assert.equal(v.compactQueueOpen, false);
  assert.equal(fake.execs.length, 0);
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
  let tree = v.render();
  assert.ok(find(tree, 'workflow-start-plan-p'));
  assert.match(text(tree), /Ready to start/);
  assert.ok(find(tree, 'workflow-plan-more'));
  assert.ok(find(tree, 'workflow-plan-details-p'));
  assert.doesNotMatch(text(tree), /Repository:/); // setup detail stays folded by default
  v.selected = 'a'; v.tab = 'Overview'; assert.equal(find(v.render(), 'workflow-action-start'), null);
  click(find(v.render(), 'workflow-goal-plan'), cx);
  tree = v.render();
  assert.equal(find(tree, 'workflow-plan-select-a'), null);
  click(find(tree, 'workflow-plan-more'), cx);
  tree = v.render();
  assert.ok(find(tree, 'workflow-plan-select-b'));
  assert.ok(find(tree, 'workflow-plan-config'));
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

test('saved-plan next actions open results and progress without dispatching work', async () => {
  const { v, cx } = await setup();
  const tasks = [
    { id: 'review', goalId: 'g', planId: 'p', title: 'Review the first result', state: 'needs_you' },
    { id: 'next', goalId: 'g', planId: 'p', title: 'Continue the plan', state: 'ready' },
  ];
  const plan = { id: 'p', goalId: 'g', goalVersion: 1, taskIds: ['review', 'next'], state: 'started' };
  v.applyState({ tasks, plans: [plan], events: [] }); v.openPlan(cx);
  let tree = v.render();
  assert.match(text(tree), /Review: Review the first result/);
  assert.match(text(tree), /Review result/);
  click(find(tree, 'workflow-plan-next-p'), cx);
  assert.equal(v.selected, 'review'); assert.equal(v.filter, 'Needs you'); assert.equal(v.tab, 'Overview');
  assert.equal(fake.execs.length, 0);

  const reviewing = [tasks[0] = { ...tasks[0], state: 'accepted' }, { ...tasks[1], state: 'needs_review' }];
  v.applyState({ tasks: reviewing, plans: [plan], events: [] }); v.openPlan(cx);
  tree = v.render();
  assert.match(text(tree), /Independent review: Continue the plan/);
  assert.match(text(tree), /View progress/);
  click(find(tree, 'workflow-plan-next-p'), cx);
  assert.equal(v.selected, 'next'); assert.equal(v.filter, 'In progress'); assert.equal(v.tab, 'Overview');
  assert.equal(fake.execs.length, 0);

  const completed = reviewing.map((task) => ({ ...task, state: 'accepted' }));
  v.applyState({ tasks: completed, plans: [plan], events: [] }); v.openPlan(cx);
  assert.equal(find(v.render(), 'workflow-plan-more'), null);
  assert.ok(find(v.render(), 'workflow-create-plan'));
  v.close();
});

test('missing plan setup opens configuration and preserves the current draft', async () => {
  const { v, cx } = await setup();
  const selected = [...v.planStepIds];
  v.form.root.set_value('/work/app');
  click(find(v.render(), 'workflow-create-plan'), cx);
  assert.equal(v.planConfigOpen, true);
  assert.equal(v.form.root.value(), '/work/app');
  assert.deepEqual(v.planStepIds, selected);
  assert.ok(find(v.render(), 'workflow-root'));
  assert.match(v.error, /two different connected agents/);
  assert.equal(fake.execs.length, 0);
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
  assert.match(text(v.render()), /Queued\. Starts when its agent is free/);
  v.tasks[0].state = 'blocked'; assert.match(text(v.render()), /to be resolved and accepted/);
  v.tasks[0].state = 'cancelled'; assert.match(text(v.render()), /cannot start automatically/);
  v.engine.enabled = false; assert.match(text(v.render()), /cannot start automatically/);
  assert.equal(find(v.render(), 'workflow-action-start'), null);
  v.tasks[0].state = 'blocked'; assert.match(text(v.render()), /to be resolved and accepted/);
  v.tasks[0].state = 'accepted'; assert.ok(find(v.render(), 'workflow-action-start'));
  v.close();
});
