import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, flush, find } from './fake/ui.mjs';
const { GoalEditor } = await import('../goals-editor.js');
const { InputState } = await import('gpui-base');
const { readGoals } = await import('../goals-store.js');
const source = { key: 'pr:https://github.com/acme/app/pull/1', revision: 'a'.repeat(40), title: 'Synthetic PR' };
beforeEach(resetFake);
async function editor(states = ['todo']) {
  fake.props = { source, overlay: 'own-editor' }; const view = new GoalEditor(), cx = fakeCx(); view.init({}, cx); await flush();
  view.fields.title.set_value('Preserved goal'); view.fields.owner.set_value('Draft owner'); view.fields.criteria.set_value('Preserved criteria');
  view.goal.state = 'completed'; view.panel = 'ownership';
  view.steps = states.map((state, i) => ({ id: `step-${i}`, state, input: InputState.new({ value: `Outcome ${i + 1}` }) }));
  return { view, cx };
}
function forbidIO() {
  fake.read = () => assert.fail('invalid completion must not read metadata');
  fake.write = () => assert.fail('invalid completion must not write metadata');
  fake.exec = () => assert.fail('invalid completion must not query GitHub');
}

test('a pending decision points to Decision before I/O and preserves all drafts', async () => {
  const { view, cx } = await editor(['done']); view.fields.decision.set_value('Choose the rollout'); view.response.set_value('Keep this feedback'); forbidIO();
  view.save(cx); await flush(); assert.equal(view.panel, 'decision'); assert.match(view.error, /Resolve the pending decision/);
  assert.match(view.error, /choose In progress/); assert.equal(view.fields.owner.value(), 'Draft owner'); assert.equal(view.fields.criteria.value(), 'Preserved criteria');
  assert.equal(view.response.value(), 'Keep this feedback'); assert.equal(view.goal.state, 'completed'); assert.deepEqual(fake.closedOverlays, []); view.close();
});

test('the first unvalidated step is identified and focused in Plan without changing its state', async () => {
  const { view, cx } = await editor(['done', 'review', 'todo']); forbidIO(); let focused = 0; view.steps[1].input.focus = () => { focused++; };
  view.save(cx); await flush(); assert.equal(view.panel, 'plan'); assert.match(view.error, /Validate plan step 2/); assert.equal(view.busy, false);
  assert.ok(find(view.render(), 'goal-step-step-1-done')); cx.timers.at(-1).fn(cx); assert.equal(focused, 1);
  assert.deepEqual(view.steps.map((s) => s.state), ['done', 'review', 'todo']); assert.deepEqual(fake.execs, []); view.close();
});

test('a pending decision is explained before an unfinished plan when both block closure', async () => {
  const { view, cx } = await editor(); view.fields.decision.set_value('Still pending'); forbidIO(); view.save(cx); await flush();
  assert.equal(view.panel, 'decision'); assert.match(view.error, /Resolve the pending decision/); assert.equal(view.steps[0].state, 'todo'); view.close();
});

test('invalid completion never performs an otherwise valid evidence lookup', async () => {
  const { view, cx } = await editor(); view.link.set_value('https://example.com/demo'); forbidIO(); view.save(cx); await flush();
  assert.match(view.error, /Validate plan step 1/); assert.equal(view.link.value(), 'https://example.com/demo'); assert.deepEqual(fake.execs, []); assert.deepEqual(fake.files, {}); view.close();
});

test('completion guidance never focuses a removed step or a dismissed editor', async () => {
  const { view, cx } = await editor(); view.save(cx); await flush(); assert.match(view.error, /Validate plan step 1/);
  const step = view.steps[0], timer = cx.timers.at(-1); let focused = 0; step.input.focus = () => { focused++; };
  view.steps = []; timer.fn(cx); assert.equal(focused, 0); step.input.release(); view.close(); timer.fn(cx); assert.equal(focused, 0);
});

test('a resolved goal with all steps validated or no steps still saves through the store', async () => {
  for (const states of [['done'], []]) {
    resetFake(); const { view, cx } = await editor(states); view.save(cx); await flush(); const saved = (await readGoals()).doc.goals[0];
    assert.equal(saved.state, 'completed'); assert.equal(saved.owner, 'Draft owner'); assert.equal(saved.steps.length, states.length);
    assert.deepEqual(fake.closedOverlays, ['own-editor']); assert.deepEqual(fake.execs, []); view.close();
  }
});

test('in-progress goals retain pending decisions and unvalidated plans when saved', async () => {
  const { view, cx } = await editor(); view.goal.state = 'active'; view.fields.decision.set_value('Keep pending'); view.save(cx); await flush();
  const saved = (await readGoals()).doc.goals[0]; assert.equal(saved.state, 'active'); assert.equal(saved.decision, 'Keep pending'); assert.equal(saved.steps[0].state, 'todo'); view.close();
});

test('correcting each closure blocker preserves feedback and other edits', async () => {
  const { view, cx } = await editor(); view.fields.decision.set_value('Pending'); view.response.set_value('Validated in synthetic QA'); view.save(cx); await flush();
  assert.match(view.error, /Resolve the pending decision/); view.fields.decision.set_value(''); view.save(cx); await flush(); assert.match(view.error, /Validate plan step 1/);
  view.steps[0].state = 'done'; view.save(cx); await flush(); const saved = (await readGoals()).doc.goals[0];
  assert.equal(saved.state, 'completed'); assert.equal(saved.owner, 'Draft owner'); assert.equal(saved.criteria, 'Preserved criteria'); assert.equal(saved.decisions[0].text, 'Validated in synthetic QA'); view.close();
});
