import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, flush, find, click, text } from './fake/ui.mjs';
const { Workflow } = await import('../workflow.js');
const { SETUPS_KEY, savedSetups } = await import('../workflow-setups.js');
beforeEach(() => { resetFake(); fake.stored['relevo.runs.mode'] = 'sessions'; });
const preset = () => ({ id: 'bounded', name: 'Small change', purpose: 'A focused implementation with independent review', root: '/work/app',
  executor: { address: 'build', label: 'Builder' }, reviewer: { address: 'review', label: 'Reviewer' },
  checks: [['npm', 'test']], maxRounds: 1, maxMinutes: 8 });
async function setup() {
  fake.props = { goalId: 'g' }; fake.agents = [{ address: 'build', cwd: '/work/app' }, { address: 'review', cwd: '/work/app' }];
  const v = new Workflow(), cx = fakeCx(); v.init({}, cx); await flush();
  v.taskSetupOpen = true; v.setupsOpen = true; return { v, cx };
}

test('saved setup previews limits and preserves the new brief without dispatch or task mutation', async () => {
  fake.stored[SETUPS_KEY] = { version: 1, items: [preset()] };
  const { v, cx } = await setup();
  v.form.title.set_value('New work'); v.form.criteria.set_value('New expected result');
  v.tasks = [{ id: 'running', goalId: 'g', title: 'Already running', state: 'running', maxRounds: 4 }]; v.explicitNew = true;
  assert.match(text(v.render()), /Small change.*1 round · 8 min · 1 check/);
  click(find(v.render(), 'workflow-apply-setup-bounded'), cx);
  assert.equal(v.form.title.value(), 'New work'); assert.equal(v.form.criteria.value(), 'New expected result');
  assert.equal(v.form.root.value(), '/work/app'); assert.equal(v.executor, 'build'); assert.equal(v.reviewer, 'review');
  assert.equal(v.form.maxRounds.value(), '1'); assert.equal(v.form.maxMinutes.value(), '8');
  assert.equal(v.tasks[0].maxRounds, 4); assert.equal(fake.execs.length, 0); v.close();
});

test('saved setup rejects changed repository and warns about unavailable agents on reuse', async () => {
  fake.stored[SETUPS_KEY] = { version: 1, items: [preset()] };
  const { v, cx } = await setup();
  v.form.root.set_value('/work/other');
  assert.equal(find(v.render(), 'workflow-apply-setup-bounded'), null);
  v.applySavedSetup('bounded', cx);
  assert.match(v.setupError, /another repository/); assert.equal(v.form.root.value(), '/work/other');
  v.form.root.set_value('/work/app'); fake.agents = [{ address: 'build', cwd: '/work/elsewhere' }];
  v.applySavedSetup('bounded', cx);
  assert.equal(v.executor, ''); assert.equal(v.reviewer, '');
  assert.match(v.setupReuseWarning, /Builder.*unavailable.*Reviewer.*unavailable/);
  assert.equal(fake.execs.length, 0); v.close();
});

test('saving stores only setup data locally, survives reopening, rejects duplicates and removes without changing a draft', async () => {
  const { v, cx } = await setup();
  v.form.title.set_value('Private brief'); v.form.criteria.set_value('Private outcome');
  v.form.root.set_value('/work/app'); v.executor = 'build'; v.reviewer = 'review';
  v.form.setupName.set_value('Small change'); v.form.setupPurpose.set_value('A focused change');
  v.saveSetup(cx); const id = savedSetups()[0].id;
  assert.equal(JSON.stringify(fake.stored[SETUPS_KEY]).includes('Private'), false);
  assert.equal(savedSetups()[0].purpose, 'A focused change'); v.close();
  const next = await setup();
  click(find(next.v.render(), 'workflow-resume-draft'), next.cx); next.v.taskSetupOpen = true;
  assert.ok(find(next.v.render(), `workflow-apply-setup-${id}`));
  next.v.form.root.set_value('/work/app'); next.v.executor = 'build'; next.v.reviewer = 'review';
  next.v.form.setupName.set_value('Small change'); next.v.saveSetup(next.cx);
  assert.match(next.v.setupError, /already exists/); assert.equal(savedSetups().length, 1);
  next.v.form.title.set_value('Keep draft');
  click(find(next.v.render(), `workflow-remove-setup-${id}`), next.cx);
  assert.deepEqual(savedSetups(), []); assert.equal(next.v.form.title.value(), 'Keep draft');
  assert.equal(fake.execs.length, 0); next.v.close();
});

test('invalid stored setups and invalid check commands are not applied or saved', async () => {
  fake.stored[SETUPS_KEY] = { version: 1, items: [{ ...preset(), maxRounds: 90 }, null] };
  const { v, cx } = await setup();
  assert.deepEqual(savedSetups(), []);
  v.form.root.set_value('/work/app'); v.executor = 'build'; v.reviewer = 'review'; v.form.setupName.set_value('Check');
  v.checkPreset = 'custom'; v.form.checks.set_value('not JSON'); v.saveSetup(cx);
  assert.match(v.setupError, /Fix the custom checks/); assert.deepEqual(savedSetups(), []);
  assert.equal(fake.execs.length, 0); v.close();
});
