import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, flush, find, click, text } from './fake/ui.mjs';
const { Workflow } = await import('../workflow.js');
beforeEach(() => { resetFake(); fake.stored['relevo.runs.mode'] = 'sessions'; });

async function setup() {
  fake.props = { goalId: 'g', overlay: 'o' };
  fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({ tasks: [
    { id: 'ready', goalId: 'g', title: 'Review search', state: 'needs_you', revision: 'r1' },
    { id: 'older', goalId: 'g', title: 'Earlier blocker', state: 'blocked' },
  ] });
  const view = new Workflow(), cx = fakeCx(); view.init({}, cx); await flush();
  return { view, cx };
}

test('compact mission keeps the decision visible and opens the queue without losing selection or notes', async () => {
  const { view, cx } = await setup();
  view.form.decision.set_value('Check the edge case');
  find(view.render(), 'workflow-dialog').handlers.on_size_change({ width: 540, height: 620 }, cx);

  assert.ok(find(view.render(), 'workflow-decide-accept'));
  assert.equal(find(view.render(), 'workflow-task-older'), null);
  click(find(view.render(), 'workflow-queue-toggle'), cx);
  assert.ok(find(view.render(), 'workflow-task-older'));
  click(find(view.render(), 'workflow-task-ready'), cx);

  assert.ok(find(view.render(), 'workflow-decide-accept'));
  assert.equal(view.form.decision.value(), 'Check the edge case');
  assert.equal(fake.execs.length, 0);
  view.close();
});

test('queue keyboard navigation leaves task creation while preserving its draft', async () => {
  const { view, cx } = await setup();
  view.explicitNew = true; view.selected = null; view.form.title.set_value('Unsent follow-up');
  view.h.is_focused = () => true;

  find(view.render(), 'workflow-dialog').handlers.on_key_down({ key: 'down' }, cx);
  view.applyState({ tasks: view.tasks });

  assert.equal(view.explicitNew, false);
  assert.match(text(view.render()), /Review search/);
  assert.equal(find(view.render(), 'workflow-create'), null);
  assert.equal(view.form.title.value(), 'Unsent follow-up');
  assert.equal(fake.execs.length, 0);
  view.close();
});
