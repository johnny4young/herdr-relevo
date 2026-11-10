import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, flush, find, click, text } from './fake/ui.mjs';
import { newGoal, saveGoal, emptyGoals } from '../lib/goals.js';
const { goalsPath, readGoals } = await import('../goals-store.js');
const { GoalEditor } = await import('../goals-editor.js');
const { Inbox } = await import('../inbox.js');
const { Workflow } = await import('../workflow.js');
const path = '/home/test/.config/herdr-app/relevo-workflow/state.json';
const task = { id: 't', goalId: 'g', title: 'Search result', state: 'needs_you', revision: 'r1', round: 1, maxRounds: 3 };
const goal = () => ({ ...newGoal('g', 'Search'), decision: 'Accept search?', decisionLink: { taskId: 't', question: 'Accept search?' } });
beforeEach(resetFake);
async function load(View, record = goal(), tasks = [task]) {
  fake.files[goalsPath()] = JSON.stringify(saveGoal(emptyGoals(), record, 0));
  fake.files[path] = JSON.stringify({ tasks, engine: { enabled: false } });
  fake.props = { goalId: 'g', overlay: 'o' };
  const view = new View(), cx = fakeCx(); view.init({}, cx); await flush();
  return { view, cx };
}

test('a linked question appears once with its result and disappears only after explicit acceptance', async () => {
  const { view, cx } = await load(Inbox);
  let tree = view.render(cx);
  assert.equal(find(tree, 'inbox-summary'), null);
  assert.ok(find(tree, 'result-t'));
  assert.equal(find(tree, 'decision-g'), null);
  const data = fake.files[goalsPath()];
  fake.files[path] = JSON.stringify({ tasks: [{ ...task, state: 'accepted', decisions: [{ outcome: 'accept', revision: 'r1' }] }] });
  cx.fire(5000); await flush(); tree = view.render(cx);
  assert.equal(find(tree, 'result-t'), null); assert.equal(find(tree, 'decision-g'), null);
  assert.equal(fake.files[goalsPath()], data, 'projection never rewrites the saved question');
});

test('the editor explicitly links a question, preserves it on save and never accepts work', async () => {
  const { view, cx } = await load(GoalEditor, { ...goal(), decisionLink: null });
  click(find(view.render(), 'goal-decision-link-toggle'), cx);
  click(find(view.render(), 'goal-decision-link-t'), cx);
  view.save(cx); await flush();
  const saved = (await readGoals()).doc.goals[0];
  assert.equal(saved.decision, 'Accept search?');
  assert.deepEqual(saved.decisionLink, { taskId: 't', question: 'Accept search?' });
  assert.equal(fake.execs.length, 0); view.close();
});

test('editing a linked question detaches the old acceptance instead of hiding the new question', async () => {
  const accepted = { ...task, state: 'accepted', decisions: [{ outcome: 'accept', revision: 'r1' }] };
  const { view, cx } = await load(GoalEditor, goal(), [accepted]);
  assert.match(text(view.render()), /Resolved by your acceptance/);
  view.fields.decision.type('Publish the result?', cx); view.save(cx); await flush();
  const saved = (await readGoals()).doc.goals[0];
  assert.equal(saved.decision, 'Publish the result?'); assert.equal(saved.decisionLink, null); view.close();
});

test('saving a resolved linked question rechecks acceptance and preserves history', async () => {
  const accepted = { ...task, state: 'accepted', decisions: [{ outcome: 'accept', revision: 'r1' }] };
  const { view, cx } = await load(GoalEditor, goal(), [accepted]);
  view.save(cx); await flush();
  const saved = (await readGoals()).doc.goals[0];
  assert.equal(saved.decision, ''); assert.equal(saved.decisions.at(-1).text, 'Accept search?');
  assert.equal(saved.decisions.at(-1).resolved, true); view.close();
});

test('a changed accepted revision blocks stale question resolution', async () => {
  const accepted = { ...task, state: 'accepted', decisions: [{ outcome: 'accept', revision: 'r1' }] };
  const { view, cx } = await load(GoalEditor, goal(), [accepted]);
  fake.files[path] = JSON.stringify({ tasks: [{ ...accepted, revision: 'r2' }] });
  view.save(cx); await flush();
  assert.match(text(view.render()), /linked acceptance changed/);
  assert.equal((await readGoals()).doc.goals[0].decision, 'Accept search?'); view.close();
});

test('keyboard acceptance requires A then Enter and advances to the next pending result', async () => {
  const second = { ...task, id: 'next', title: 'Next result' };
  const { view, cx } = await load(Workflow, goal(), [task, second]);
  view.h.is_focused = () => true;
  const key = (key) => find(view.render(), 'workflow-dialog').handlers.on_key_down({ key }, cx);
  assert.match(text(view.render()), /Also resolves: Accept search/);
  key('enter'); assert.equal(fake.execs.length, 0);
  key('a'); assert.match(text(find(view.render(), 'workflow-decide-accept')), /Confirm/);
  assert.equal(fake.execs.length, 0);
  fake.exec = async (_cmd, args) => {
    const payload = JSON.parse(args.at(-1));
    assert.deepEqual(payload, { action: 'decide', taskId: 't', outcome: 'accept', text: '', revision: 'r1' });
    const doc = { tasks: [{ ...task, state: 'accepted', decisions: [{ outcome: 'accept', revision: 'r1' }] }, second] };
    fake.files[path] = JSON.stringify(doc); return { code: 0, stdout: JSON.stringify({ doc }) };
  };
  key('enter'); await flush();
  assert.equal(fake.execs.length, 1); assert.equal(view.selected, 'next');
  assert.equal(text(find(view.render(), 'workflow-decide-accept')), 'Accept'); view.close();
});

test('a stale revision or descendant input cannot confirm keyboard acceptance', async () => {
  const { view, cx } = await load(Workflow);
  view.h.is_focused = () => true;
  find(view.render(), 'workflow-dialog').handlers.on_key_down({ key: 'a' }, cx);
  view.applyState({ tasks: [{ ...task, revision: 'r2' }] });
  find(view.render(), 'workflow-dialog').handlers.on_key_down({ key: 'enter' }, cx);
  view.h.is_focused = () => false;
  find(view.render(), 'workflow-dialog').handlers.on_key_down({ key: 'a' }, cx);
  find(view.render(), 'workflow-dialog').handlers.on_key_down({ key: 'enter' }, cx);
  assert.equal(fake.execs.length, 0); view.close();
});

test('R opens feedback and Command-Enter sends only nonempty changes for that result', async () => {
  const { view, cx } = await load(Workflow); view.h.is_focused = () => true;
  find(view.render(), 'workflow-dialog').handlers.on_key_down({ key: 'r' }, cx);
  const send = () => find(view.render(), 'workflow-decision-editor').handlers.on_key_down({ key: 'enter', modifiers: { platform: true } }, cx);
  send(); assert.equal(fake.execs.length, 0);
  view.form.decision.set_value('Keep the search query visible');
  fake.exec = async (_cmd, args) => {
    const payload = JSON.parse(args.at(-1));
    assert.equal(payload.outcome, 'changes'); assert.equal(payload.text, 'Keep the search query visible');
    assert.equal(payload.taskId, 't');
    const doc = { tasks: [{ ...task, state: 'ready' }] }; fake.files[path] = JSON.stringify(doc);
    return { code: 0, stdout: JSON.stringify({ doc }) };
  };
  send(); await flush(); assert.equal(fake.execs.length, 1); view.close();
});

test('cancelling a change request restores pane focus and Escape keeps the pane open', async () => {
  const { view, cx } = await load(Workflow); let focused = false;
  view.h.focus = () => { focused = true; }; view.h.is_focused = () => focused;
  view.editDecisionNote(task, true, cx);
  view.form.decision.set_value('Unsent feedback');
  click(find(view.render(), 'workflow-decision-note-cancel'), cx);
  assert.equal(focused, true);
  find(view.render(), 'workflow-dialog').handlers.on_key_down({ key: 'escape' }, cx);
  assert.equal(fake.runs.some(([name]) => name === 'pane.close'), false);
  assert.equal(fake.execs.length, 0); view.close();
});

test('a ready result card carries its meta line', async () => {
  const { view, cx } = await load(Inbox, newGoal('g', 'Search'), [{ ...task, executor: { label: 'Codex' }, reviewer: { label: 'Claude' } }]);
  const tree = view.render(cx);
  assert.match(text(find(tree, 'meta-result-t')), /^Codex → Claude · round 1\/3/);
});
