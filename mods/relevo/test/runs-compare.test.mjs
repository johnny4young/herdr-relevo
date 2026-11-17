import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake, calls, theme } from './fake/herdr.mjs';
import { fakeCx, flush, find, click, text } from './fake/ui.mjs';
import { newGoal, saveGoal, emptyGoals } from '../lib/goals.js';
import { runBucket } from '../lib/run-panel.js';
import { RUN_BUCKET_MS } from '../lib/usage-scan.js';
import { goalCost } from '../lib/run-cost.js';
import { INBOX_SHORTCUT_ACTIONS } from '../lib/shortcut-help.js';
import { runCostLine, resumable, taskRounds, attemptHistory, canCompare, compareAttempts, diffFiles, batchSummary, sameRepository, thenWords } from '../lib/run-compare.js';
const { Inbox } = await import('../inbox.js');
const { Workflow } = await import('../workflow.js');
const { GOAL_MODE } = await import('../inbox-goals.js');
const { goalsPath } = await import('../goals-store.js');
const { MERGED } = await import('../inbox-runs.js');
const { SETUPS_KEY } = await import('../workflow-setups.js');

beforeEach(resetFake);
const t = theme();
const WT = '/home/test/.herdr/worktrees/app/collapse-0a1b2c', REPORT = '/home/test/.local/state/relevo/usage/report.json';
const writer = { address: 'w1', label: 'Codex Luna' }, reviewer = { address: 'r1', label: 'Team Haiku' };
const at = (hhmm) => `2026-01-01T${hhmm}:00Z`, bucketOf = (hhmm) => Math.floor(Date.parse(at(hhmm)) / RUN_BUCKET_MS);
const task = (id, state, more = {}) => ({ id, goalId: 'g', title: `Task ${id}`, state, root: '/work/app', executor: writer, reviewer, round: 1, maxRounds: 2, attempts: [], decisions: [], ...more });
const ready = (id, more = {}) => task(id, 'needs_you', { revision: `rev-${id}`, checks: [['npm', 'test']], checksResult: [{ code: 0 }],
  attempts: [{ id: 'a1', role: 'executor', state: 'reported', at: at('10:00'), report: { status: 'completed', summary: 'Done.' } },
    { id: 'a2', role: 'reviewer', state: 'reported', at: at('10:10'), report: { status: 'completed', summary: '' } }], ...more });
// Written twice: the reviewer asked for changes, the person added a note, the second attempt was approved.
const twice = (id = 't', more = {}) => task(id, 'needs_you', { revision: `rev-${id}`, round: 2, checks: [['npm', 'test']], checksResult: [{ code: 0 }],
  worktree: { path: WT, base: '/work/app', branch: 'run/collapse' },
  attempts: [
    { id: 'w-1', role: 'executor', state: 'reported', at: at('10:00'), endedAt: at('10:15'), report: { status: 'completed', summary: 'First try.' }, tests: { passed: 2, total: 3 }, change: { files: 5, added: 74, removed: 31 } },
    { id: 'r-1', role: 'reviewer', state: 'reported', at: at('10:15'), endedAt: at('10:18'),
      report: { status: 'changes_requested', summary: 'The nav row overflows.', findings: [{ level: 'major', where: 'ui.js', issue: 'nav row is cut', fix: '' }] } },
    { id: 'w-2', role: 'executor', state: 'reported', at: at('10:20'), endedAt: at('10:27'), report: { status: 'completed', summary: 'Second try.' }, tests: { passed: 3, total: 3 }, change: { files: 4, added: 52, removed: 12 } },
    { id: 'r-2', role: 'reviewer', state: 'reported', at: at('10:27'), endedAt: at('10:29'), report: { status: 'completed', summary: '' } }],
  decisions: [{ id: 'd1', outcome: 'changes', text: 'Keep it on one line\nplease', revision: 'old', at: at('10:19') }], ...more });
const sessions = [{ id: 's', folder: WT, last: at('10:29'), spans: [[bucketOf('10:00'), 6000000, 200000], [bucketOf('10:20'), 2900000, 0]] }];
const goal = newGoal('g', 'Direct work from one Inbox');

const STATE = '/home/test/.config/herdr-app/relevo-workflow/state.json';
const save = (tasks, engine = { enabled: true }) => { fake.files[STATE] = JSON.stringify({ tasks, events: [], engine }); };
async function runs(tasks = [], goals = [goal], engine) {
  fake.files[goalsPath()] = JSON.stringify(goals.reduce((doc, g) => saveGoal(doc, g, 0), emptyGoals()));
  save(tasks, engine);
  const v = new Inbox(), cx = fakeCx(); v.init({}, cx); await flush();
  fake.stored[GOAL_MODE] = true; v.h.is_focused = () => true; v.render(cx);
  return { v, cx };
}
// Opens the run and waits for the usage report it reads.
async function opened(tasks, goals, engine) {
  const { v, cx } = await runs(tasks, goals, engine);
  v.navKey({ key: 'j' }, cx); v.navKey({ key: 'enter' }, cx); v.render(cx); await flush();
  return { v, cx };
}
const sent = (action) => calls(new RegExp(`"action":"${action}"`)).map((line) => JSON.parse(line.slice(line.indexOf('{'))));
// The coordinator's answer to each command, by the payload it was sent.
const coordinator = (answer) => { fake.exec = (cmd, args) => (/cli\.mjs$/.test(args[0] ?? '') ? answer(JSON.parse(args.at(-1))) : null); };
const windows = () => fake.runs.filter(([name]) => name === 'pane.split').map(([, args]) => { const { at: _at, ...props } = args.props; return props; });
const asked = () => fake.runs.findLast(([name]) => name === 'pane.split')[1].props;

test('the cost line: agent minutes and tokens against their caps, attempts, tests and pull requests', () => {
  const bucket = runBucket([twice(), ready('a'), task('p', 'planned', { checks: [['npm', 'test']] })], 'g'), cost = goalCost(goal, bucket.all, sessions);
  assert.deepEqual([cost.minutes, cost.total], [37, 9100000]);
  const free = runCostLine(goal, bucket, cost, 2);
  assert.deepEqual([free.minutes.text, free.minutes.cap, free.minutes.over, free.tokens.text], ['37 agent min', null, false, '9.1M tokens']);
  assert.deepEqual(free.rest, ['3 attempts', '2 of 3 checks passed', '2 PRs shipped']);
  const capped = runCostLine({ ...goal, maxAgentMinutes: 60, maxTokens: 10000000 }, bucket, cost);
  assert.deepEqual([capped.minutes.text, capped.minutes.pct, capped.minutes.over], ['37 of 60 agent min', 62, false]);
  assert.deepEqual([capped.tokens.text, capped.tokens.pct, capped.tokens.over], ['9.1M of 10.0M tokens', 91, false]);
  assert.deepEqual(capped.rest, ['3 attempts', '2 of 3 checks passed']);
  const over = runCostLine({ ...goal, maxAgentMinutes: 37, maxTokens: 5000000 }, bucket, cost);
  assert.deepEqual([over.minutes.over, over.minutes.pct, over.tokens.over], [true, 100, true], 'at the cap counts as over');
  const none = runCostLine(goal, runBucket([task('p', 'planned')], 'g'), goalCost(goal, [], []));
  assert.deepEqual([none.minutes.text, none.tokens, none.rest], ['0 agent min', null, ['0 attempts']], 'no tokens read and no cap: nothing to say about tokens');
  assert.deepEqual(resumable(runBucket([task('a', 'running', { paused: true }), task('b', 'planned', { paused: true }), task('c', 'blocked', { paused: true }), task('d', 'ready')], 'g')).map((item) => item.id), ['a']);
});

test('an open run shows its cost under the summary; over the cap the band and the number turn red', async () => {
  const pr = 'https://github.com/acme/app/pull/38';
  fake.files[REPORT] = JSON.stringify({ updated: 1, rows: [], sessions: [], runs: sessions });
  fake.stored[MERGED] = { [pr]: true };
  const { v, cx } = await opened([twice()], [{ ...newGoal('g', 'Capped', [`pr:${pr}`]), maxAgentMinutes: 20, maxTokens: 10000000 }]);
  let tree = v.render(cx);
  assert.equal(text(find(tree, 'run-cost')), '27 of 20 agent min · 9.1M of 10.0M tokens · 2 attempts · 1 of 1 check passed · 1 PR shipped Pause automation');
  assert.equal(find(tree, 'run-cost-band').items[0].items[1].fill, t.blocked);
  assert.equal(find(tree, 'run-cost-minutes').ink, t.blocked); assert.equal(find(tree, 'run-cost-tokens').ink, null);
  for (let i = 0; i < 3; i++) v.render(cx);
  await flush();
  assert.equal(calls(/^cat .*usage\/report\.json$/).length, 1, 'the report is read once');
  fake.files[REPORT] = JSON.stringify({ updated: 2, rows: [], sessions: [], runs: [] }); fake.stored['relevo.usage'] = { updated: 2 };
  v.render(cx); await flush(); tree = v.render(cx);
  assert.equal(calls(/^cat .*usage\/report\.json$/).length, 2, 'and again when the scanner wrote a newer one');
  assert.equal(find(tree, 'run-cost-tokens').ink, null);
  assert.match(text(find(tree, 'run-cost')), /^27 of 20 agent min · 0 of 10\.0M tokens/);
});

test('under the cap the band is the accent; with no cap there is no band, and a cap never stops anything', async () => {
  let { v, cx } = await opened([twice()], [{ ...goal, maxAgentMinutes: 60 }]);
  let tree = v.render(cx);
  assert.equal(find(tree, 'run-cost-band').items[0].items[1].fill, t.accent);
  assert.equal(find(tree, 'run-cost-minutes').ink, null);
  assert.equal(text(find(tree, 'run-cost')), '27 of 60 agent min · 2 attempts · 1 of 1 check passed Pause automation');
  resetFake();
  ({ v, cx } = await opened([twice()]));
  tree = v.render(cx);
  assert.equal(find(tree, 'run-cost-band'), null);
  assert.equal(text(find(tree, 'run-cost')), '27 agent min · 2 attempts · 1 of 1 check passed Pause automation');
  assert.equal(calls(/cli\.mjs/).length, 0, 'reading the cost sends nothing');
});

test('Pause automation stops the engine; Resume automation resumes only this run’s work that was under way', async () => {
  const flying = task('e', 'running', { attempts: [{ id: 'a1', role: 'executor', state: 'running', at: at('10:00') }] });
  let { v, cx } = await opened([ready('a'), flying]);
  coordinator(() => ({ stdout: JSON.stringify({ doc: { tasks: [ready('a'), { ...flying, paused: true }], engine: { enabled: false } } }) }));
  click(find(v.render(cx), 'run-pause'), cx); await flush();
  assert.deepEqual(sent('stop'), [{ action: 'stop' }]);
  resetFake();
  const other = { ...task('o', 'running', { paused: true }), goalId: 'else' };
  ({ v, cx } = await opened([ready('a'), { ...flying, paused: true }, task('p', 'planned', { paused: true }), other], [goal, newGoal('else', 'Other')], { enabled: false }));
  const tree = v.render(cx);
  assert.equal(find(tree, 'run-pause'), null);
  click(find(tree, 'run-resume'), cx); await flush();
  assert.deepEqual(sent('resume'), [{ action: 'resume', taskId: 'e' }], 'a planned task is not started by it');
});

test('attempt history: who passed to whom, how long it took and how it ended', () => {
  assert.deepEqual(taskRounds(twice()).map((round) => [round.n, round.writer.id, round.reviewer.id]), [[1, 'w-1', 'r-1'], [2, 'w-2', 'r-2']]);
  assert.deepEqual(attemptHistory(twice()).map((line) => line.text),
    ['1st try: Codex Luna → Team Haiku · 18 min · asked for changes', '2nd try: Codex Luna → Team Haiku · 9 min · approved']);
  assert.deepEqual(attemptHistory(twice()).map((line) => line.ok), [false, true]);
  const now = Date.parse(at('10:04'));
  assert.deepEqual(attemptHistory(task('e', 'running', { maxMinutes: 20, attempts: [{ id: 'a1', role: 'executor', state: 'running', at: at('10:00') }] }), now).map((line) => line.text),
    ['1st try: Codex Luna · 4 min · writing']);
  assert.equal(attemptHistory(task('f', 'blocked', { attempts: [{ id: 'a1', role: 'executor', state: 'reported', at: at('10:00'), endedAt: at('10:20'), timedOut: true }] }))[0].text,
    '1st try: Codex Luna · 20 min · timed out');
  assert.deepEqual(attemptHistory(task('p', 'planned')), []);
  assert.equal(canCompare(twice()), true); assert.equal(canCompare(ready('a')), false);
});

test('a selected task lists its attempts; the task shows them above the decision only when there was more than one', async () => {
  const { v, cx } = await opened([twice(), ready('a')]);
  let tree = v.render(cx);
  assert.equal(v.sel, 'task-t');
  assert.deepEqual([1, 2].map((n) => text(find(tree, `task-attempt-t-${n}`))),
    ['1st try: Codex Luna → Team Haiku · 18 min · asked for changes', '2nd try: Codex Luna → Team Haiku · 9 min · approved']);
  assert.equal(find(tree, 'task-attempt-t-1').ink, t.blocked); assert.equal(find(tree, 'task-attempt-t-2').ink, t.muted);
  assert.equal(find(tree, 'task-attempt-a-1'), null, 'only the selected row opens');
  v.navKey({ key: 'enter' }, cx); tree = v.render(cx);
  assert.equal(text(find(tree, 'task-attempts')), '1st try: Codex Luna → Team Haiku · 18 min · asked for changes 2nd try: Codex Luna → Team Haiku · 9 min · approved');
  assert.equal(text(find(tree, 'task-compare')), 'c Compare attempts');
  assert.equal(text(find(tree, 'list-keys')), 'a accept r changes d diff c compare esc tasks ? keys');
  v.navKey({ key: 'escape' }, cx); v.render(cx); v.navKey({ key: 'j' }, cx); v.navKey({ key: 'enter' }, cx); tree = v.render(cx);
  assert.equal(v.runTask, 'a');
  assert.equal(find(tree, 'task-attempts'), null); assert.equal(find(tree, 'task-compare'), null);
});

test('the compare table: what the reviewer said, tests, change, time, cost and your note, one column per attempt', () => {
  const table = compareAttempts(twice(), sessions);
  assert.equal(table.took, 'took 2 attempts');
  assert.deepEqual(table.columns, [{ n: 1, label: 'Attempt 1' }, { n: 2, label: 'Attempt 2' }]);
  assert.deepEqual(table.rows.map((row) => [row.label, ...row.cells.map((cell) => cell.text)]), [
    ['Reviewer said', 'asked for changes: nav row is cut', 'approved'], ['Tests', '2 of 3 checks passed', '3 of 3 checks passed'], ['Change', '5 files', '4 files'],
    ['Took', '18 min', '9 min'], ['Cost', '6.2M tokens', '2.9M tokens'], ['Your note', 'Keep it on one line', 'none']]);
  assert.deepEqual(table.rows[0].cells.map((cell) => cell.ok), [false, true]);
  assert.deepEqual(table.rows[2].cells.map((cell) => [cell.added, cell.removed]), [[74, 31], [52, 12]]);
  assert.deepEqual(table.diff, { from: 'w-1', to: 'w-2' });
  const bare = twice('t', { worktree: undefined, attempts: twice().attempts.map(({ tests: _tests, change: _change, ...attempt }) => attempt) });
  assert.deepEqual(compareAttempts(bare, sessions).rows.slice(1, 5).map((row) => row.cells.map((cell) => cell.text)),
    [['not kept', 'npm test passed'], ['not kept', 'not kept'], ['18 min', '9 min'], ['not counted', 'not counted']], 'older records say what was not kept');
  const five = twice('t', { attempts: [1, 2, 3, 4, 5].map((n) => ({ id: `w-${n}`, role: 'executor', state: 'reported', at: at(`1${n}:00`), endedAt: at(`1${n}:05`), report: { status: 'completed' } })) });
  assert.deepEqual(compareAttempts(five).columns.map((column) => column.n), [3, 4, 5], 'the last three');
  assert.equal(compareAttempts(five).took, 'took 5 attempts'); assert.deepEqual(compareAttempts(five).diff, { from: 'w-4', to: 'w-5' });
  const many = diffFiles({ files: 63, added: 900, removed: 40, list: Array.from({ length: 60 }, (_, i) => ({ path: `src/f${i}.js`, added: 1, removed: 0 })) });
  assert.deepEqual([many.head, many.list.length, many.more], ['63 files changed', 50, 13]);
  assert.deepEqual(diffFiles({ files: 1, added: 2, removed: 1, list: [{ path: 'a.js', added: 2, removed: 1 }] }).more, 0);
});

test('c opens the comparison of a task written more than once; See what changed asks for the diff of its last two attempts', async () => {
  fake.files[REPORT] = JSON.stringify({ updated: 1, rows: [], sessions: [], runs: sessions });
  const { v, cx } = await opened([twice(), ready('a')]);
  assert.equal(text(find(v.render(cx), 'list-keys')), 'j k move open the task c compare esc runs ? keys');
  v.navKey({ key: 'c' }, cx);
  let tree = v.render(cx);
  assert.equal(text(find(tree, 'compare-back')), '‹ Tasks'); assert.equal(text(find(tree, 'compare-title')), 'Task t'); assert.equal(text(find(tree, 'compare-attempts')), 'took 2 attempts');
  assert.equal(text(find(tree, 'compare-head')), 'ATTEMPT 1 ATTEMPT 2');
  assert.deepEqual(['said', 'tests', 'change', 'took', 'cost', 'note'].map((key) => text(find(tree, `compare-${key}`))), [
    'Reviewer said asked for changes: nav row is cut approved', 'Tests 2 of 3 checks passed 3 of 3 checks passed', 'Change 5 files +74 −31 4 files +52 −12',
    'Took 18 min 9 min', 'Cost 6.2M tokens 2.9M tokens', 'Your note Keep it on one line none']);
  assert.equal(find(tree, 'compare-said-1').items[1].ink, t.blocked); assert.equal(find(tree, 'compare-said-2').items[1].ink, t.done);
  assert.deepEqual(v.nav, [], 'the list keys rest while it is open');
  assert.equal(text(find(tree, 'list-keys')), 'esc back ? keys');
  assert.equal(calls(/cli\.mjs/).length, 0, 'opening it sends nothing');

  const list = Array.from({ length: 55 }, (_, i) => ({ path: `src/file-${i}.js`, added: i, removed: 1 }));
  coordinator(() => ({ stdout: JSON.stringify({ result: { taskId: 't', from: 'w-1', to: 'w-2', files: 55, added: 120, removed: 55, list } }) }));
  click(find(tree, 'compare-diff-open'), cx); await flush(); tree = v.render(cx);
  assert.deepEqual(sent('attempt-diff'), [{ action: 'attempt-diff', taskId: 't', from: 'w-1', to: 'w-2' }]);
  assert.match(text(find(tree, 'compare-diff')), /^55 files changed \+120 −55 src\/file-0\.js \+0 −1 /);
  assert.ok(find(tree, 'compare-file-49')); assert.equal(find(tree, 'compare-file-50'), null);
  assert.equal(text(find(tree, 'compare-diff-more')), '+5 more');

  fake.exec = (cmd, args) => (/cli\.mjs$/.test(args[0] ?? '') ? { code: 1, stdout: '{"error":"No snapshot is kept for this attempt"}' } : null);
  click(find(tree, 'compare-diff-open'), cx); await flush(); tree = v.render(cx);
  assert.equal(text(find(tree, 'compare-diff-error')), 'No snapshot is kept for this attempt');
  assert.equal(find(tree, 'compare-diff-error').ink, t.muted, 'a quiet line, not an alarm');
  assert.equal(find(tree, 'compare-diff'), null); assert.equal(find(tree, 'run-error'), null);

  for (const key of ['a', 'enter', 'x', 'j']) v.navKey({ key }, cx);
  assert.equal(v.runCompare, 't'); assert.equal(sent('decide').length + sent('batch').length, 0, 'no other key acts here');
  v.navKey({ key: 'escape' }, cx); tree = v.render(cx);
  assert.equal(v.runCompare, null); assert.equal(v.sel, 'task-t'); assert.ok(find(tree, 'task-t'), 'Esc goes back to the tasks');
  v.navKey({ key: 'j' }, cx); v.navKey({ key: 'c' }, cx);
  assert.equal(v.runCompare, null, 'a task written once has nothing to compare');
  assert.equal(text(find(v.render(cx), 'list-keys')), 'j k move open the task esc runs ? keys');

  v.navKey({ key: 'k' }, cx); v.navKey({ key: 'enter' }, cx); v.render(cx);
  v.navKey({ key: 'a' }, cx); v.navKey({ key: 'c' }, cx); tree = v.render(cx);
  assert.equal(text(find(tree, 'compare-back')), '‹ Task'); assert.equal(v.acceptIntent, null, 'c disarms Accept');
  click(find(tree, 'compare-back'), cx); tree = v.render(cx);
  assert.equal(v.runTask, 't'); assert.ok(find(tree, 'task-accept'), 'from a task, back is the task');
});

test('selection words: what holds for every selected result, or what does not', () => {
  const failing = ready('f', { checksResult: [{ code: 1 }] }), plain = ready('n', { checks: [], checksResult: [] }), far = ready('o', { root: '/work/other' });
  const unreviewed = ready('u', { attempts: [ready('u').attempts[0]] });
  assert.deepEqual(batchSummary([ready('a'), ready('b')]), { ok: true, clean: true, text: 'all approved, all tests pass', repository: 'app' });
  assert.deepEqual(batchSummary([ready('a'), failing, plain, unreviewed]), { ok: true, clean: false, text: '1 not approved · 1 with failing tests · 1 without test results', repository: 'app' });
  assert.deepEqual(batchSummary([ready('a'), far]), { ok: false, clean: false, text: 'more than one repository', repository: null });
  assert.equal(batchSummary([]).ok, false);
  assert.deepEqual(sameRepository(ready('a'), [ready('a'), far, ready('b'), twice('w')]).map((item) => item.id), ['a', 'b', 'w'], 'a worktree run belongs to the repository it branched from');
  const tasks = [ready('a'), task('n', 'ready', { dependsOn: ['a'] }), ready('b'), task('m', 'planned', { dependsOn: ['b'] })];
  assert.equal(thenWords(tasks[0], tasks, { enabled: true }), 'then: 1 follow-up starts');
  assert.equal(thenWords(tasks[0], tasks, { enabled: false }), 'then: 1 follow-up still waits');
  assert.equal(thenWords(tasks[2], tasks, { enabled: true }), 'then: 1 follow-up still waits');
  assert.equal(thenWords(ready('z'), tasks, { enabled: true }), 'then: done');
  const both = [ready('a'), ready('b'), task('n', 'ready', { dependsOn: ['a', 'b'] })];
  assert.equal(thenWords(both[0], both, { enabled: true }), 'then: 1 follow-up still waits', 'another prerequisite still waits');
});

test('x selects results, X every one of the same repository; Enter previews, then accepts those ids at those revisions', async () => {
  const all = [ready('a'), ready('b'), ready('c', { root: '/work/other' }), task('e', 'running', { attempts: [{ id: 'a1', role: 'executor', state: 'running', at: at('10:00') }] })];
  const { v, cx } = await opened(all);
  let tree = v.render(cx);
  assert.equal(text(find(tree, 'run-leg-me')), 'NEEDS ME 3 x select'); assert.equal(find(tree, 'runs-batch'), null);
  v.navKey({ key: 'x' }, cx); tree = v.render(cx);
  assert.deepEqual(v.runPicked, ['a']);
  assert.equal(text(find(tree, 'run-leg-me')), 'NEEDS ME 3 same repository: app');
  assert.match(text(find(tree, 'task-a')), /^Task a then: done/);
  assert.equal(find(tree, 'task-review-a'), null);
  assert.equal(find(tree, 'task-pick-a').items[0].fill, t.accent); assert.equal(find(tree, 'task-pick-b').items[0].fill, null);
  assert.equal(find(tree, 'task-pick-a').accessibleLabel, 'Selected: Task a');
  assert.equal(text(find(tree, 'runs-batch')), '1 selected all approved, all tests pass esc Cancel Accept 1');
  assert.equal(find(tree, 'runs-batch-accept').fill, t.accent); assert.equal(find(tree, 'list-keys'), null);
  v.navKey({ key: 'x' }, cx); assert.deepEqual(v.runPicked, [], 'x again unselects');
  v.navKey({ key: 'x', modifiers: { shift: true } }, cx);
  assert.deepEqual(v.runPicked, ['a', 'b'], 'X stays inside the repository of the selected result');
  v.navKey({ key: 'j' }, cx); v.navKey({ key: 'j' }, cx); v.navKey({ key: 'j' }, cx); v.navKey({ key: 'x' }, cx);
  assert.equal(v.sel, 'task-e'); assert.deepEqual(v.runPicked, ['a', 'b'], 'work in flight is not selected');
  v.navKey({ key: 'k' }, cx); v.navKey({ key: 'x' }, cx); tree = v.render(cx);
  assert.equal(text(find(tree, 'runs-batch')), '3 selected more than one repository esc Cancel Accept 3');
  assert.equal(find(tree, 'runs-batch-why').ink, t.blocked); assert.equal(find(tree, 'runs-batch-accept').isDisabled, true);
  assert.equal(text(find(tree, 'run-pick-scope')), 'more than one repository');
  v.navKey({ key: 'enter' }, cx); await flush();
  assert.deepEqual(sent('batch'), [], 'two repositories are never accepted together');
  click(find(tree, 'task-pick-c'), cx);
  assert.deepEqual(v.runPicked, ['a', 'b']);

  const done = all.map((item) => (['a', 'b'].includes(item.id) ? { ...item, state: 'accepted' } : item));
  coordinator((payload) => (payload.preview
    ? { stdout: JSON.stringify({ doc: { tasks: all, engine: { enabled: true } }, preview: payload.ids.map((id) => ({ taskId: id, title: `Task ${id}`, outcome: 'accept', nextEffect: 'x' })) }) }
    : (save(done), { stdout: JSON.stringify({ doc: { tasks: done, engine: { enabled: true } } }) })));
  v.navKey({ key: 'enter' }, cx); await flush(); tree = v.render(cx);
  const batch = { action: 'batch', ids: ['a', 'b'], outcome: 'accept', revisions: { a: 'rev-a', b: 'rev-b' } };
  assert.deepEqual(sent('batch'), [{ ...batch, preview: true }, { ...batch, preview: false }]);
  assert.deepEqual(sent('decide'), []);
  assert.deepEqual(fake.notices.map((notice) => [notice.title, notice.body, notice.action.name]), [['Batch accepted · 2 results', 'app · Task a · Task b', 'relevo.workflow-g']]);
  assert.equal(text(find(tree, 'run-notice')), '2 results accepted: Task a, Task b.');
  assert.deepEqual(v.runPicked, []); assert.equal(v.sel, 'task-c'); assert.equal(v.runTask, null);
  assert.equal(text(find(tree, 'run-summary')), '4 tasks: 1 needs you · 1 in flight · 2 done');
  assert.equal(text(find(tree, 'list-keys')), 'j k move open the task esc runs ? keys');
});

test('Esc cancels a selection without leaving the run, and a refused preview accepts nothing', async () => {
  const { v, cx } = await opened([ready('a'), ready('b')]);
  v.navKey({ key: 'X', modifiers: {} }, cx);
  assert.deepEqual(v.runPicked, ['a', 'b']);
  v.navKey({ key: 'escape' }, cx);
  assert.deepEqual(v.runPicked, []); assert.equal(fake.stored['relevo.goals.scope'], 'g');
  v.navKey({ key: 'enter' }, cx); v.render(cx);
  assert.equal(v.runTask, 'a', 'with nothing selected Enter opens the task'); assert.deepEqual(sent('batch'), []);
  v.navKey({ key: 'escape' }, cx); v.render(cx);
  v.navKey({ key: 'x' }, cx); v.navKey({ key: 'j' }, cx); v.navKey({ key: 'x' }, cx);
  fake.exec = (cmd, args) => (/cli\.mjs$/.test(args[0] ?? '') ? { code: 1, stdout: '{"error":"Selected task is stale"}' } : null);
  click(find(v.render(cx), 'runs-batch-accept'), cx); await flush();
  let tree = v.render(cx);
  assert.deepEqual(sent('batch').map((payload) => payload.preview), [true], 'nothing is applied after a refused preview');
  assert.equal(text(find(tree, 'run-error')), 'Action needs attention: Selected task is stale');
  assert.deepEqual(v.runPicked, ['a', 'b']); assert.deepEqual(fake.notices, []);
  coordinator((payload) => ({ stdout: JSON.stringify({ doc: { tasks: v.workflowTasks, engine: { enabled: true } }, preview: payload.preview ? [{ taskId: 'a', title: 'Task a' }] : undefined }) }));
  v.navKey({ key: 'enter' }, cx); await flush(); tree = v.render(cx);
  assert.deepEqual(sent('batch').map((payload) => payload.preview), [true, true], 'a preview of other tasks is not applied');
  assert.equal(text(find(tree, 'run-error')), 'Action needs attention: The preview does not match the selection');
  click(find(tree, 'runs-batch-cancel'), cx);
  assert.deepEqual(v.runPicked, []);
  v.navKey({ key: 'x' }, cx);
  v.workflowTasks = v.workflowTasks.map((item) => (item.id === 'b' ? { ...item, state: 'ready' } : item)); v.render(cx);
  assert.deepEqual(v.runPicked, [], 'a result that stopped waiting leaves the selection');
});

test('an accepted or cancelled task offers Re-run with changes, which the run window opens as a new task with its prompt', async () => {
  const done = task('x', 'accepted', { criteria: 'Rows fit', checks: [['npm', 'test']], maxRounds: 3, maxMinutes: 30, attempts: ready('x').attempts });
  const { v, cx } = await opened([done, task('y', 'cancelled'), ready('a')]);
  click(find(v.render(cx), 'run-rest-fold'), cx); v.sel = 'task-x'; click(find(v.render(cx), 'task-open-x'), cx);
  let tree = v.render(cx);
  assert.equal(text(find(tree, 'task-rerun')), 'Re-run with changes…'); assert.equal(find(tree, 'task-accept'), null);
  click(find(tree, 'task-rerun'), cx);
  assert.deepEqual(windows(), [{ role: 'workflow', goalId: 'g', taskId: 'x', followUp: 'rerun' }]);
  assert.equal(calls(/cli\.mjs/).length, 0, 'preparing sends nothing');
  v.navKey({ key: 'escape' }, cx); v.sel = 'task-y'; click(find(v.render(cx), 'task-open-y'), cx);
  assert.ok(find(v.render(cx), 'task-rerun'));
  v.navKey({ key: 'escape' }, cx); v.sel = 'task-a'; click(find(v.render(cx), 'task-review-a'), cx);
  assert.equal(find(v.render(cx), 'task-rerun'), null, 'a result that still waits has Ask for changes');

  fake.props = { ...asked(), overlay: 'o' }; fake.stored['relevo.runs.mode'] = 'sessions';
  const win = new Workflow(), wcx = fakeCx(); win.init({}, wcx); await flush();
  assert.equal(win.form.title.value(), 'Follow up: Task x');
  assert.equal(win.form.criteria.value(), 'Rows fit\nRequested changes: ');
  assert.deepEqual([win.form.root.value(), win.form.maxRounds.value(), win.form.maxMinutes.value(), win.form.checks.value()], ['/work/app', '3', '30', 'npm test']);
  assert.equal(win.explicitNew, true); assert.equal(win.selected, null); assert.equal(calls(/cli\.mjs/).length, 0);
  win.close();
  const again = new Workflow(); again.init({}, fakeCx()); await flush();
  assert.equal(again.explicitNew, false, "a pane that reloads with the same stamp only selects the task"); assert.equal(again.selected, "x");
  again.close();
  fake.props = { role: 'workflow', goalId: 'g', taskId: 'a', followUp: 'rerun', overlay: 'o' };
  const other = new Workflow(); other.init({}, fakeCx()); await flush();
  assert.equal(other.explicitNew, false, 'a result that still waits is not re-run'); assert.equal(other.selected, 'a');
  other.close();
});

test('Saved setups open in the Runs list: Start fills a new task in the run window, × removes one', async () => {
  const setup = (id, name, more = {}) => ({ id, name, purpose: '', root: '/work/app', executor: writer, reviewer, maxRounds: 3, maxMinutes: 25, checks: [['npm', 'test']], ...more });
  const { v, cx } = await runs([ready('a')]);
  fake.stored[SETUPS_KEY] = { version: 1, items: [setup('s1', 'App'), setup('s2', 'Docs', { root: '/work/docs', maxRounds: 1 })] };
  let tree = v.render(cx);
  assert.equal(text(find(tree, 'runs-setups')), 'Saved setups · 2 Show'); assert.equal(find(tree, 'setup-s1'), null);
  click(find(tree, 'runs-setups-show'), cx); tree = v.render(cx);
  assert.equal(text(find(tree, 'setup-s1')), 'App app · Codex Luna + Team Haiku · 3 attempts Start');
  assert.equal(text(find(tree, 'setup-s2')), 'Docs docs · Codex Luna + Team Haiku · 1 attempt Start');
  assert.equal(find(tree, 'setup-remove-s2').accessibleLabel, 'Remove the setup Docs');
  click(find(tree, 'setup-start-s1'), cx);
  assert.deepEqual(windows(), [{ role: 'workflow', goalId: 'g', setup: 's1' }]);
  assert.equal(calls(/cli\.mjs/).length, 0, 'Start sends nothing');
  click(find(tree, 'setup-remove-s2'), cx); tree = v.render(cx);
  assert.deepEqual(fake.stored[SETUPS_KEY].items.map((item) => item.id), ['s1']);
  assert.equal(find(tree, 'setup-s2'), null); assert.equal(text(find(tree, 'runs-setups')), 'Saved setups · 1 Hide');
  click(find(tree, 'runs-setups-show'), cx);
  assert.equal(find(v.render(cx), 'setup-s1'), null, 'and fold shut again');

  fake.props = { ...asked(), overlay: 'o' }; fake.stored['relevo.runs.mode'] = 'sessions';
  const win = new Workflow(), wcx = fakeCx(); win.init({}, wcx); await flush();
  assert.deepEqual([win.form.root.value(), win.form.maxRounds.value(), win.form.maxMinutes.value(), win.checkPreset], ['/work/app', '3', '25', 'npm-test']);
  assert.equal(win.explicitNew, true); assert.equal(win.selected, null);
  assert.match(win.setupReuseNotice, /^“App” applied · 3 attempts · 25 min per attempt/);
  assert.equal(calls(/cli\.mjs/).length, 0, 'applying a setup starts nothing');
  win.close();
  const again = new Workflow(); again.init({}, fakeCx()); await flush();
  assert.equal(again.setupReuseNotice ?? null, null, 'a reloaded pane does not apply the setup again');
  again.close();
});

test('the ? sheet lists compare, select and accepting a selection', () => {
  const keys = Object.fromEntries(INBOX_SHORTCUT_ACTIONS.filter((action) => action.section === 'Runs').map((action) => [action.id, action.fixedShortcut]));
  assert.deepEqual([keys['runs.compare'], keys['runs.select'], keys['runs.select-repository'], keys['runs.accept-selected'], keys['runs.unselect']], ['c', 'x', 'shift-x', 'enter', 'escape']);
});

test('a selection with a result nobody approved asks for a second Enter before it accepts', async () => {
  const rejected = ready('b'); rejected.attempts = [...rejected.attempts.slice(0, -1), { ...rejected.attempts.at(-1), report: { status: 'changes_requested', summary: '' } }];
  const { v, cx } = await opened([ready('a'), rejected]);
  coordinator((payload) => ({ stdout: JSON.stringify({ doc: { tasks: v.workflowTasks, engine: { enabled: true } }, preview: payload.preview ? payload.ids.map((id) => ({ taskId: id })) : undefined }) }));
  v.navKey({ key: 'X', modifiers: {} }, cx);
  assert.match(text(find(v.render(cx), 'runs-batch')), /1 not approved .*Accept 2$/);
  v.navKey({ key: 'enter' }, cx); await flush();
  assert.deepEqual(sent('batch'), [], 'the first Enter only arms');
  assert.match(text(find(v.render(cx), 'runs-batch')), /Accept 2 anyway$/);
  v.navKey({ key: 'x' }, cx); v.navKey({ key: 'enter' }, cx); await flush();
  assert.deepEqual(sent('batch'), [], 'a changed selection is armed again from the start');
  v.navKey({ key: 'x' }, cx); v.navKey({ key: 'enter' }, cx); v.navKey({ key: 'enter' }, cx); await flush();
  assert.deepEqual(sent('batch').map((payload) => payload.preview), [true, false]);
});
