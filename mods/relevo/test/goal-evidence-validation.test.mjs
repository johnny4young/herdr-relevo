import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, flush, find } from './fake/ui.mjs';
const { GoalEditor } = await import('../goals-editor.js');
const { goalsPath, readGoals } = await import('../goals-store.js');
const key = 'pr:https://github.com/acme/app/pull/1', revision = 'a'.repeat(40);
const source = () => ({ key, revision, title: 'Synthetic PR' });
beforeEach(resetFake);
async function editor(context = source()) {
  fake.props = { source: context, overlay: 'own-editor' };
  const e = new GoalEditor(), cx = fakeCx(); e.init({}, cx); await flush();
  e.fields.title.set_value('Keep the draft'); e.fields.owner.set_value('Owner');
  e.fields.criteria.set_value('Preserved acceptance criteria'); e.panel = 'plan';
  return { e, cx };
}
function forbidIO() {
  fake.read = () => assert.fail('invalid evidence must not read goal metadata');
  fake.write = () => assert.fail('invalid evidence must not write');
  fake.exec = () => assert.fail('invalid evidence must not query GitHub');
}

test('invalid evidence URL returns to Decision and focuses the retained link without I/O', async () => {
  const { e, cx } = await editor(); e.link.set_value('http://example.com/demo'); forbidIO();
  let focus = 0; e.link.focus = () => { focus++; };
  e.save(cx); await flush();
  assert.equal(e.panel, 'decision'); assert.match(e.error, /Enter an HTTPS evidence URL/);
  assert.equal(e.busy, false); assert.equal(e.fields.owner.value(), 'Owner');
  assert.equal(e.fields.criteria.value(), 'Preserved acceptance criteria'); assert.equal(e.link.value(), 'http://example.com/demo');
  assert.ok(find(e.render(), 'goal-field-evidence')); cx.timers.at(-1).fn(cx); assert.equal(focus, 1);
  assert.deepEqual(fake.execs, []); assert.deepEqual(fake.closedOverlays, []); e.close();
});

test('missing or malformed commit context fails before lookup and preserves a way to clear the URL', async () => {
  for (const context of [null, { title: 'No key' }, { key, revision: 'unknown' }, { key: 'local:t1', revision }]) {
    resetFake(); const { e, cx } = await editor(context); e.link.set_value('https://example.com/demo'); forbidIO();
    e.save(cx); await flush();
    assert.match(e.error, /Open this goal from a PR with a known commit/); assert.equal(e.panel, 'decision');
    assert.ok(find(e.render(), 'goal-field-evidence')); assert.deepEqual(fake.execs, []); assert.equal(e.busy, false); e.close();
  }
});

test('unlinked PR evidence fails early instead of querying and then rejecting the entire draft', async () => {
  const { e, cx } = await editor(); e.goal.sources = []; e.link.set_value('https://example.com/demo'); forbidIO();
  e.save(cx); await flush(); assert.match(e.error, /Link this PR to the goal/);
  assert.equal(e.panel, 'decision'); assert.deepEqual(fake.execs, []); assert.deepEqual(fake.files, {}); e.close();
});

test('evidence limit explains how to save other edits without an extra lookup', async () => {
  const { e, cx } = await editor(); e.goal.evidence = Array.from({ length: 20 }, () => ({ source: key, revision, kind: 'screenshot', url: 'https://example.com/existing', label: 'Screenshot' }));
  e.link.set_value('https://example.com/new'); forbidIO(); e.save(cx); await flush();
  assert.match(e.error, /already has 20 evidence links/); assert.match(e.error, /Clear this URL/);
  assert.deepEqual(fake.execs, []); assert.equal(e.goal.evidence.length, 20); e.close();
});

test('late evidence validation focus does not touch a dismissed editor', async () => {
  const { e, cx } = await editor(); e.link.set_value('not-a-link'); e.save(cx);
  let focus = 0; e.link.focus = () => { focus++; }; const timer = cx.timers.at(-1);
  e.close(); timer.fn(cx); assert.equal(focus, 0); assert.deepEqual(fake.execs, []);
});

test('correcting the URL preserves the draft and still verifies the exact commit before saving', async () => {
  const { e, cx } = await editor(); e.link.set_value('bad-link'); e.save(cx); await flush();
  e.link.set_value('https://example.com/demo'); fake.exec = () => ({ stdout: JSON.stringify({ headRefOid: revision }) });
  e.save(cx); await flush(); const saved = (await readGoals()).doc.goals[0];
  assert.equal(fake.execs.length, 1); assert.match(fake.execs[0], /gh pr view/);
  assert.equal(saved.owner, 'Owner'); assert.equal(saved.criteria, 'Preserved acceptance criteria');
  assert.equal(saved.evidence[0].revision, revision); assert.equal(saved.evidence[0].url, 'https://example.com/demo');
  assert.deepEqual(fake.closedOverlays, ['own-editor']); e.close();
});

test('changed PR revision remains a hard stop with no metadata write', async () => {
  const { e, cx } = await editor(); e.link.set_value('https://example.com/demo');
  fake.exec = () => ({ stdout: JSON.stringify({ headRefOid: 'b'.repeat(40) }) }); e.save(cx); await flush();
  assert.match(e.error, /PR changed/); assert.equal(fake.files[goalsPath()], undefined);
  assert.deepEqual(fake.closedOverlays, []); assert.equal(e.link.value(), 'https://example.com/demo'); e.close();
});
