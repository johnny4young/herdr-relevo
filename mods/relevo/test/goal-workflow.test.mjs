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

test('F opens the selected run in the panel and the back link restores the complete keyboard queue', async () => {
  const { v, cx } = await inbox(); const before = v.nav.map((n) => n.id), doc = JSON.stringify(v.goalDoc);
  v.sel = 'goal-g'; v.goalAction('f', cx); let tree = v.render(cx);
  assert.equal(fake.stored[GOAL_SCOPE], 'g'); assert.equal(v.goalProjection.outsideBlockers, 1);
  assert.deepEqual(v.nav.map((n) => n.id), [], 'a run without tasks has no rows to walk');
  assert.equal(text(find(tree, 'run-title')), 'Ship search');
  assert.match(text(tree), /1 need attention elsewhere/);
  assert.doesNotMatch(text(tree), /2 other items/);
  assert.equal(find(tree, 'goal-g'), null); assert.equal(find(tree, `source-pr:${pr.url}2`), null);
  click(find(tree, 'runs-back'), cx); tree = v.render(cx);
  assert.equal(fake.stored[GOAL_SCOPE], null); assert.equal(v.sel, 'goal-g');
  assert.deepEqual(v.nav.map((n) => n.id), before); assert.equal(find(tree, `source-pr:${pr.url}2`), null);
  assert.equal(JSON.stringify(v.goalDoc), doc);
});

test('run review switches to its existing Reviews card without launching work or changing data', async () => {
  const { v, cx } = await inbox(); const doc = JSON.stringify(v.goalDoc), calls = [];
  v.reviewPR = (p) => calls.push(p); const before = fake.execs.length;
  const tree = v.render(cx);
  assert.equal(text(find(tree, 'goal-now-g')), 'Now 1 linked change to review');
  click(find(tree, 'goal-action-g'), cx);
  assert.equal(fake.stored[GOAL_MODE], false);
  assert.equal(v.sel, `pr-${pr.url}`);
  assert.ok(find(v.render(cx), `pr-${pr.url}`));
  assert.deepEqual(calls, []); assert.equal(fake.execs.length, before);
  assert.equal(JSON.stringify(v.goalDoc), doc);
});

test('the single Edit action opens saved run context without accepting work', async () => {
  const { v, cx } = await inbox(); const doc = JSON.stringify(v.goalDoc), before = fake.execs.length;
  assert.equal(find(v.render(cx), 'goal-edit-g'), null, 'a row shows its one action until it is selected');
  v.sel = 'goal-g';
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
  const { v, cx } = await inbox(); delete v.clones[pr.repo]; v.sel = 'goal-g'; const tree = v.render(cx);
  assert.equal(text(find(tree, 'goal-now-g')), 'Now needs a plan before agents start');
  assert.equal(text(find(tree, 'goal-action-g')), 'Plan');
  click(find(tree, 'goal-action-g'), cx);
  assert.deepEqual(fake.runs.findLast(([name]) => name === 'pane.split')[1].props, { role: 'workflow', goalId: 'g' }, 'planning stays in the run window');
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
  const tree = v.render(cx), card = text(find(tree, 'goal-g'));
  const now = find(tree, 'goal-now-g'), shipped = find(tree, 'goal-shipped-g');
  assert.equal(text(now), 'Now stuck: "Handle errors" could not finish');
  assert.equal(now.items[1].tip, 'stuck: "Handle errors" could not finish', 'a cut line reads whole in its tooltip');
  assert.equal(text(shipped), 'Shipped 1 pull request open: #1');
  assert.equal(text(find(tree, 'goal-action-g')), 'See why');
  assert.equal(text(find(tree, 'runs-leg-me')), 'NEEDS ME 1');
  assert.doesNotMatch(card, /2\/3 complete|need attention|3 open tasks|Accepted in Workflow| · Handle errors|Validated by you|Multiple active workflow tasks|Outcomes/);
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
  assert.match(text(card), /stuck: "Repair handoff" could not finish/);
  assert.doesNotMatch(text(card), /Accept the old result|Old recommendation/);
  assert.equal(text(find(card, 'goal-action-g')), 'See why');
  v.sel = 'goal-g'; const sent = fake.execs.length;
  v.navKey({ key: 'enter' }, cx);
  assert.equal(fake.stored[GOAL_SCOPE], 'g', 'Enter opens the run in the panel');
  assert.equal(fake.runs.some(([name]) => name === 'pane.split'), false, 'not in the run window');
  assert.equal(fake.execs.length, sent);
  const run = v.render(cx);
  assert.equal(v.sel, 'task-blocked');
  assert.match(text(find(run, 'task-blocked')), /Repair handoff could not finish, no attempts left|Repair handoff could not finish/);
  click(find(run, 'goal-edit-g'), cx);
  assert.equal(fake.overlays.at(-1).props.goalId, 'g');
  assert.equal(v.goalDoc.goals[0].decision, 'Accept the old result');
  assert.equal(JSON.stringify(v.goalDoc), before);
});

test('unavailable workflow state never renders stale results as actionable acceptance', async () => {
  const { v, cx } = await inbox();
  v.workflowTasks = [{ id: 'old', goalId: 'g', title: 'Old result', state: 'needs_you' }];
  v.workflowError = 'Cannot read state';
  const card = find(v.render(cx), 'goal-g');
  assert.match(text(card), /status unavailable/);
  assert.doesNotMatch(text(card), /Needs me|Old result|Review 1/);
  assert.equal(text(find(card, 'goal-action-g')), 'Open');
  v.runTask = 'old'; click(find(card, 'goal-action-g'), cx);
  const run = v.render(cx);
  assert.equal(find(run, 'task-old'), null); assert.equal(find(run, 'task-accept'), null);
  assert.match(text(run), /Cannot read state/);
});

test('paused work and pending review have distinct actions; the topbar switches Runs and Reviews', async () => {
  const { v, cx } = await inbox();
  const data = JSON.stringify(v.goalDoc);
  v.workflowTasks = [{ id: 'task', goalId: 'g', title: 'Implement search', state: 'running', paused: true }];
  v.workflowEngine = { enabled: false };
  let tree = v.render(cx);
  assert.match(text(find(tree, 'goal-g')), /paused: "Implement search" waits to resume/);
  assert.equal(text(find(tree, 'runs-leg-flight')), 'IN FLIGHT 1');
  assert.equal(find(tree, 'goal-action-g'), null, 'a run in flight offers nothing until it is selected');
  v.workflowTasks = [{ ...v.workflowTasks[0], state: 'needs_you' }];
  tree = v.render(cx);
  assert.equal(text(find(tree, 'goal-action-g')), 'Review 1');
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

test('Runs contains only run navigation; Reviews receives each ready result and preserves existing PRs', async () => {
  const { v, cx } = await inbox();
  v.workflowTasks = [
    { id: 'first', goalId: 'g', title: 'First result', state: 'needs_you' },
    { id: 'second', goalId: 'g', title: 'Second result', state: 'needs_you' },
    { id: 'working', goalId: 'g', title: 'Working task', state: 'running' },
  ];
  const saved = JSON.stringify(v.goalDoc), tasks = JSON.stringify(v.workflowTasks);
  const before = fake.execs.length;
  let tree = v.render(cx);
  assert.deepEqual(v.nav.map((entry) => entry.id), ['goal-g']);
  assert.equal(find(tree, `pr-${pr.url}`), null);
  assert.equal(find(tree, 'result-first'), null);
  click(find(tree, 'goal-action-g'), cx); tree = v.render(cx);
  assert.equal(fake.stored[GOAL_MODE], true, 'Review opens the run in the panel');
  assert.deepEqual(v.nav.map((entry) => entry.id), ['task-first', 'task-second', 'task-working']);
  assert.equal(v.sel, 'task-first');
  fake.stored[GOAL_MODE] = false; fake.stored[GOAL_SCOPE] = null; v.sel = 'result-first';
  tree = v.render(cx);
  assert.ok(find(tree, 'result-first')); assert.ok(find(tree, 'result-second'));
  assert.equal(find(tree, 'result-working'), null);
  assert.equal(text(find(tree, 'leg-me')), 'NEEDS ME 2');
  assert.equal(find(tree, `pr-${pr.url}`), null, 'a quiet PR waits on others, folded');
  click(find(tree, 'now-open'), cx); tree = v.render(cx);
  assert.ok(find(tree, `pr-${pr.url}`));
  assert.equal(v.sel, 'result-first');
  assert.equal(find(tree, 'goal-g'), null);
  const count = fake.stored['relevo.inbox.count'];
  v.sel = 'result-second'; v.navKey({ key: 'enter' }, cx);
  assert.equal(fake.runs.some(([name]) => name === 'pane.split'), false, 'a result opens in the panel, not in the run window');
  assert.deepEqual([fake.stored[GOAL_MODE], fake.stored[GOAL_SCOPE], v.runTask], [true, 'g', 'second']);
  assert.equal(text(find(v.render(cx), 'task-title')), 'Second result');
  fake.stored[GOAL_MODE] = false;
  assert.equal(fake.execs.length, before);
  assert.equal(JSON.stringify(v.goalDoc), saved);
  assert.equal(JSON.stringify(v.workflowTasks), tasks);
  v.workflowTasks = v.workflowTasks.map((task) => (task.id === 'second' ? { ...task, state: 'accepted' } : task));
  tree = v.render(cx);
  assert.equal(find(tree, 'result-second'), null);
  assert.equal(fake.stored['relevo.inbox.count'], count - 1);
  fake.stored[GOAL_MODE] = true;
  tree = v.render(cx);
  assert.equal(text(find(tree, 'task-leg-you')), 'You accepted it'); assert.equal(find(tree, 'task-accept'), null);
  click(find(tree, 'task-back'), cx); tree = v.render(cx);
  assert.equal(text(find(tree, 'run-rest-fold')), '0 not started · 1 done', 'accepted results remain in the run');
  click(find(tree, 'runs-back'), cx);
  assert.ok(find(v.render(cx), 'goal-g'));
});

test('manual decisions stay actionable in Reviews and unreadable workflow hides stale results', async () => {
  const { v, cx } = await inbox();
  v.goalDoc.goals[0].decision = 'Choose the final approach';
  v.workflowTasks = [{ id: 'old', goalId: 'g', title: 'Stale task', state: 'needs_you' }];
  v.workflowError = 'Workflow status unavailable';
  fake.stored[GOAL_MODE] = false;
  const tree = v.render(cx);
  assert.equal(find(tree, 'result-old'), null);
  assert.match(text(tree), /Workflow status unavailable/);
  click(find(tree, 'open-decision-g'), cx);
  assert.equal(fake.overlays.at(-1).props.goalId, 'g');
  assert.equal(fake.overlays.at(-1).props.panel, 'decision');
});

test('Reviews refreshes workflow metadata without switching to Runs', async () => {
  const { v, cx } = await inbox(); fake.stored[GOAL_MODE] = false;
  fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({
    tasks: [{ id: 'fresh', goalId: 'g', title: 'New result', state: 'needs_you' }], engine: { enabled: false },
  });
  cx.fire(5000); await flush();
  assert.ok(find(v.render(cx), 'result-fresh'));
  assert.equal(fake.stored[GOAL_MODE], false);
});

test('linked PRs outside the ordinary queue remain reachable once in Reviews, including addressed Undo', async () => {
  const { v, cx } = await inbox();
  v.mine = []; v.openPRs = [{ ...pr, headRefOid: 'head-1' }];
  fake.stored[GOAL_MODE] = false; v.sel = `pr-${pr.url}`;
  let tree = v.render(cx);
  assert.ok(find(tree, `pr-${pr.url}`));
  assert.ok(find(tree, `source-link-pr:${pr.url}`));
  assert.equal(v.nav.filter((entry) => entry.id === `pr-${pr.url}`).length, 1);
  v.mine = [pr]; v.expanded['now-open'] = true; tree = v.render(cx);
  assert.equal(v.linkedReviews(v.shown()).length, 0, 'ordinary queue entry owns the PR');
  assert.equal(find(tree, 'leg-me'), null, 'without the link it no longer needs you');
  assert.ok(find(tree, `pr-${pr.url}`));
  assert.equal(v.nav.filter((entry) => entry.id === `pr-${pr.url}`).length, 1);
});
