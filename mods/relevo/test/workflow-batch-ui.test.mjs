import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, flush, find, click, text } from './fake/ui.mjs';
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

test('accepting every waiting result saves without an error and posts Batch accepted', async () => {
  fake.props = { goalId: 'g', overlay: 'o' };
  const tasks = (state) => [
    { id: 'one', goalId: 'g', title: 'First result', root: '/repo', state, revision: 'r1' },
    { id: 'two', goalId: 'g', title: 'Second result', root: '/repo', state, revision: 'r1' },
  ];
  fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({ tasks: tasks('needs_you') });
  const view = new Workflow(), cx = fakeCx(); view.init({}, cx); await flush();
  click(find(view.render(), 'workflow-batch-toggle'), cx);
  click(find(view.render(), 'workflow-batch-select-one'), cx);
  click(find(view.render(), 'workflow-batch-select-two'), cx);
  fake.exec = async (_cmd, args) => JSON.parse(args.at(-1)).preview
    ? { stdout: JSON.stringify({ preview: [{ title: 'First result', nextEffect: 'accepted' }, { title: 'Second result', nextEffect: 'accepted' }] }) }
    : { stdout: JSON.stringify({ doc: { tasks: tasks('accepted') } }) };
  click(find(view.render(), 'workflow-batch-preview'), cx); await flush();
  click(find(view.render(), 'workflow-batch-confirm'), cx); await flush();
  assert.equal(view.error, null);
  assert.equal(fake.notices.at(-1)?.title, 'Batch accepted · 2 results');
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
  assert.deepEqual(payload.action === 'archive' ? payload : null, { action: 'archive', olderThanDays: 7, goalId: 'g' }, 'only this run is archived');
  assert.equal(view.notice, '1 finished task archived.');
  view.close();
});

test('an unchanged revision file skips the state read and the redraw', async () => {
  fake.props = { goalId: 'g', overlay: 'o' };
  const dir = '/home/test/.config/herdr-app/relevo-workflow';
  const files = { [`${dir}/state.json`]: JSON.stringify({ tasks: [{ id: 'one', goalId: 'g', title: 'First', root: '/repo', state: 'needs_you', revision: 'r1' }] }), [`${dir}/state.rev`]: '7' };
  const reads = [];
  fake.read = (path) => { reads.push(path.split('/').pop()); return files[path] ?? null; };
  const view = new Workflow(), cx = fakeCx(); view.init({}, cx); await flush();
  const stateReads = () => reads.filter((name) => name === 'state.json').length;
  assert.equal(stateReads(), 1);
  const drawn = cx.notified;
  cx.fire(3000); await flush();
  assert.equal(stateReads(), 1, 'the same revision reads nothing more'); assert.equal(cx.notified, drawn);
  files[`${dir}/state.json`] = JSON.stringify({ tasks: [{ id: 'one', goalId: 'g', title: 'First', root: '/repo', state: 'accepted', revision: 'r1' }] });
  files[`${dir}/state.rev`] = '8';
  cx.fire(3000); await flush();
  assert.equal(stateReads(), 2); assert.equal(view.tasks[0].state, 'accepted');
  view.close(); fake.read = null;
});

test('a cancelled run offers to discard its worktree and nothing to propose', async () => {
  fake.props = { goalId: 'g', overlay: 'o' };
  fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({ tasks: [
    { id: 'gone', goalId: 'g', title: 'Abandoned', root: '/wt', state: 'cancelled', revision: 'r1', worktree: { path: '/wt', branch: 'run/abandoned-1', base: '/repo' } },
  ] });
  const payloads = [];
  fake.exec = async (_cmd, args) => { const payload = JSON.parse(args.at(-1)); payloads.push(payload);
    return payload.action === 'worktree-status' ? { stdout: '{"result":{"exists":true,"dirty":true,"ahead":0}}' } : null; };
  const view = new Workflow(), cx = fakeCx(); view.init({}, cx); await flush();
  click(find(view.render(), 'workflow-filter-Completed'), cx); await flush();
  cx.fire(1000); await flush();
  const tree = view.render();
  assert.equal(find(tree, 'workflow-worktree-pr'), null); assert.equal(find(tree, 'workflow-worktree-remove'), null);
  click(find(tree, 'workflow-worktree-discard'), cx); await flush();
  assert.deepEqual(payloads.at(-1), { action: 'worktree-remove', taskId: 'gone' });
  view.close();
});

test('an accepted run with uncommitted changes and no commit offers to commit them', async () => {
  fake.props = { goalId: 'g', overlay: 'o' };
  fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({ tasks: [
    { id: 'late', goalId: 'g', title: 'Late', root: '/wt', state: 'accepted', revision: 'r1', worktree: { path: '/wt', branch: 'run/late-1', base: '/repo' } },
  ] });
  const payloads = [];
  fake.exec = async (_cmd, args) => { const payload = JSON.parse(args.at(-1)); payloads.push(payload);
    return payload.action === 'worktree-status' ? { stdout: '{"result":{"exists":true,"dirty":true,"ahead":0}}' } : null; };
  const view = new Workflow(), cx = fakeCx(); view.init({}, cx); await flush();
  click(find(view.render(), 'workflow-filter-Completed'), cx); await flush();
  cx.fire(1000); await flush();
  assert.equal(find(view.render(), 'workflow-worktree-remove'), null);
  click(find(view.render(), 'workflow-worktree-commit'), cx); await flush();
  assert.deepEqual(payloads.find((payload) => payload.action === 'worktree-commit'), { action: 'worktree-commit', taskId: 'late' });
  view.close();
});

test('a worktree status that fails to read says so and can be read again, without holding the window busy', async () => {
  fake.props = { goalId: 'g', overlay: 'o' };
  fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({ tasks: [
    { id: 'done', goalId: 'g', title: 'Finished', root: '/wt', state: 'accepted', revision: 'r1', worktree: { path: '/wt', branch: 'run/finished-1', base: '/repo' } },
  ] });
  let fail = true;
  fake.exec = async (_cmd, args) => { const payload = JSON.parse(args.at(-1));
    if (payload.action !== 'worktree-status') return null;
    return fail ? { code: 1, stdout: '{"error":"hc unavailable"}' } : { stdout: '{"result":{"exists":true,"dirty":false,"ahead":1}}' }; };
  const view = new Workflow(), cx = fakeCx(); view.init({}, cx); await flush();
  click(find(view.render(), 'workflow-filter-Completed'), cx); await flush();
  cx.fire(1000); await flush();
  let tree = view.render();
  assert.match(text(find(tree, 'workflow-worktree')), /could not read its state/);
  assert.equal(view.busy, false);
  assert.equal(find(tree, 'workflow-worktree-pr'), null, 'nothing is offered on an unknown state');
  fail = false;
  click(find(tree, 'workflow-worktree-reread'), cx); cx.fire(1000); await flush();
  tree = view.render();
  assert.match(text(find(tree, 'workflow-worktree')), /1 commits/);
  view.close();
});
