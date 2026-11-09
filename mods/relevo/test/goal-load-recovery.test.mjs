import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, flush, find, click, text } from './fake/ui.mjs';
const { GoalEditor } = await import('../goals-editor.js');
const { newGoal, emptyGoals, saveGoal } = await import('../lib/goals.js');
const { goalsPath } = await import('../goals-store.js');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const doc = () => saveGoal(emptyGoals(), newGoal('original', 'Original goal'), 0);
const start = async () => { const view = new GoalEditor(), cx = fakeCx(); view.init({}, cx); await flush(); return { view, cx }; };
beforeEach(resetFake);

test('failed context read offers an explicit read-only retry, without automatic attempts', async () => {
  let reads = 0, writes = 0; fake.read = () => { reads++; throw Error('Synthetic read unavailable'); }; fake.write = () => { writes++; };
  const { view, cx } = await start(); const tree = view.render();
  const retry = find(tree, 'goal-retry-load'); assert.ok(retry); assert.equal(retry.kind, 'button'); assert.equal(retry.isDisabled, false);
  assert.match(text(tree), /saved goals have not been changed/); assert.match(view.error, /Synthetic read unavailable/);
  view.render(); await flush(); assert.equal(reads, 1); assert.equal(writes, 0); assert.deepEqual(fake.execs, []); assert.deepEqual(fake.closedOverlays, []);
  assert.equal(find(tree, 'goal-save').isDisabled, true); assert.equal(find(tree, 'goal-cancel').isDisabled, false);
  const notified = cx.notified; click(retry, cx); await flush(); assert.equal(reads, 2); assert.equal(writes, 0); assert.ok(cx.notified > notified); view.close();
});

test('retry recovers loaded fields and hides stale errors without writing the goal', async () => {
  fake.props = { goalId: 'original' }; fake.read = () => { throw Error('Synthetic temporary read failure'); };
  const { view, cx } = await start(); let reads = 0, writes = 0;
  fake.read = () => { reads++; return JSON.stringify(doc()); }; fake.write = () => { writes++; };
  click(find(view.render(), 'goal-retry-load'), cx); await flush();
  assert.equal(reads, 1); assert.equal(writes, 0); assert.equal(view.fields.title.value(), 'Original goal'); assert.equal(view.version, 1);
  assert.equal(find(view.render(), 'goal-retry-load'), null); assert.equal(find(view.render(), 'goal-save-error'), null); assert.equal(find(view.render(), 'goal-save').isDisabled, false); view.close();
});

test('a pending retry cannot be duplicated and keeps Save disabled', async () => {
  fake.read = () => { throw Error('Synthetic first failure'); }; const { view, cx } = await start();
  const pending = deferred(); let reads = 0; fake.read = () => { reads++; return pending.promise; };
  const retry = find(view.render(), 'goal-retry-load'); click(retry, cx); click(retry, cx); await flush();
  assert.equal(reads, 1); assert.ok(find(view.render(), 'goal-loading')); assert.equal(find(view.render(), 'goal-retry-load'), null);
  assert.equal(find(view.render(), 'goal-save').isDisabled, true); view.save(cx); assert.deepEqual(fake.files, {});
  pending.resolve(null); await flush(); assert.ok(view.goal); view.close();
});

test('initial load and subsequent retry retain the original goal identity', async () => {
  const pending = deferred(); fake.props = { goalId: 'original' }; fake.read = () => pending.promise;
  const { view } = await start(); fake.props.goalId = 'different'; pending.resolve(JSON.stringify(doc())); await flush();
  assert.equal(view.goal?.id, 'original'); view.close();
  fake.props = { goalId: 'original' }; fake.read = () => { throw Error('Synthetic retry failure'); };
  const again = await start(); fake.props.goalId = 'different'; fake.read = () => JSON.stringify(doc());
  click(find(again.view.render(), 'goal-retry-load'), again.cx); await flush(); assert.equal(again.view.goal.id, 'original'); again.view.close();
});

test('a new goal retains the originally linked source across a pending read', async () => {
  const pending = deferred(); fake.props = { source: { key: 'pr:https://example.com/pull/1' } }; fake.read = () => pending.promise;
  const { view } = await start(); fake.props.source.key = 'pr:https://example.com/pull/2'; pending.resolve(null); await flush();
  assert.deepEqual(view.goal.sources, ['pr:https://example.com/pull/1']); view.close();
});

test('dismissed retries never touch released fields, notify or start another read', async () => {
  fake.read = () => { throw Error('Synthetic first failure'); }; const { view, cx } = await start();
  const pending = deferred(); let reads = 0; fake.read = () => { reads++; return pending.promise; };
  const retry = find(view.render(), 'goal-retry-load'); click(retry, cx); await flush(); view.close();
  const notified = cx.notified; for (const field of Object.values(view.fields)) field.set_value = () => assert.fail('disposed field');
  pending.resolve(null); await flush(); click(retry, cx); await flush();
  assert.equal(reads, 1); assert.equal(cx.notified, notified); assert.deepEqual(fake.closedOverlays, []);
});

test('loaded drafts cannot be replaced by a stale retry handler or direct load', async () => {
  fake.read = () => { throw Error('Synthetic initial failure'); }; const { view, cx } = await start();
  const retry = find(view.render(), 'goal-retry-load'); fake.read = () => null; click(retry, cx); await flush();
  view.fields.title.set_value('Keep my draft'); view.fields.owner.set_value('Draft owner'); const goal = view.goal; let reads = 0;
  fake.read = () => { reads++; return null; }; click(retry, cx); view.load(cx); await flush();
  assert.equal(reads, 0); assert.equal(view.goal, goal); assert.equal(view.fields.title.value(), 'Keep my draft'); assert.equal(view.fields.owner.value(), 'Draft owner'); assert.equal(fake.files[goalsPath()], undefined); view.close();
});

test('retry never replaces a malformed goal file with an empty document', async () => {
  const raw = '{"version":99}'; fake.files[goalsPath()] = raw; let writes = 0; fake.write = () => { writes++; };
  const { view, cx } = await start(); assert.match(view.error, /Invalid/);
  click(find(view.render(), 'goal-retry-load'), cx); await flush();
  assert.equal(fake.files[goalsPath()], raw); assert.equal(writes, 0); assert.equal(view.goal, undefined); assert.equal(find(view.render(), 'goal-save').isDisabled, true); assert.ok(find(view.render(), 'goal-retry-load')); view.close();
});
