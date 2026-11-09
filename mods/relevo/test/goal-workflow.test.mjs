import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, flush, find, click } from './fake/ui.mjs';
import { reviewableWork, scopeGoals } from '../lib/goal-workflow.js';
const { Inbox } = await import('../inbox.js');
const { GOAL_MODE, GOAL_SCOPE } = await import('../inbox-goals.js');
import { newGoal, saveGoal, emptyGoals } from '../lib/goals.js';

beforeEach(resetFake);
const pr = { url: 'https://github.com/acme/app/pull/1', number: 1, repo: 'acme/app', title: 'Search', reasons: [], skills: ['review'], updatedAt: new Date().toISOString() };
async function inbox() {
  const v = new Inbox(), cx = fakeCx(); v.init({}, cx); await flush();
  v.mine = [pr, { ...pr, url: `${pr.url}2`, number: 12, hot: true }];
  v.clones[pr.repo] = '/work/app';
  v.goalDoc = saveGoal(emptyGoals(), newGoal('g', 'Ship search', [`pr:${pr.url}`]), 0);
  fake.stored[GOAL_MODE] = true; v.h.is_focused = () => true; v.render(cx);
  return { v, cx };
}

test('focused projection retains evidence sources and counts only outside unresolved blockers', () => {
  const a = { key: 'a' }, b = { key: 'b', blocked: true }, c = { key: 'c', blocked: true, addressed: true };
  const g = { goal: { id: 'g' }, items: [a] }, projection = { sources: [a, b, c], groups: [g], unlinked: [b, c] };
  const focused = scopeGoals(projection, 'g');
  assert.deepEqual(focused.groups, [g]); assert.deepEqual(focused.unlinked, []);
  assert.equal(focused.sources, projection.sources);
  assert.equal(focused.outsideCount, 2); assert.equal(focused.outsideBlockers, 1);
  assert.deepEqual(projection.unlinked, [b, c]);
});

test('deleted or unavailable focus safely restores the complete projection', () => {
  const projection = { sources: [{ key: 'a' }], groups: [], unlinked: [{ key: 'a' }] };
  for (const id of [null, 'deleted']) {
    const result = scopeGoals(projection, id);
    assert.equal(result.scope, null); assert.equal(result.sources, projection.sources);
    assert.equal(result.unlinked, projection.unlinked);
  }
});

test('review readiness excludes drafts, addressed work, missing clones and blocked prompts', () => {
  const linked = { kind: 'pr', pr }, local = { kind: 'local', item: { kind: 'diff', top: '/work/app' } };
  assert.deepEqual(reviewableWork([linked, local, { ...linked, draft: true }, { ...local, addressed: true },
    { kind: 'local', item: { kind: 'blocked' } }, { kind: 'pr', pr: { repo: 'missing/repo' } }], { [pr.repo]: '/work/app' }), [linked, local]);
});

test('Focus and All work preserve work and restore the complete keyboard queue', async () => {
  const { v, cx } = await inbox(); const before = v.nav.map((n) => n.id), doc = JSON.stringify(v.goalDoc);
  click(find(v.render(cx), 'goal-focus-view-g'), cx); let tree = v.render(cx);
  assert.equal(fake.stored[GOAL_SCOPE], 'g'); assert.equal(v.goalProjection.outsideBlockers, 1);
  assert.deepEqual(v.nav.map((n) => n.id), ['goal-g', `pr-${pr.url}`]);
  assert.ok(find(tree, 'goal-all-work')); assert.equal(find(tree, `source-pr:${pr.url}2`), null);
  click(find(tree, 'goal-all-work'), cx); tree = v.render(cx);
  assert.deepEqual(v.nav.map((n) => n.id), before); assert.ok(find(tree, `source-pr:${pr.url}2`));
  assert.equal(JSON.stringify(v.goalDoc), doc);
});

test('goal review opens the existing review route without launching a skill or changing goal state', async () => {
  const { v, cx } = await inbox(); const doc = JSON.stringify(v.goalDoc), calls = [];
  v.reviewPR = (p) => calls.push(p); const before = fake.execs.length;
  click(find(v.render(cx), 'goal-review-next-g'), cx);
  v.sel = 'goal-g'; v.navKey({ key: 'r' }, cx);
  assert.deepEqual(calls, [pr, pr]); assert.equal(fake.execs.length, before);
  assert.equal(JSON.stringify(v.goalDoc), doc);
});

test('recording a decision opens the editor without accepting work', async () => {
  const { v, cx } = await inbox(); const doc = JSON.stringify(v.goalDoc), before = fake.execs.length;
  click(find(v.render(cx), 'goal-record-g'), cx);
  assert.equal(fake.overlays.at(-1).props.goalId, 'g');
  assert.equal(JSON.stringify(v.goalDoc), doc); assert.equal(fake.execs.length, before);
});

test('focus shortcut respects descendant text focus and can exit from a linked card', async () => {
  const { v, cx } = await inbox(); v.sel = 'goal-g'; v.h.is_focused = () => false;
  v.navKey({ key: 'f' }, cx); assert.equal(fake.stored[GOAL_SCOPE], undefined);
  v.h.is_focused = () => true; v.navKey({ key: 'f' }, cx); v.render(cx);
  assert.equal(fake.stored[GOAL_SCOPE], 'g'); v.sel = `pr-${pr.url}`;
  v.navKey({ key: 'f' }, cx); v.render(cx); assert.equal(v.goalProjection.scope, null);
});

test('no available diff keeps goal review disabled while decision context remains available', async () => {
  const { v, cx } = await inbox(); delete v.clones[pr.repo]; const tree = v.render(cx);
  assert.equal(find(tree, 'goal-review-next-g').isDisabled, true);
  assert.equal(find(tree, 'goal-record-g').isDisabled, false);
});
