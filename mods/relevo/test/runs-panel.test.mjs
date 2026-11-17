import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake, calls, theme } from './fake/herdr.mjs';
import { fakeCx, flush, find, click, text } from './fake/ui.mjs';
import { newGoal, saveGoal, emptyGoals } from '../lib/goals.js';
import { runBucket, runRow, runShipped, runSummary, taskReason, taskTurn, taskLegs, stuckFindings, followUpAvailable } from '../lib/run-panel.js';
const { Inbox } = await import('../inbox.js');
const { Workflow } = await import('../workflow.js');
const { GOAL_MODE, GOAL_SCOPE } = await import('../inbox-goals.js');
const { goalsPath } = await import('../goals-store.js');
const { MERGED } = await import('../inbox-runs.js');

beforeEach(resetFake);
const t = theme();
const writer = { address: 'w1', label: 'Codex Luna' }, reviewer = { address: 'r1', label: 'Team Haiku' };
const wrote = (summary = 'Ready results sort ahead of failed ones.') => ({ id: 'a1', role: 'executor', state: 'reported', at: '2026-01-01T10:00:00Z', report: { status: 'completed', summary } });
const reviewed = (status = 'completed', extra = {}) => ({ id: 'a2', role: 'reviewer', state: 'reported', at: '2026-01-01T10:10:00Z', report: { status, summary: '', ...extra } });
const task = (id, state, more = {}) => ({ id, goalId: 'g', title: `Task ${id}`, state, root: '/work/app', executor: writer, reviewer, round: 1, maxRounds: 2, ...more });
const ready = (id, more = {}) => task(id, 'needs_you', { revision: `rev-${id}`, attempts: [wrote(), reviewed()], checks: [['npm', 'test']], checksResult: [{ code: 0 }], ...more });
const stuck = (id, more = {}) => task(id, 'blocked', { round: 2, attempts: [wrote(), reviewed('changes_requested'), { ...wrote(), id: 'a3' },
  reviewed('changes_requested', { summary: 'The nav row still overflows.', findings: [{ level: 'major', where: 'ui.js', issue: 'row is cut', fix: '' }] })], ...more });
const writing = (id) => task(id, 'running', { attempts: [{ id: 'a1', role: 'executor', state: 'running', at: '2026-01-01T10:00:00Z' }] });
const goal = newGoal('g', 'Direct work from one Inbox');

const STATE = '/home/test/.config/herdr-app/relevo-workflow/state.json';
const save = (tasks) => { fake.files[STATE] = JSON.stringify({ tasks, events: [], engine: { enabled: true } }); };
async function runs(tasks = [], goals = [goal]) {
  fake.files[goalsPath()] = JSON.stringify(goals.reduce((doc, g) => saveGoal(doc, g, 0), emptyGoals()));
  save(tasks);
  const v = new Inbox(), cx = fakeCx(); v.init({}, cx); await flush();
  fake.stored[GOAL_MODE] = true; v.h.is_focused = () => true; v.render(cx);
  return { v, cx };
}
// The coordinator's answer to a command: the new state, saved and returned.
const answers = (tasks) => { fake.exec = (cmd, args) => { if (!/cli\.mjs$/.test(args[0] ?? '')) return null; save(tasks); return { stdout: JSON.stringify({ doc: { tasks, engine: { enabled: true } } }) }; }; };
const decided = () => calls(/"action":"decide"/).map((line) => JSON.parse(line.slice(line.indexOf('{'))));
// The panes opened, without the stamp of a one-time ask.
const windows = () => fake.runs.filter(([name]) => name === 'pane.split').map(([, args]) => { const { at: _at, ...props } = args.props; return props; });
const asked = () => fake.runs.findLast(([name]) => name === 'pane.split')[1].props;

test('a run row says what it does now, by whose turn it is, with its one action', () => {
  const row = (tasks, options) => runRow(goal, runBucket(tasks, 'g'), { engine: { enabled: true }, ...options });
  assert.deepEqual(row([ready('a'), ready('b'), ready('c'), stuck('d'), writing('e')]),
    { group: 'me', turn: 'me', hot: true, now: '3 results wait for your review', action: { kind: 'review', label: 'Review 3' } });
  assert.deepEqual(row([stuck('d'), writing('e')]),
    { group: 'me', turn: 'stuck', hot: true, now: 'stuck: the reviewer rejected it twice', action: { kind: 'why', label: 'See why', taskId: 'd' } });
  assert.equal(row([task('f', 'failed', { error: 'Tests could not start: npm not found\nmore' })]).now, 'stuck: Tests could not start: npm not found');
  assert.deepEqual(row([writing('e'), task('p', 'planned')]), { group: 'flight', turn: 'flight', now: 'an agent is writing "Task e"', action: { kind: 'open', label: 'Open' } });
  assert.equal(row([task('q', 'needs_review', { attempts: [wrote()] })]).now, '"Task q" waits for its reviewer');
  assert.deepEqual(row([task('q', 'running', { paused: true })], { engine: { enabled: false } }).turn, 'open', 'paused work has no spinner');
  assert.equal(row([task('p', 'planned'), task('p2', 'planned')]).now, '2 tasks planned, not started');
  assert.deepEqual(row([task('x', 'accepted'), task('y', 'cancelled')]), { group: 'ready', turn: 'ready', now: 'finished, everything accepted', action: { kind: 'open', label: 'Open' } });
  assert.deepEqual(row([]), { group: 'open', turn: 'open', now: 'needs a plan before agents start', action: { kind: 'plan', label: 'Plan' } });
  assert.equal(row([], { decision: true }).action.kind, 'plan', 'no decision text, nothing to decide');
  assert.equal(runRow({ ...goal, decision: 'Ship it?' }, runBucket([], 'g'), { decision: true }).now, 'your decision: Ship it?');
  assert.deepEqual(row([ready('a')], { error: 'unreadable' }), { group: 'me', turn: 'stuck', now: 'status unavailable', hot: true, action: { kind: 'open', label: 'Open' } });
});

test('Shipped names what reached GitHub: merged, open and draft pull requests, or nothing yet', () => {
  const url = (n) => `https://github.com/acme/app/pull/${n}`;
  const linked = { ...goal, sources: [`pr:${url(38)}`, `pr:${url(43)}`, 'local:/work/app'] };
  assert.deepEqual(runShipped(goal, runBucket([ready('a')], 'g')), { any: false, text: 'nothing yet' });
  const tasks = [task('x', 'accepted', { worktree: { branch: 'run/x', pr: url(42) } }), task('y', 'accepted', { worktree: { branch: 'run/y', pr: url(44) } }),
    task('z', 'needs_you', { worktree: { branch: 'run/z', pr: url(50) } }), { ...task('o', 'accepted', { worktree: { pr: url(60) } }), goalId: 'other' }];
  const open = [{ kind: 'pr', pr: { url: url(43) } }, { kind: 'pr', draft: true, pr: { url: url(45) } }, { kind: 'local', item: {} }];
  assert.equal(runShipped(linked, runBucket(tasks, 'g'), open, { [url(38)]: true, [url(42)]: true }).text,
    '2 pull requests merged: #42, #38 · 1 pull request open: #43 · 1 draft pull request: #45 · 1 pull request opened: #44');
  assert.equal(runShipped(linked, runBucket([], 'g'), [], {}).text, 'nothing yet', 'a linked PR that is no longer open is not claimed as merged');
});

test('task words: turn, short state, summary line, who did what and why it is stuck', () => {
  assert.deepEqual([ready('a'), stuck('d'), writing('e'), task('p', 'planned'), task('r', 'ready'), task('x', 'accepted'), task('c', 'cancelled')].map(taskTurn),
    ['me', 'stuck', 'flight', 'open', 'open', 'done', 'done']);
  assert.equal(taskReason(ready('a')), 'reviewer approved');
  assert.equal(taskReason(ready('a', { round: 2 })), 'approved, 2nd attempt');
  assert.equal(taskReason(task('n', 'needs_you')), 'ready for your review');
  assert.equal(taskReason(stuck('d')), 'rejected twice, no attempts left');
  assert.equal(taskReason(stuck('d', { maxRounds: 3 })), 'rejected twice');
  assert.equal(taskReason(writing('e')), 'Codex Luna is writing it');
  assert.equal(taskReason(task('v', 'needs_review', { attempts: [wrote(), { id: 'a2', role: 'reviewer', state: 'running' }] })), 'Team Haiku is reviewing it');
  const slot = 'Waits for a free slot: 2 tasks run at once.';
  assert.equal(taskReason(task('q', 'ready', { waitsFor: slot })), 'waits for a free slot: 2 tasks run at once');
  assert.equal(taskReason(task('w', 'needs_review', { attempts: [wrote()], waitsFor: 'Waits for Team Haiku to be free.' })), 'waits for Team Haiku to be free');
  assert.equal(taskReason(task('q', 'ready', { waitsFor: slot, paused: true })), 'not started');
  const summary = runSummary(runBucket([ready('a'), ready('b'), ready('c'), stuck('d'), writing('e'), task('p', 'planned'), task('x', 'accepted'), task('y', 'accepted'), task('z', 'cancelled')], 'g'));
  assert.equal(`${summary.head} ${summary.parts.map((part) => part.text).join(' · ')}`, '9 tasks: 3 need you · 1 stuck · 1 in flight · 1 not started · 3 done');
  assert.deepEqual(summary.parts.map((part) => part.hot), [true, true, false, false, false]);
  assert.deepEqual(taskLegs(ready('a', { worktree: { branch: 'run/a' } })).map((leg) => `${leg.state} ${leg.who} ${leg.what}`), [
    'ok Codex Luna wrote it in its own worktree', 'ok Tests npm test passed', 'ok Team Haiku reviewed it: approved, no findings', 'you You accept it, or say what to change']);
  assert.deepEqual(taskLegs(writing('e')).map((leg) => leg.state), ['run', 'wait', 'wait', 'wait']);
  assert.equal(taskLegs(stuck('d')).at(-2).what, 'reviewed it: asked for changes, 1 finding');
  assert.deepEqual(stuckFindings(stuck('d')), ['The nav row still overflows.', '[major] ui.js: row is cut']);
  assert.deepEqual(stuckFindings(task('f', 'failed', { error: 'npm not found' })), ['npm not found']);
  assert.equal(followUpAvailable(stuck('d')), true);
  assert.equal(followUpAvailable(stuck('d', { maxRounds: 3 })), false, 'attempts are left');
  assert.equal(followUpAvailable(ready('a')), false);
});

test('Runs at a glance: header, legend, groups by turn, Now and Shipped, older runs and saved setups folded', async () => {
  const pr = 'https://github.com/acme/app/pull/38';
  const goals = [goal, newGoal('s', 'Ship the interface'), newGoal('f', 'Workflow test'), { ...newGoal('r', 'Status bar', [`pr:${pr}`]) }, newGoal('n', 'Lab smoke'),
    { ...newGoal('old', 'Old run'), state: 'completed' }];
  const of = (id, item) => ({ ...item, goalId: id });
  const { v, cx } = await runs([ready('a'), ready('b'), of('s', stuck('d')), of('f', writing('e')), of('r', task('x', 'accepted'))], goals);
  fake.stored[MERGED] = { [pr]: true };
  fake.stored['relevo.workflow.setups.v1'] = { version: 1, items: [{ id: 's1', name: 'App', purpose: '', root: '/work/app', executor: writer, reviewer, maxRounds: 2, maxMinutes: 20, checks: [] }] };
  let tree = v.render(cx);
  assert.match(text(tree), /^Runs a run is a goal you gave your agents n New run/);
  assert.equal(text(find(tree, 'runs-legend')), 'Needs me 2 In flight 1 Ready 1');
  assert.deepEqual(['me', 'flight', 'ready', 'open'].map((group) => text(find(tree, `runs-leg-${group}`))), ['NEEDS ME 2', 'IN FLIGHT 1', 'READY 1', 'NOT STARTED 1']);
  assert.deepEqual(v.nav.map((entry) => entry.id), ['goal-g', 'goal-s', 'goal-f', 'goal-r', 'goal-n']);
  assert.equal(text(find(tree, 'goal-g')), 'Direct work from one Inbox Now 2 results wait for your review Shipped nothing yet Review 2');
  assert.equal(find(tree, 'goal-g').fill, null, 'a run that waits on you says so with its disc and words, unshaded');
  assert.equal(find(tree, 'goal-action-g').fill, t.blocked);
  assert.equal(text(find(tree, 'goal-s')), 'Ship the interface Now stuck: the reviewer rejected it twice Shipped nothing yet See why');
  assert.equal(text(find(tree, 'goal-f')), 'Workflow test Now an agent is writing "Task e" Shipped nothing yet');
  assert.equal(text(find(tree, 'goal-r')), 'Status bar Now finished, everything accepted Shipped 1 pull request merged: #38 Close');
  assert.equal(text(find(tree, 'goal-n')), 'Lab smoke Now needs a plan before agents start Shipped nothing yet Plan');
  assert.equal(find(tree, 'goal-old'), null);
  assert.equal(text(find(tree, 'runs-closed-fold')), '1 older finished run');
  assert.match(text(find(tree, 'runs-setups')), /^Saved setups · 1 Show$/);
  assert.equal(text(find(tree, 'list-keys')), 'j k move open the run n new run ? keys');
  click(find(tree, 'runs-setups-show'), cx); tree = v.render(cx);
  assert.match(text(find(tree, 'runs-setups')), /^Saved setups · 1 Hide$/);
  assert.ok(find(tree, 'setup-s1'), 'the setups open in place'); assert.deepEqual(windows(), []);
  v.navKey({ key: 'n' }, cx);
  assert.equal(fake.overlays.at(-1).props.mode, 'run', 'n starts a new run in its planning window');
});

test('Enter or a click opens a run in the panel, never the run window; j, k and Esc walk it', async () => {
  const all = [ready('a'), ready('b', { round: 2 }), stuck('d'), writing('e'), task('p', 'planned'), task('x', 'accepted')];
  const { v, cx } = await runs(all);
  v.navKey({ key: 'j' }, cx); assert.equal(v.sel, 'goal-g');
  v.navKey({ key: 'enter' }, cx);
  let tree = v.render(cx);
  assert.equal(fake.stored[GOAL_SCOPE], 'g'); assert.deepEqual(windows(), []);
  assert.equal(text(find(tree, 'runs-back')), '‹ Runs'); assert.equal(text(find(tree, 'run-title')), 'Direct work from one Inbox');
  assert.equal(text(find(tree, 'run-summary')), '6 tasks: 2 need you · 1 stuck · 1 in flight · 1 not started · 1 done');
  assert.deepEqual(['me', 'stuck', 'flight'].map((turn) => text(find(tree, `run-leg-${turn}`))), ['NEEDS ME 2 x select', 'STUCK 1', 'IN FLIGHT 1']);
  assert.equal(text(find(tree, 'run-rest-fold')), '1 not started · 1 done');
  assert.deepEqual(v.nav.map((entry) => entry.id), ['task-a', 'task-b', 'task-d', 'task-e']);
  assert.equal(v.sel, 'task-a');
  assert.match(text(find(tree, 'task-a')), /^Task a reviewer approved \S+ Review 1st try: Codex Luna → Team Haiku · 10 min · approved$/);
  assert.match(text(find(tree, 'task-b')), /^Task b approved, 2nd attempt/);
  assert.match(text(find(tree, 'task-e')), /^Task e Codex Luna is writing it/);
  assert.equal(find(tree, 'task-p'), null);
  assert.equal(text(find(tree, 'list-keys')), 'j k move open the task esc runs ? keys');
  v.navKey({ key: 'j' }, cx); v.navKey({ key: 'j' }, cx); v.navKey({ key: 'k' }, cx);
  assert.equal(v.sel, 'task-b');
  click(find(tree, 'run-rest-fold'), cx); tree = v.render(cx);
  assert.deepEqual(v.nav.map((entry) => entry.id).slice(-2), ['task-p', 'task-x']);
  assert.match(text(find(tree, 'task-p')), /not started/);
  v.navKey({ key: 'escape' }, cx); tree = v.render(cx);
  assert.equal(fake.stored[GOAL_SCOPE], null); assert.equal(v.sel, 'goal-g'); assert.ok(find(tree, 'goal-g'));
  click(find(tree, 'goal-g'), cx);
  assert.equal(fake.stored[GOAL_SCOPE], 'g'); assert.deepEqual(windows(), []);
  click(find(v.render(cx), 'runs-back'), cx);
  assert.equal(fake.stored[GOAL_SCOPE], null);
  assert.equal(calls(/cli\.mjs/).length, 0, 'browsing sends nothing');
});

test('a stuck task, selected, says why in the reviewer words and offers the follow-up the run window prepares', async () => {
  const { v, cx } = await runs([ready('a'), stuck('d'), stuck('m', { maxRounds: 3 })]);
  click(find(v.render(cx), 'goal-action-g'), cx);
  let tree = v.render(cx);
  assert.equal(find(tree, 'task-why-text-d'), null, 'one line until it is selected');
  assert.match(text(find(tree, 'task-d')), /^Task d rejected twice, no attempts left \S+ See why$/);
  click(find(tree, 'task-why-d'), cx); tree = v.render(cx);
  assert.equal(v.sel, 'task-d');
  assert.equal(text(find(tree, 'task-why-text-d')), 'Why The nav row still overflows. [major] ui.js: row is cut');
  assert.equal(text(find(tree, 'task-next-d')), 'Next Prepare a follow-up');
  click(find(tree, 'task-follow-up-d'), cx);
  assert.deepEqual(windows(), [{ role: 'workflow', goalId: 'g', taskId: 'd', followUp: 'blocked' }]);
  assert.equal(calls(/cli\.mjs/).length, 0, 'preparing sends nothing');
  v.sel = 'task-m'; tree = v.render(cx);
  assert.equal(find(tree, 'task-follow-up-m'), null);
  assert.equal(text(find(tree, 'task-next-m')), 'Next Retry in the run window');

  fake.props = { ...windows()[0], overlay: 'o' }; fake.stored['relevo.runs.mode'] = 'sessions';
  save([stuck('d', { criteria: 'Rows fit' })]);
  const win = new Workflow(), wcx = fakeCx(); win.init({}, wcx); await flush();
  assert.equal(win.form.title.value(), 'Follow up: Task d');
  assert.match(win.form.criteria.value(), /^Rows fit\n\nLatest reviewer findings: The nav row still overflows\.\n\[major\] ui\.js: row is cut$/);
  assert.equal(win.explicitNew, true); assert.equal(calls(/cli\.mjs/).length, 0);
  win.close();
});

test('a task opens with the summary, who did what and the decision; Accept is A then Enter on the revision on screen', async () => {
  const { v, cx } = await runs([ready('a', { worktree: { branch: 'run/a' } }), ready('b')]);
  v.navKey({ key: 'j' }, cx); v.navKey({ key: 'enter' }, cx); v.render(cx);
  v.navKey({ key: 'enter' }, cx);
  let tree = v.render(cx);
  assert.equal(v.runTask, 'a'); assert.deepEqual(windows(), []);
  assert.equal(text(find(tree, 'task-back')), '‹ Tasks'); assert.equal(text(find(tree, 'task-title')), 'Task a');
  assert.equal(text(find(tree, 'task-summary')), 'Ready results sort ahead of failed ones.');
  assert.equal(text(find(tree, 'task-status')), 'Ready to accept · npm test passed · Team Haiku approved');
  click(find(tree, 'task-how-fold'), cx); tree = v.render(cx);
  assert.deepEqual(['writer', 'tests', 'reviewer', 'you'].map((id) => text(find(tree, `task-leg-${id}`)).replace(/ \d+[mhd]$/, '')), [
    'Codex Luna wrote it in its own worktree', 'Tests npm test passed', 'Team Haiku reviewed it: approved, no findings', 'You accept it, or say what to change now']);
  assert.equal(find(tree, 'task-leg-you').fill, `${t.blocked}12`, "the person's turn is tinted");
  assert.equal(text(find(tree, 'task-accept')), 'a Accept and open draft PR'); assert.equal(find(tree, 'task-accept').fill, t.accent);
  assert.equal(text(find(tree, 'task-changes')), 'r Ask for changes'); assert.equal(text(find(tree, 'task-diff')), 'd See the diff');
  assert.equal(text(find(tree, 'task-effect')), 'Accepting commits to the run branch, pushes it and opens a draft pull request on GitHub. Accepting finishes this task. No follow-up task is defined.');
  assert.equal(text(find(tree, 'list-keys')), 'a accept r changes d diff esc tasks ? keys');

  v.navKey({ key: 'enter' }, cx); await flush();
  assert.deepEqual(decided(), [], 'Enter alone accepts nothing');
  v.navKey({ key: 'a' }, cx); v.navKey({ key: 'a' }, cx); await flush();
  assert.deepEqual(decided(), [], 'A only arms');
  assert.equal(text(find(v.render(cx), 'task-accept')), 'Confirm accept');
  v.navKey({ key: 'j' }, cx); v.navKey({ key: 'enter' }, cx); await flush();
  assert.deepEqual(decided(), [], 'another key disarms');
  v.navKey({ key: 'a' }, cx);
  v.workflowTasks = [{ ...v.workflowTasks[0], revision: 'rev-new' }, v.workflowTasks[1]]; v.render(cx);
  v.navKey({ key: 'enter' }, cx); await flush();
  assert.deepEqual(decided(), [], 'a new revision is never accepted on the old confirmation');
  v.navKey({ key: 'a' }, cx); v.navKey({ key: 'escape' }, cx);
  assert.equal(v.runTask, 'a', 'Esc first drops the confirmation');
  v.navKey({ key: 'enter' }, cx); await flush();
  assert.deepEqual(decided(), []);

  answers([{ ...v.workflowTasks[0], state: 'accepted' }, v.workflowTasks[1]]);
  v.navKey({ key: 'a' }, cx); v.navKey({ key: 'enter' }, cx); await flush();
  assert.deepEqual(decided(), [{ action: 'decide', taskId: 'a', outcome: 'accept', text: '', revision: 'rev-new', openPR: true }]);
  tree = v.render(cx);
  assert.equal(v.runTask, 'a', 'a worktree task stays in view: its draft pull request is next');
  assert.match(text(find(tree, 'run-notice')), /Accepted and committed to its run branch/);
  assert.equal(find(tree, 'task-accept'), null);
  click(find(tree, 'task-more'), cx);
  assert.deepEqual(windows(), [{ role: 'workflow', goalId: 'g', taskId: 'a' }]);
});

test('on the keyboard A arms Accept, Enter confirms it, and Esc or any other key disarms it', async () => {
  const { v, cx } = await runs([ready('a'), ready('b')]);
  click(find(v.render(cx), 'goal-action-g'), cx); click(find(v.render(cx), 'task-review-a'), cx);
  const label = () => text(find(v.render(cx), 'task-accept'));
  for (const key of ['escape', 'x', 'd', 'down']) {
    v.navKey({ key: 'a' }, cx); assert.equal(label(), 'Confirm accept');
    v.navKey({ key }, cx); assert.equal(label(), 'a Accept', `${key} disarms`);
    v.navKey({ key: 'enter' }, cx); await flush();
    assert.deepEqual(decided(), []); assert.equal(v.runTask, 'a');
  }
  answers([{ ...v.workflowTasks[0], state: 'accepted' }, v.workflowTasks[1]]);
  v.navKey({ key: 'a' }, cx); v.navKey({ key: 'enter' }, cx); await flush();
  assert.deepEqual(decided(), [{ action: 'decide', taskId: 'a', outcome: 'accept', text: '', revision: 'rev-a' }]);
});

test('a click on Accept arms, the second confirms; a failed command says so and keeps the task', async () => {
  const { v, cx } = await runs([ready('a'), ready('b')]);
  click(find(v.render(cx), 'goal-action-g'), cx); click(find(v.render(cx), 'task-review-b'), cx);
  click(find(v.render(cx), 'task-accept'), cx); await flush();
  assert.deepEqual(decided(), []);
  fake.exec = (cmd, args) => /cli\.mjs$/.test(args[0] ?? '') ? { code: 1, stdout: '{"error":"Revision changed"}' } : null;
  click(find(v.render(cx), 'task-accept'), cx); await flush();
  assert.equal(decided().length, 1); assert.equal(decided()[0].revision, 'rev-b');
  let tree = v.render(cx);
  assert.equal(text(find(tree, 'run-error')), 'Action needs attention: Revision changed');
  assert.equal(v.runTask, 'b'); assert.ok(find(tree, 'task-accept'));
  answers([v.workflowTasks[0], { ...v.workflowTasks[1], state: 'accepted' }]);
  v.navKey({ key: 'a' }, cx); v.navKey({ key: 'enter' }, cx); await flush(); tree = v.render(cx);
  assert.equal(v.runTask, null, 'back to the tasks, on the next one that waits'); assert.equal(v.sel, 'task-a');
  assert.equal(text(find(tree, 'run-notice')), 'Acceptance saved.');
  assert.equal(text(find(tree, 'run-summary')), '2 tasks: 1 needs you · 1 done');
});

test('Ask for changes is typed in the panel and sent with ⌘↵; with no attempts left it prepares a follow-up instead', async () => {
  const { v, cx } = await runs([ready('a'), ready('b', { round: 2 })]);
  v.navKey({ key: 'j' }, cx); v.navKey({ key: 'enter' }, cx); v.render(cx); v.navKey({ key: 'enter' }, cx); v.render(cx);
  v.navKey({ key: 'r' }, cx);
  let tree = v.render(cx);
  assert.ok(find(tree, 'task-changes-field')); assert.equal(find(tree, 'task-accept'), null);
  assert.match(text(tree), /Starts 2nd try \(last\): write, then review\./);
  assert.equal(find(tree, 'task-send-changes').isDisabled, true);
  v.runChange.submit({ secondary: true }, cx); await flush();
  assert.deepEqual(decided(), [], 'empty feedback is not sent');
  v.runChange.type('Keep the legend on one line\n', cx);
  v.navKey({ key: 'a' }, cx); v.navKey({ key: 'enter' }, cx); await flush();
  assert.deepEqual(decided(), [], 'typing never accepts');
  v.runChange.submit({ secondary: false }, cx); await flush();
  assert.deepEqual(decided(), [], 'plain Enter is a line break');
  answers([{ ...v.workflowTasks[0], state: 'ready' }, v.workflowTasks[1]]);
  v.runChange.submit({ secondary: true }, cx); await flush();
  assert.deepEqual(decided(), [{ action: 'decide', taskId: 'a', outcome: 'changes', text: 'Keep the legend on one line', revision: 'rev-a' }]);
  assert.equal(v.runTask, null); assert.equal(v.runChange.value(), '');
  assert.equal(text(find(v.render(cx), 'run-notice')), 'Feedback saved. The next result will return for your review.');

  click(find(v.render(cx), 'task-review-b'), cx); click(find(v.render(cx), 'task-changes'), cx);
  tree = v.render(cx);
  assert.match(text(tree), /No attempts left: this prepares a follow-up task for you to start\./);
  v.navKey({ key: 'escape' }, cx);
  assert.equal(v.runChangeFor, null); assert.equal(v.runTask, 'b', 'Esc drops the request, not the task');
  click(find(v.render(cx), 'task-changes'), cx); v.runChange.type('Fix the header', cx);
  click(find(v.render(cx), 'task-send-changes'), cx); await flush();
  assert.equal(decided().length, 1, 'nothing is sent for a spent task');
  assert.deepEqual(windows(), [{ role: 'workflow', goalId: 'g', taskId: 'b', followUp: 'changes', text: 'Fix the header' }]);
});

test('See the diff opens the run window on that task’s result; Esc goes back a level at a time', async () => {
  const { v, cx } = await runs([ready('a'), stuck('d')]);
  click(find(v.render(cx), 'goal-action-g'), cx); click(find(v.render(cx), 'task-review-a'), cx);
  v.navKey({ key: 'd' }, cx);
  assert.deepEqual(windows(), [{ role: 'workflow', goalId: 'g', taskId: 'a', tab: 'Changes' }]);
  click(find(v.render(cx), 'task-diff'), cx);
  assert.equal(windows().length, 2);
  v.navKey({ key: 'escape' }, cx); v.render(cx);
  assert.equal(v.runTask, null); assert.equal(v.sel, 'task-a'); assert.equal(fake.stored[GOAL_SCOPE], 'g');
  v.navKey({ key: 'escape' }, cx); v.render(cx);
  assert.equal(fake.stored[GOAL_SCOPE], null); assert.equal(v.sel, 'goal-g');

  fake.props = { role: 'workflow', goalId: 'g', taskId: 'a', tab: 'Changes', overlay: 'o' }; fake.stored['relevo.runs.mode'] = 'sessions';
  save([ready('a'), stuck('d')]);
  const win = new Workflow(), wcx = fakeCx(); win.init({}, wcx); await flush();
  assert.deepEqual([win.selected, win.tab], ['a', 'Changes']);
  assert.ok(find(win.render(), 'workflow-review-diff'));
  fake.stored['relevo.runs.request'] = { goalId: 'g', taskId: 'd', at: Date.now() + 1000 };
  win.render();
  assert.deepEqual([win.selected, win.tab, win.filter], ['d', 'Overview', 'Needs me'], 'More and Back to decision open the summary');
  win.close();
});

test('a stuck task in detail offers the follow-up, never Accept; a task that vanishes closes its view', async () => {
  const { v, cx } = await runs([stuck('d'), ready('a')]);
  click(find(v.render(cx), 'goal-action-g'), cx); v.render(cx); v.sel = 'task-d'; v.navKey({ key: 'enter' }, cx);
  let tree = v.render(cx);
  assert.equal(v.runTask, 'd'); assert.equal(find(tree, 'task-accept'), null); assert.equal(find(tree, 'task-effect'), null);
  assert.match(text(find(tree, 'task-status')), /^Stuck · /);
  v.expanded['how-d'] = true; tree = v.render(cx);
  assert.equal(text(find(tree, 'task-leg-you')), 'You decide what happens next');
  v.navKey({ key: 'a' }, cx); v.navKey({ key: 'enter' }, cx); v.navKey({ key: 'r' }, cx); await flush();
  assert.deepEqual(decided(), []); assert.equal(v.runChangeFor ?? null, null);
  click(find(tree, 'task-follow-up'), cx);
  assert.deepEqual(windows(), [{ role: 'workflow', goalId: 'g', taskId: 'd', followUp: 'blocked' }]);
  v.workflowTasks = [ready('a')]; tree = v.render(cx);
  assert.equal(v.runTask, null); assert.ok(find(tree, 'task-a'));
});

test('an unreadable task state still draws the runs, as status unavailable', async () => {
  fake.files[goalsPath()] = JSON.stringify(saveGoal(emptyGoals(), goal, 0));
  fake.files[STATE] = '{broken';
  const v = new Inbox(), cx = fakeCx(); v.init({}, cx); await flush();
  fake.stored[GOAL_MODE] = true;
  assert.match(text(v.render(cx)), /status unavailable/);
});

test('a change request left open in Runs does not take the keys of Reviews', async () => {
  const { v, cx } = await runs([ready('a')]);
  click(find(v.render(cx), 'goal-action-g'), cx); click(find(v.render(cx), 'task-review-a'), cx);
  v.navKey({ key: 'r' }, cx); assert.equal(v.runChangeFor, 'a');
  fake.stored[GOAL_MODE] = false; v.render(cx);
  v.navKey({ key: 'm' }, cx);
  assert.equal(v.reviewView(), 'maintenance');
});

test('in a task, keys it does not use keep their default', async () => {
  const { v, cx } = await runs([ready('a')]);
  click(find(v.render(cx), 'goal-action-g'), cx); click(find(v.render(cx), 'task-review-a'), cx);
  let stopped = 0; cx.stop_propagation = () => { stopped++; };
  v.navKey({ key: 'tab' }, cx);
  assert.equal(stopped, 0);
  v.navKey({ key: 'a' }, cx);
  assert.equal(stopped, 1);
});

test('a follow-up asked of the run window is prepared once: a reloaded pane does not refill the draft', async () => {
  const { v, cx } = await runs([stuck('d', { criteria: 'Rows fit' })]);
  click(find(v.render(cx), 'goal-action-g'), cx); v.render(cx);
  click(find(v.render(cx), 'task-follow-up-d'), cx);
  assert.ok(asked().at > 0, 'the ask carries a stamp');
  fake.props = { ...asked(), overlay: 'o' }; fake.stored['relevo.runs.mode'] = 'sessions';
  const open = async () => { const win = new Workflow(), wcx = fakeCx(); win.init({}, wcx); await flush(); return win; };
  let win = await open();
  assert.equal(win.form.title.value(), 'Follow up: Task d'); assert.equal(win.explicitNew, true);
  win.close();
  win = await open();
  assert.equal(win.form.title.value(), '', 'the reload does not write the draft again');
  assert.deepEqual([win.selected, win.explicitNew], ['d', false], 'it only selects the task');
  win.close();
  click(find(v.render(cx), 'task-follow-up-d'), cx);
  fake.props = { ...asked(), overlay: 'o' };
  win = await open();
  assert.equal(win.form.title.value(), 'Follow up: Task d', 'asking again is a new ask');
  assert.ok(fake.stored['relevo.runs.applied'].length <= 20);
  win.close();
});

test('a change request sent as a follow-up stays typed until the run window takes it', async () => {
  const { v, cx } = await runs([ready('b', { round: 2, criteria: 'Rows fit' })]);
  click(find(v.render(cx), 'goal-action-g'), cx); click(find(v.render(cx), 'task-review-b'), cx);
  click(find(v.render(cx), 'task-changes'), cx); v.runChange.type('Fix the header', cx);
  click(find(v.render(cx), 'task-send-changes'), cx); await flush();
  let tree = v.render(cx); await flush();
  assert.equal(text(find(tree, 'run-notice')), 'Sent to the run window.');
  assert.equal(v.runChange.value(), 'Fix the header', 'nothing is lost while the window has not answered');
  assert.ok(find(tree, 'task-changes-field'));
  assert.equal(fake.stored['relevo.runs.followup'], asked().at);

  fake.props = { ...asked(), overlay: 'o' }; fake.stored['relevo.runs.mode'] = 'sessions';
  const win = new Workflow(), wcx = fakeCx(); win.init({}, wcx); await flush();
  assert.match(win.form.criteria.value(), /Requested changes: Fix the header$/);
  assert.equal(fake.stored['relevo.runs.followup'], null, 'the window says it took the follow-up');
  win.close();
  v.render(cx); await flush(); tree = v.render(cx);
  assert.equal(v.runChange.value(), ''); assert.equal(find(tree, 'task-changes-field'), null);
  assert.equal(text(find(tree, 'run-notice')), 'The follow-up is ready in the run window.');
  assert.equal(decided().length, 0, 'a spent task is never sent feedback');
});

test('a notice or an error leaves with the run or task it was said on, whatever moved the view', async () => {
  const other = newGoal('h', 'Another run');
  const { v, cx } = await runs([ready('a'), ready('b'), { ...ready('c'), goalId: 'h' }], [goal, other]);
  const said = () => { const tree = v.render(cx); return [text(find(tree, 'run-notice')), text(find(tree, 'run-error'))]; };
  const say = () => { v.runNotice = 'Acceptance saved.'; v.runError = 'Action needs attention: locked'; };
  click(find(v.render(cx), 'goal-action-g'), cx); v.render(cx);
  say(); assert.deepEqual(said(), ['Acceptance saved.', 'Action needs attention: locked'], 'a redraw in place keeps them');
  fake.stored[GOAL_SCOPE] = 'h';
  assert.deepEqual(said(), ['', ''], 'another run opened from a command');
  say(); v.runTask = 'c';
  assert.deepEqual(said(), ['', ''], 'a task opened');
  say(); fake.stored[GOAL_MODE] = false; v.render(cx); fake.stored[GOAL_SCOPE] = null; fake.stored[GOAL_MODE] = true;
  assert.deepEqual(said(), ['', ''], 'the run closed while Reviews was showing');
  say(); v.navKey({ key: 'j' }, cx);
  assert.deepEqual(said(), ['Acceptance saved.', 'Action needs attention: locked'], 'moving the selection is not leaving');
});

test('a worktree task lists its changed files, and d or a file opens that change in the review pane, not the run window', async () => {
  const wt = { path: '/wt/app-run', base: '/work/app', baseCommit: 'b'.repeat(40), reviewedTree: 'c'.repeat(40), branch: 'run/a' };
  const list = [{ path: 'slug.js', added: 6, removed: 1 }, { path: 'img.png', added: 0, removed: 0, binary: true }];
  const asks = [];
  fake.exec = (cmd, args) => {
    if (cmd === 'git' && args.includes('--show-toplevel')) return { code: 0, stdout: '/work/app\n' };
    if (!/cli\.mjs$/.test(args[0] ?? '')) return null;
    const payload = JSON.parse(args.at(-1)); asks.push(payload.action);
    return payload.action === 'task-diff' ? { code: 0, stdout: JSON.stringify({ result: { taskId: 'a', root: '/work/app', fromCommit: wt.baseCommit, toCommit: wt.reviewedTree, files: 2, added: 6, removed: 1, list } }) } : null;
  };
  const { v, cx } = await runs([ready('a', { worktree: wt })]);
  click(find(v.render(cx), 'goal-action-g'), cx); click(find(v.render(cx), 'task-review-a'), cx);
  v.render(cx); await flush();
  assert.match(text(find(v.render(cx), 'task-files-fold')), /^2 files changed · \+6 −1/);
  v.expanded['files-a'] = true;
  const view = v.render(cx);
  assert.match(text(find(view, 'task-files')), /2 files changed.*\+6.*−1.*slug\.js.*\+6.*−1.*img\.png.*binary/);
  assert.equal(find(view, 'task-diff').fill, t.solid, 'while it waits on you, the diff is a main action beside Accept');
  v.navKey({ key: 'd' }, cx); await flush();
  assert.deepEqual(asked(), { role: 'review-diff', root: '/work/app', terminal: null, pr: null,
    range: { from: wt.baseCommit, to: wt.reviewedTree, label: 'Task a · as reviewed' } });
  click(find(v.render(cx), 'task-file-0'), cx); await flush();
  assert.equal(asked().range.file, 'slug.js');
  assert.equal(windows().filter((w) => w.role === 'workflow').length, 0);
  v.render(cx); v.render(cx);
  assert.equal(asks.filter((a) => a === 'task-diff').length, 1, 'read once per change it keeps');
});

test('a run that is starting says in Runs what it waits on, and Trust and continue answers only a question still on screen', async () => {
  const { RUN_LAUNCH } = await import('../run-launch.js');
  const claude = ' ❯ No, exit\n   Yes, I trust this folder\n';
  let screen = claude;
  const asks = [];
  fake.exec = (cmd, args) => { if (cmd !== 'hc') return null; asks.push(args.join(' ')); return args[0] === 'read' ? { code: 0, stdout: screen } : { code: 0, stdout: '' }; };
  fake.stored[RUN_LAUNCH] = { goalId: 'g', words: '“t-1 · build” asks whether to trust the run\'s worktree before it starts.', trust: { address: 't1' }, at: Date.now() };
  const { v, cx } = await runs([]);
  const view = v.render(cx);
  assert.match(text(view), /asks whether to trust the run's worktree/);
  click(find(view, 'goal-action-g'), cx); await flush();
  assert.deepEqual(asks, ['read t1 --lines 30', 'keys t1 down enter']);
  screen = 'Ask Claude anything';
  click(find(v.render(cx), 'goal-action-g'), cx); await flush();
  assert.equal(asks.filter((a) => a.startsWith('keys')).length, 1, 'an agent that already started gets no keys');
  fake.stored[RUN_LAUNCH] = { ...fake.stored[RUN_LAUNCH], at: Date.now() - 600000 };
  assert.match(text(v.render(cx)), /needs a plan before agents start/, 'a launch left behind stops showing');
});

test('an accepted run that fixes a pull request offers Push to its branch, and says when GitHub refuses it', async () => {
  const wt = { path: '/wt/fix-7', base: '/work/app', baseCommit: 'b'.repeat(40), branch: 'run/fix-7', prHead: 'fix/search', prUrl: 'https://github.com/me/app/pull/7', commit: 'c'.repeat(40) };
  const asks = [];
  let refuse = false;
  fake.exec = (cmd, args) => {
    if (!/cli\.mjs$/.test(args?.[0] ?? '')) return null;
    const p = JSON.parse(args.at(-1)); asks.push(p.action);
    if (p.action === 'worktree-push' && refuse) return { code: 1, stdout: JSON.stringify({ error: 'fix/search moved on GitHub since the run started; nothing was pushed' }) };
    return p.action === 'task-diff' ? { code: 0, stdout: JSON.stringify({ result: { root: '/work/app', fromCommit: wt.baseCommit, toCommit: wt.commit, files: 0, list: [] } }) } : null;
  };
  const { v, cx } = await runs([task('a', 'accepted', { worktree: wt, attempts: [wrote(), reviewed()] })]);
  v.expanded['more-run-rest'] = true; v.openRun(goal, cx, 'a'); v.render(cx); v.navKey({ key: 'enter' }, cx); v.render(cx); await flush();
  refuse = true;
  click(find(v.render(cx), 'task-push'), cx); await flush();
  assert.match(text(v.render(cx)), /Not pushed: fix\/search moved on GitHub/);
  assert.equal(asks.filter((a) => a === 'worktree-push').length, 1);
});

test('a draft pull request opens as a run from scratch is accepted, says why when it can not, and is described by the run', async () => {
  const { draftBody, draftOnAccept, decidePayload } = await import('../lib/workflow-navigation.js');
  const own = { worktree: { branch: 'run/a' } };
  assert.deepEqual([draftOnAccept(own), draftOnAccept({ worktree: { branch: 'run/a', prHead: 'fix/x' } }), draftOnAccept({ worktree: { branch: 'run/a', pr: 'https://x' } }), draftOnAccept({}), draftOnAccept(own, false)],
    [true, false, false, false, false]);
  assert.equal(decidePayload({ id: 'a', revision: 'r', ...own }, 'changes', 'x').openPR, undefined);
  const body = draftBody(ready('a', { criteria: 'Ready results first', checksResult: [{ argv: ['npm', 'test'], code: 0 }],
    attempts: [{ ...wrote(), report: { status: 'completed', summary: 'Sorted ready first', details: ['list.js reorders'], notProven: ['Large lists'] } },
      reviewed('completed', { summary: 'Looks right', findings: [{ level: 'minor', where: 'list.js:3', issue: 'Name it' }] })] }));
  assert.match(body, /^Ready results first\n\n## What changed\nSorted ready first\n- list\.js reorders\n\nChecks: npm test passed\.\n\n## Independent review\nLooks right\n- \[minor\] list\.js:3: Name it\n\n## Not verified\n- Large lists$/);
  answers([{ ...ready('a', own), state: 'accepted' }]);
  fake.exec = ((answer) => (cmd, args) => { const out = answer(cmd, args); if (!out) return out;
    const p = JSON.parse(args.at(-1)); return p.action === 'decide' ? { stdout: JSON.stringify({ ...JSON.parse(out.stdout), result: { prError: 'no origin remote' } }) } : out; })(fake.exec);
  const { v, cx } = await runs([ready('a', own)]);
  v.navKey({ key: 'j' }, cx); v.navKey({ key: 'enter' }, cx); v.render(cx); v.navKey({ key: 'enter' }, cx); v.render(cx);
  v.navKey({ key: 'a' }, cx); v.navKey({ key: 'enter' }, cx); await flush();
  assert.equal(decided().at(-1).openPR, true);
  assert.match(v.runNotice, /Accepted and committed; the draft pull request didn't open: no origin remote/);
});

test('a run whose tasks were all cancelled says so, not that it needs a plan, and a second opinion counts its review', async () => {
  const { runCostLine } = await import('../lib/run-compare.js');
  const row = (tasks) => runRow(goal, runBucket(tasks, 'g'), { engine: { enabled: true } });
  assert.deepEqual(row([task('x', 'cancelled')]), { group: 'ready', turn: 'old', now: 'cancelled', action: { kind: 'open', label: 'Open' } });
  assert.equal(row([task('x', 'cancelled'), task('y', 'cancelled')]).now, 'all its tasks cancelled');
  assert.equal(row([task('x', 'accepted'), task('y', 'cancelled')]).now, 'finished, everything accepted');
  const opinion = task('o', 'needs_you', { reviewOnly: true, attempts: [reviewed()], checks: [['npm', 'test']], checksResult: [{ code: 1 }] });
  assert.deepEqual(runCostLine(goal, runBucket([opinion], 'g'), { minutes: 2, total: 0 }).rest, ['1 review', '0 of 1 check passed']);
  assert.deepEqual(runCostLine(goal, runBucket([writing('e')], 'g'), { minutes: 2, total: 0 }).rest, ['1 attempt']);
});
