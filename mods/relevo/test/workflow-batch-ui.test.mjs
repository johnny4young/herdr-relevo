import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, flush, find, click } from './fake/ui.mjs';
const { Workflow } = await import('../workflow.js');
beforeEach(() => { resetFake(); fake.stored['relevo.runs.mode'] = 'sessions'; });

test('batch review reuses the task list and previews only explicitly selected results', async () => {
  fake.props = { goalId: 'g', overlay: 'o' };
  fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({ tasks: [
    { id: 'one', goalId: 'g', title: 'First result', root: '/repo', state: 'needs_you', revision: 'r1' },
    { id: 'two', goalId: 'g', title: 'Second result', root: '/repo', state: 'needs_you', revision: 'r1' },
    { id: 'blocked', goalId: 'g', title: 'Blocked', root: '/repo', state: 'blocked' },
  ] });
  const view = new Workflow(), cx = fakeCx(); view.init({}, cx); await flush();
  assert.equal(find(view.render(), 'workflow-batch-select-one'), null);

  click(find(view.render(), 'workflow-batch-toggle'), cx);
  assert.equal(find(view.render(), 'workflow-task-one'), null);
  assert.equal(find(view.render(), 'workflow-batch-select-blocked'), null);
  click(find(view.render(), 'workflow-batch-select-one'), cx);
  assert.equal(find(view.render(), 'workflow-batch-preview').isDisabled, true);
  click(find(view.render(), 'workflow-batch-select-two'), cx);
  assert.equal(find(view.render(), 'workflow-batch-preview').isDisabled, false);
  assert.equal(fake.execs.length, 0);
  let payload;
  fake.exec = async (_cmd, args) => { payload = JSON.parse(args.at(-1)); return { stdout: '{"preview":[]}' }; };
  click(find(view.render(), 'workflow-batch-preview'), cx); await flush();
  assert.deepEqual(payload, { action: 'batch', ids: ['one', 'two'], outcome: 'accept', revisions: { one: 'r1', two: 'r1' }, preview: true });

  click(find(view.render(), 'workflow-batch-toggle'), cx);
  assert.ok(find(view.render(), 'workflow-task-one'));
  assert.equal(find(view.render(), 'workflow-batch-select-one'), null);
  assert.equal(fake.execs.length, 1, 'leaving selection never accepts results');
  view.close();
});

test('history offers archiving and reports how many tasks moved', async () => {
  fake.props = { goalId: 'g', overlay: 'o' };
  fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({ tasks: [
    { id: 'done', goalId: 'g', title: 'Done', root: '/repo', state: 'accepted', revision: 'r1' },
  ] });
  const view = new Workflow(), cx = fakeCx(); view.init({}, cx); await flush();
  assert.equal(find(view.render(), 'workflow-archive'), null, 'only history offers it');
  click(find(view.render(), 'workflow-filter-Completed'), cx); await flush();
  let payload;
  fake.exec = async (_cmd, args) => { payload = JSON.parse(args.at(-1)); return payload.action === 'archive' ? { stdout: '{"result":{"archived":1}}' } : null; };
  click(find(view.render(), 'workflow-archive'), cx); await flush();
  assert.deepEqual(payload.action === 'archive' ? payload : null, { action: 'archive', olderThanDays: 7 });
  assert.equal(view.notice, '1 finished task archived.');
  view.close();
});
