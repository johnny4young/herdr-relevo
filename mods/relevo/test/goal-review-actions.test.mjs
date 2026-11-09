import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, find, click, flush, text } from './fake/ui.mjs';
const { GoalEditor, openGoal } = await import('../goals-editor.js');
const { InputState } = await import('gpui-base');
const { readGoals, goalsPath } = await import('../goals-store.js');
const { emptyGoals, newGoal, saveGoal } = await import('../lib/goals.js');
beforeEach(resetFake);
async function editor() {
  fake.props = { panel: 'plan' }; const v = new GoalEditor(), cx = fakeCx(); v.init({}, cx); await flush();
  v.fields.title.set_value('Synthetic goal'); v.fields.decision.set_value('Accept the result?');
  v.goal.decisions = [{ text: 'Existing reasoning', at: '2026-01-01T00:00:00.000Z', revisions: [] }];
  v.steps = ['review', 'todo', 'done'].map((state, i) => ({ id: `s${i}`, state, input: InputState.new({ value: `Outcome ${i}` }) }));
  return { v, cx };
}

const workflowPath = '/home/test/.config/herdr-app/relevo-workflow/state.json';
function acceptedTask(goal, { title = 'Outcome', criteria = 'Expected result', state = 'accepted', id = 'task-1' } = {}) {
  return { id, goalId: goal.id, goalStep: { id: 's1', title, criteria }, state };
}
async function editorWithStep(tasks = [], readWorkflow = null) {
  const goal = { ...newGoal('g1', 'Synthetic goal'), criteria: 'Expected result',
    steps: [{ id: 's1', title: 'Outcome', state: 'todo' }] };
  fake.files[goalsPath()] = JSON.stringify(saveGoal(emptyGoals(), goal, 0));
  fake.files[workflowPath] = JSON.stringify({ tasks });
  if (readWorkflow) fake.read = async (path) => path === workflowPath ? readWorkflow() : fake.files[path] ?? null;
  fake.props = { goalId: 'g1', overlay: 'goal-editor', panel: 'plan' };
  const v = new GoalEditor(), cx = fakeCx(); v.init({}, cx); await flush();
  return { v, cx, goal };
}

test('direct plan entry and bulk validation remain a draft until Save', async () => {
  openGoal('synthetic', null, 'plan'); assert.equal(fake.overlays[0].props.panel, 'plan');
  const { v, cx } = await editor(); assert.equal(v.panel, 'plan');
  click(find(v.render(), 'goal-validate-all'), cx); assert.deepEqual(v.steps.map((s) => s.state), ['done', 'done', 'done']);
  assert.deepEqual(fake.files, {}); assert.equal(find(v.render(), 'goal-finish').isDisabled, true);
  assert.equal(v.fields.decision.value(), 'Accept the result?'); v.close();
});
test('resolve, validate and finish preserves prior notes and records the resolved question', async () => {
  const { v, cx } = await editor(); click(find(v.render(), 'goal-validate-all'), cx);
  click(find(v.render(), 'goal-plan-decision'), cx); v.response.set_value('Reviewed the result');
  click(find(v.render(), 'goal-resolve-decision'), cx); click(find(v.render(), 'goal-review-steps'), cx);
  assert.equal(find(v.render(), 'goal-finish').isDisabled, false); click(find(v.render(), 'goal-finish'), cx); await flush();
  const saved = (await readGoals()).doc.goals[0]; assert.equal(saved.state, 'completed'); assert.equal(saved.decision, '');
  assert.equal(saved.decisions[0].text, 'Existing reasoning'); assert.equal(saved.decisions[1].text, 'Accept the result?');
  assert.equal(saved.decisions[1].resolved, true); assert.equal(saved.decisions[2].text, 'Reviewed the result');
  assert.ok(saved.steps.every((s) => s.state === 'done')); assert.deepEqual(fake.execs, []); v.close();
});
test('resolution can be undone before saving, and a note alone does not validate or resolve', async () => {
  const { v, cx } = await editor(); v.panel = 'decision'; v.response.set_value('Note only');
  click(find(v.render(), 'goal-resolve-decision'), cx); click(find(v.render(), 'goal-resolve-decision'), cx);
  v.save(cx); await flush(); const saved = (await readGoals()).doc.goals[0];
  assert.equal(saved.decision, 'Accept the result?'); assert.equal(saved.state, 'active');
  assert.deepEqual(saved.steps.map((s) => s.state), ['review', 'todo', 'done']); assert.equal(saved.decisions.at(-1).text, 'Note only'); v.close();
});
test('retained bulk validation cannot mutate a dismissed, busy or different-section editor', async () => {
  for (const state of ['closed', 'busy', 'section']) {
    const { v, cx } = await editor(), control = find(v.render(), 'goal-validate-all');
    if (state === 'closed') v.close(); else if (state === 'busy') v.busy = true; else v.panel = 'decision';
    click(control, cx); assert.deepEqual(v.steps.map((s) => s.state), ['review', 'todo', 'done']); if (state !== 'closed') v.close();
  }
});

test('a matching accepted task displays validation and Save persists it after rereading workflow state', async () => {
  let workflowReads = 0;
  const matching = acceptedTask({ id: 'g1' });
  const { v, cx } = await editorWithStep([], () => {
    workflowReads++;
    return JSON.stringify({ tasks: [matching] });
  });
  assert.equal(workflowReads, 1);
  assert.deepEqual(v.workflowTasks, [matching]);
  assert.deepEqual(v.projectedSteps().map(({ state, source }) => ({ state, source })), [{ state: 'done', source: 'workflow' }]);
  const tree = v.render();
  assert.match(text(tree), /Validated by your Workflow acceptance/);
  assert.equal(find(tree, 'goal-step-s1-done').isSelected, true);
  v.save(cx); await flush();
  assert.equal(workflowReads, 2);
  assert.equal((await readGoals()).doc.goals[0].steps[0].state, 'done');
  v.close();
});

test('an accepted result that changes before Save is not copied into the goal', async () => {
  let workflowReads = 0;
  const { v, cx } = await editorWithStep([], () => {
    workflowReads++;
    return JSON.stringify({ tasks: [acceptedTask({ id: 'g1' }, { state: workflowReads === 1 ? 'accepted' : 'cancelled' })] });
  });
  const before = fake.files[goalsPath()];
  v.save(cx); await flush();
  assert.equal(workflowReads, 2);
  assert.match(v.error, /accepted workflow result changed/);
  assert.equal(fake.files[goalsPath()], before);
  v.close();
});

test('stale title or criteria, cancelled work and ambiguous matches never earn implicit validation', async () => {
  const cases = [
    [acceptedTask({ id: 'g1' }, { title: 'Old outcome' })],
    [acceptedTask({ id: 'g1' }, { criteria: 'Old criteria' })],
    [acceptedTask({ id: 'g1' }, { state: 'cancelled' })],
    [acceptedTask({ id: 'g1' }), acceptedTask({ id: 'g1' }, { id: 'task-2' })],
  ];
  for (const tasks of cases) {
    const { v, cx } = await editorWithStep(tasks);
    v.save(cx); await flush();
    assert.equal((await readGoals()).doc.goals[0].steps[0].state, 'todo');
    v.close();
  }
});

test('editing accepted step title or goal criteria drops workflow credit', async () => {
  for (const edit of ['title', 'criteria']) {
    const { v, cx } = await editorWithStep([acceptedTask({ id: 'g1' })]);
    if (edit === 'title') v.steps[0].input.set_value('Edited outcome');
    else v.fields.criteria.set_value('Edited criteria');
    v.save(cx); await flush();
    assert.equal((await readGoals()).doc.goals[0].steps[0].state, 'todo', edit);
    v.close();
  }
});

test('a user validated step stays validated even when workflow tasks are ambiguous', async () => {
  const { v, cx } = await editorWithStep([]);
  v.steps[0].state = 'done';
  v.workflowTasks = [acceptedTask({ id: 'g1' }), acceptedTask({ id: 'g1' }, { id: 'task-2', state: 'running' })];
  v.save(cx); await flush();
  assert.equal((await readGoals()).doc.goals[0].steps[0].state, 'done');
  v.close();
});
test('resolution and note at their individual text limits retain both without truncation', async () => {
  const { v, cx } = await editor(); v.fields.decision.set_value('q'.repeat(2000)); v.response.set_value('n'.repeat(2000));
  v.resolvePending = true; v.save(cx); await flush(); const saved = (await readGoals()).doc.goals[0];
  assert.equal(saved.decisions.at(-2).text, 'q'.repeat(2000)); assert.equal(saved.decisions.at(-1).text, 'n'.repeat(2000)); v.close();
});
