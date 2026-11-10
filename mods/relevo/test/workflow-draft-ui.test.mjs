import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, flush, find, click, text } from './fake/ui.mjs';
const { Workflow } = await import('../workflow.js');
const { createWorkflowDrafts } = await import('../workflow-drafts.js');
beforeEach(() => { resetFake(); fake.stored['relevo.runs.mode'] = 'sessions'; });
async function setup(goalId = 'g') {
  fake.props = { goalId }; const v = new Workflow(), cx = fakeCx(); v.init({}, cx); await flush(); return { v, cx };
}
function fill(v, cx) {
  v.form.root.type('/work/app', cx); v.form.title.type('Unsent change', cx); v.form.criteria.type('Keep this outcome', cx);
  v.executor = 'build'; v.reviewer = 'review'; v.form.maxRounds.type('1', cx); v.form.maxMinutes.type('8', cx);
}

test('closing and reopening offers the local draft without replacing another mission or dispatching', async () => {
  const first = await setup(); fill(first.v, first.cx); first.v.close();
  const other = await setup('other'); assert.equal(find(other.v.render(), 'workflow-resume-draft'), null); other.v.close();
  const second = await setup();
  assert.match(text(second.v.render()), /Unsent draft · Unsent change/);
  assert.equal(find(second.v.render(), 'workflow-title'), null, 'resolve recovery before editing a competing draft');
  second.v.close();
  const third = await setup(); fake.agents = [{ address: 'build', cwd: '/work/app' }, { address: 'review', cwd: '/work/app' }];
  click(find(third.v.render(), 'workflow-resume-draft'), third.cx);
  assert.equal(third.v.form.title.value(), 'Unsent change'); assert.equal(third.v.form.root.value(), '/work/app');
  assert.equal(third.v.form.criteria.value(), 'Keep this outcome'); assert.equal(third.v.executor, 'build');
  assert.equal(third.v.form.maxMinutes.value(), '8'); assert.equal(fake.execs.length, 0); third.v.close();
});

test('restoring revalidates agents and missing prerequisites; discard clears only unsent work', async () => {
  const first = await setup(); fill(first.v, first.cx); first.v.dependsOn = ['missing']; first.v.close();
  const second = await setup(); fake.agents = [{ address: 'build', cwd: '/wrong' }];
  click(find(second.v.render(), 'workflow-resume-draft'), second.cx);
  assert.equal(second.v.executor, ''); assert.equal(second.v.reviewer, ''); assert.deepEqual(second.v.dependsOn, []);
  assert.match(text(second.v.render()), /was not restored.*prerequisites are no longer available/);
  click(find(second.v.render(), 'workflow-discard-draft'), second.cx); second.v.close();
  const third = await setup(); assert.equal(find(third.v.render(), 'workflow-resume-draft'), null);
  assert.equal(fake.execs.length, 0); third.v.close();
});

test('successful creation clears the submitted draft even if its window closes while saving', async () => {
  const { v, cx } = await setup(); fill(v, cx);
  fake.agents = [{ address: 'build' }, { address: 'review' }];
  let finish; fake.exec = () => new Promise((resolve) => { finish = resolve; });
  v.create(cx); await flush(); v.close();
  finish({ stdout: '{"doc":{},"result":{"taskId":"created"}}' }); await flush();
  assert.equal(createWorkflowDrafts().load('g'), null);
  const next = await setup(); assert.equal(find(next.v.render(), 'workflow-resume-draft'), null);
  assert.equal(fake.execs.length, 1); next.v.close();
});

test('failed creation keeps the draft and later success preserves edits made while saving', async () => {
  const { v, cx } = await setup(); fill(v, cx);
  fake.agents = [{ address: 'build' }, { address: 'review' }];
  fake.exec = async () => ({ code: 1, stderr: 'offline' }); v.create(cx); await flush();
  assert.equal(createWorkflowDrafts().load('g').title, 'Unsent change');
  let finish; fake.exec = () => new Promise((resolve) => { finish = resolve; });
  v.create(cx); await flush(); v.form.title.type('Newer unsent change', cx);
  finish({ stdout: '{"doc":{},"result":{"taskId":"created"}}' }); await flush();
  assert.equal(v.form.title.value(), 'Newer unsent change');
  assert.equal(createWorkflowDrafts().load('g').title, 'Newer unsent change');
  assert.match(v.notice, /newer draft edits/); v.close();
});
