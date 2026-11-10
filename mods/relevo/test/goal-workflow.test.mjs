import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, flush, find, click, text } from './fake/ui.mjs';
import { reviewableWork, scopeGoals } from '../lib/goal-workflow.js';
import { projectGoalPlan } from '../lib/goal-plan.js';
const { Inbox } = await import('../inbox.js');
const { InboxButton } = await import('../toolbar.js');
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
  assert.match(text(tree), /1 need attention elsewhere/);
  assert.doesNotMatch(text(tree), /2 other items/);
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

test('the single Edit action opens saved run context without accepting work', async () => {
  const { v, cx } = await inbox(); const doc = JSON.stringify(v.goalDoc), before = fake.execs.length;
  click(find(v.render(cx), 'goal-edit-g'), cx);
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

test('no available diff offers agent planning instead of a dead review button; Edit remains available', async () => {
  const { v, cx } = await inbox(); delete v.clones[pr.repo]; const tree = v.render(cx);
  assert.equal(find(tree, 'goal-review-next-g'), null);
  assert.equal(text(find(tree, 'goal-workflow-g')), 'Plan agent work');
  const edit = find(tree, 'goal-edit-g');
  assert.equal(edit.isDisabled, false);
  click(edit, cx);
  assert.equal(fake.overlays.at(-1).props.goalId, 'g');
});

test('workflow projection retains progress and duplicate diagnostics while the queue card stays compact', async () => {
  const { v, cx } = await inbox();
  const goal = v.goalDoc.goals[0];
  goal.criteria = 'Expected behavior';
  goal.steps = [
    { id: 's1', title: 'Implement search', state: 'todo' },
    { id: 's2', title: 'Handle errors', state: 'working' },
    { id: 's3', title: 'Keep keyboard access', state: 'done' },
  ];
  const task = (id, stepId, title, state) => ({ id, goalId: goal.id, title, goalStep: { id: stepId, title, criteria: goal.criteria }, state });
  v.workflowTasks = [
    task('accepted', 's1', 'Implement search', 'accepted'),
    task('failed', 's2', 'Handle errors', 'failed'),
    task('duplicate-a', 's3', 'Keep keyboard access', 'ready'),
    task('duplicate-b', 's3', 'Keep keyboard access', 'running'),
    { ...task('stale', 's1', 'Old title', 'accepted') },
  ];
  const before = JSON.stringify(v.goalDoc);
  const plan = projectGoalPlan(goal, v.workflowTasks);
  assert.equal(plan.filter((row) => row.state === 'done').length, 2);
  assert.equal(plan.filter((row) => row.state === 'blocked').length, 1);
  assert.match(plan[2].issue, /Multiple active workflow tasks/);
  const card = text(find(v.render(cx), 'goal-g'));
  const tree = v.render(cx), actionRow = find(tree, 'goal-next-row-g'), copy = find(tree, 'goal-next-copy-g');
  const status = copy.items[0], detail = copy.items[1];
  assert.equal(actionRow.kind, 'h_flex');
  assert.equal(copy.kind, 'v_flex');
  assert.equal(copy.items.length, 2);
  assert.equal(status.key, 'goal-next-status-g');
  assert.equal(status.tip, text(status));
  assert.equal(detail.key, 'goal-next-detail-g');
  assert.equal(detail.tip, text(detail));
  assert.ok(actionRow.items.some((child) => child.key === 'goal-next-copy-g'));
  assert.ok(actionRow.items.some((child) => child.key === 'goal-workflow-g'));
  assert.match(card, /Needs attention|Status unavailable/);
  assert.match(card, /Plan agent work|Resolve blocker/);
  assert.doesNotMatch(card, /2\/3 complete|need attention|3 open tasks|Accepted in Workflow|Blocked · Handle errors|Validated by you|Multiple active workflow tasks|Outcomes/);
  assert.equal(JSON.stringify(v.goalDoc), before);
});

test('Run card uses live blocker state and keeps saved acceptance details in Edit', async () => {
  const { v, cx } = await inbox();
  const goal = v.goalDoc.goals[0]; goal.decision = 'Accept the old result'; goal.recommendation = 'Old recommendation';
  v.workflowTasks = [
    { id: 'accepted', goalId: 'g', title: 'Old work', state: 'accepted' },
    { id: 'blocked', goalId: 'g', title: 'Repair handoff', state: 'blocked', paused: true },
  ];
  const before = JSON.stringify(v.goalDoc);
  const tree = v.render(cx), card = find(tree, 'goal-g');
  assert.match(text(card), /Needs attention/);
  assert.match(text(card), /Repair handoff/);
  assert.doesNotMatch(text(card), /Accept the old result|Old recommendation/);
  assert.equal(text(find(card, 'goal-workflow-g')), 'Resolve blocker');
  v.sel = 'goal-g'; const sent = fake.execs.length;
  v.navKey({ key: 'enter' }, cx);
  assert.equal(fake.overlays.at(-1).props.role, 'workflow');
  assert.equal(fake.execs.length, sent);
  click(find(tree, 'goal-edit-g'), cx);
  assert.equal(fake.overlays.at(-1).props.goalId, 'g');
  assert.equal(v.goalDoc.goals[0].decision, 'Accept the old result');
  assert.equal(JSON.stringify(v.goalDoc), before);
});

test('unavailable workflow state never renders stale results as actionable acceptance', async () => {
  const { v, cx } = await inbox();
  v.workflowTasks = [{ id: 'old', goalId: 'g', title: 'Old result', state: 'needs_you' }];
  v.workflowError = 'Cannot read state';
  const card = find(v.render(cx), 'goal-g');
  assert.match(text(card), /Status unavailable/);
  assert.doesNotMatch(text(card), /Ready for your review|Old result/);
  assert.equal(text(find(card, 'goal-workflow-g')), 'Open run');
});

test('paused work and pending review have distinct actions; the topbar switches Runs and Reviews', async () => {
  const { v, cx } = await inbox();
  const data = JSON.stringify(v.goalDoc);
  v.workflowTasks = [{ id: 'task', goalId: 'g', title: 'Implement search', state: 'running', paused: true }];
  v.workflowEngine = { enabled: false };
  let tree = v.render(cx);
  assert.match(text(find(tree, 'goal-g')), /Automation paused/);
  assert.equal(text(find(tree, 'goal-workflow-g')), 'Continue work');
  v.workflowTasks[0].state = 'needs_you';
  tree = v.render(cx);
  assert.equal(text(find(tree, 'goal-workflow-g')), 'Review result');
  assert.equal(fake.stored[GOAL_MODE], true, 'opening a queue action keeps the Runs mode');
  assert.equal(JSON.stringify(v.goalDoc), data, 'opening a queue action preserves run data');

  fake.layout = { id: 'root', children: [
    { id: 'panel', hidden: false }, { id: 'panel-body', active: 'inbox' }, { id: 'panel-bar', hidden: true },
  ] };
  const bar = new InboxButton();
  const tabs = bar.render();
  assert.match(text(find(tabs, 'reviews-toggle')), /^Reviews/);
  assert.equal(text(find(tabs, 'runs-toggle')), 'Runs');
  click(find(tabs, 'reviews-toggle'), cx);
  assert.equal(fake.stored[GOAL_MODE], false);
  assert.equal(JSON.stringify(v.goalDoc), data);
});
