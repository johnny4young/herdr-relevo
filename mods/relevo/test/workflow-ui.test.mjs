import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, flush, find, click, text } from './fake/ui.mjs';
const { Workflow, openWorkflow } = await import('../workflow.js');
beforeEach(resetFake);
const agent = (address, title) => ({ address, title, status: 'idle', app: 'codex' });
async function setup() { fake.props = { goalId: 'g', overlay: 'o' }; const v = new Workflow(), cx = fakeCx(); v.init({}, cx); await flush(); return { v, cx }; }

test('opens a native workflow overlay and renders task creation without sending commands', async () => {
  openWorkflow('g'); assert.deepEqual(fake.runs.findLast(([name]) => name === 'pane.split')[1], { direction: 'right', mod: 'relevo', props: { role: 'workflow', goalId: 'g' } });
  assert.equal(fake.overlays.length, 0, 'a run is a pane, not a floating window');
  const { v } = await setup(); const tree = v.render();
  assert.match(text(tree), /New task/); assert.ok(find(tree, 'workflow-start-new')); assert.equal(fake.execs.length, 0);
  assert.ok(find(tree, 'workflow-dialog')); v.close();
});

test('create validates two connected agents and sends the explicit task contract', async () => {
  const { v, cx } = await setup(); fake.agents = [agent('agent:one', 'One'), agent('agent:two', 'Two')];
  v.form.title.set_value('Implement search'); v.form.root.set_value('/work/app'); v.form.criteria.set_value('Search works'); v.executor = 'agent:one'; v.reviewer = 'agent:two';
  v.setupReuseNotice = 'Old reuse notice'; v.setupReuseWarning = 'Old reuse warning';
  fake.exec = async (_cmd, args) => { const payload = JSON.parse(args.at(-1)); assert.equal(payload.action, 'create'); assert.equal(payload.task.root, '/work/app'); assert.equal(payload.task.executor.address, 'agent:one'); assert.equal(payload.task.maxRounds, 2); assert.equal(payload.task.maxMinutes, 20); fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({ tasks: [{ id: 'created-task', goalId: 'g', title: 'Implement search', state: 'planned' }], events: [], preferences: [], engine: { enabled: false } }); return { stdout: '{"doc":{},"result":{"taskId":"created-task"}}' }; };
  v.create(cx); await flush(); assert.equal(fake.execs.length, 1); assert.equal(v.error, null); assert.equal(v.selected, 'created-task'); assert.equal(v.form.title.value(), '');
  assert.equal(v.setupReuseNotice, null); assert.equal(v.setupReuseWarning, null); v.close();
});

test('agent setup searches the selected repository and prevents choosing one agent for both roles', async () => {
  const { v, cx } = await setup();
  fake.agents = [
    { ...agent('builder', 'Build session'), cwd: '/work/app' },
    { ...agent('reviewer', 'Independent review'), cwd: '/work/app' },
    { ...agent('foreign', 'Other project'), cwd: '/work/elsewhere' },
  ];
  v.taskSetupOpen = true; v.form.root.set_value('/work/app'); v.executor = 'builder';
  let tree = v.render();
  assert.equal(find(tree, 'workflow-reviewer-builder').isDisabled, true);
  assert.equal(find(tree, 'workflow-reviewer-foreign'), null);
  v.form.reviewerSearch.type('independent', cx);
  tree = v.render();
  assert.ok(find(tree, 'workflow-reviewer-reviewer'));
  assert.equal(find(tree, 'workflow-reviewer-builder'), null);
  click(find(tree, 'workflow-reviewer-reviewer'), cx);
  assert.equal(v.reviewer, 'reviewer');
  v.form.root.type('/work/elsewhere', cx);
  assert.equal(v.executor, ''); assert.equal(v.reviewer, '');
  assert.equal(fake.execs.length, 0, 'selecting and searching never dispatches work');
  v.close();
});

test('reuse copies only this mission’s latest successful setup after an explicit click', async () => {
  const { v, cx } = await setup();
  const old = { id: 'old', goalId: 'g', title: 'Earlier result', state: 'accepted', root: '/work/app',
    executor: { address: 'builder', label: 'Builder' }, reviewer: { address: 'reviewer', label: 'Reviewer' },
    maxRounds: 4, maxMinutes: 33, checks: [['npm', 'test']] };
  v.tasks = [old, { ...old, id: 'other-goal', goalId: 'other', root: '/wrong/goal', maxRounds: 1 }];
  v.explicitNew = true;
  fake.agents = [{ ...agent('builder', 'Builder'), cwd: '/work/app' }, { ...agent('reviewer', 'Reviewer'), cwd: '/work/app' }];
  v.form.title.set_value('New title'); v.form.criteria.set_value('New outcome');
  let tree = v.render();
  assert.ok(find(tree, 'workflow-previous-setup')); assert.ok(find(tree, 'workflow-use-previous-setup'));
  const preview = text(find(tree, 'workflow-previous-setup'));
  assert.match(preview, /Previous setup · app · Builder \+ Reviewer/);
  assert.ok(!preview.includes('/work/app') && !preview.includes('Earlier result'));
  assert.match(find(tree, 'workflow-use-previous-setup').tip, /Earlier result.*\/work\/app.*4 rounds.*33 minutes/);
  click(find(tree, 'workflow-use-previous-setup'), cx); tree = v.render();
  assert.equal(v.form.title.value(), 'New title'); assert.equal(v.form.criteria.value(), 'New outcome');
  assert.equal(v.form.root.value(), '/work/app'); assert.equal(v.executor, 'builder'); assert.equal(v.reviewer, 'reviewer');
  assert.equal(v.form.maxRounds.value(), '4'); assert.equal(v.form.maxMinutes.value(), '33'); assert.equal(v.checkPreset, 'npm-test');
  assert.match(text(tree), /Previous setup applied\. Review repository and agents before creating\./);
  assert.equal(v.taskAdvancedOpen, false, 'known presets do not expand limits and dependencies automatically');
  assert.equal(fake.execs.length, 0); v.close();
});

test('reuse never silently restores disconnected agents and accepts a reviewed result as successful', async () => {
  const { v, cx } = await setup();
  v.tasks = [{ id: 'needs-you', goalId: 'g', title: 'Reviewed result', state: 'needs_you', root: '/work/app',
    executor: { address: 'missing-builder', label: 'Old builder' }, reviewer: { address: 'reviewer', label: 'Reviewer' },
    maxRounds: 3, maxMinutes: 28, checks: [['pnpm', 'lint']], checksResult: [{ code: 0 }], revision: 'r2',
    attempts: [{ role: 'reviewer', state: 'reported', revision: 'r2', report: { status: 'completed' } }] }];
  v.explicitNew = true;
  fake.agents = [{ ...agent('reviewer', 'Reviewer'), cwd: '/work/app' }];
  assert.ok(find(v.render(), 'workflow-use-previous-setup'));
  click(find(v.render(), 'workflow-use-previous-setup'), cx);
  assert.equal(v.executor, ''); assert.equal(v.reviewer, 'reviewer');
  assert.match(v.setupReuseWarning, /Old builder.*unavailable/);
  assert.equal(v.checkPreset, 'custom'); assert.equal(v.form.checks.value(), '[["pnpm","lint"]]');
  assert.equal(v.taskAdvancedOpen, true, 'custom checks open for direct review');
  v.form.root.type('/work/other', cx);
  assert.equal(v.setupReuseNotice, null); assert.equal(v.setupReuseWarning, null);
  assert.equal(fake.execs.length, 0); v.close();
});

test('task check presets send explicit argv and preserve custom JSON while switching presets', async () => {
  const { v, cx } = await setup(); fake.agents = [agent('agent:one', 'One'), agent('agent:two', 'Two')];
  v.form.title.set_value('Add coverage'); v.form.root.set_value('/work/app'); v.form.criteria.set_value('Coverage works'); v.executor = 'agent:one'; v.reviewer = 'agent:two';
  const sent = [];
  fake.exec = async (_cmd, args) => { sent.push(JSON.parse(args.at(-1)).task.checks); return { stdout: '{"doc":{},"result":{"taskId":"created"}}' }; };
  v.checkPreset = 'npm-test'; v.create(cx); await flush();
  assert.deepEqual(sent.at(-1), [['npm', 'test']]);
  v.close();
  const next = await setup(); const w = next.v;
  fake.agents = [agent('agent:one', 'One'), agent('agent:two', 'Two')];
  w.form.title.set_value('Custom task'); w.form.root.set_value('/work/app'); w.form.criteria.set_value('Coverage works'); w.executor = 'agent:one'; w.reviewer = 'agent:two';
  w.checkPreset = 'custom'; w.form.checks.set_value('[["pnpm","lint"],["pnpm","test"]]');
  w.checkPreset = 'none'; assert.equal(w.form.checks.value(), '[["pnpm","lint"],["pnpm","test"]]');
  w.checkPreset = 'custom';
  w.create(next.cx); await flush();
  assert.deepEqual(sent.at(-1), [['pnpm', 'lint'], ['pnpm', 'test']]);
  w.close();
});

test('keeps validation and command failures visible and closed views ignore late errors', async () => {
  const { v, cx } = await setup(); v.create(cx); assert.match(v.error, /two different connected agents/);
  fake.agents = [agent('a', 'A'), agent('b', 'B')]; v.form.title.set_value('T'); v.form.root.set_value('/repo'); v.form.criteria.set_value('Expected outcome'); v.executor = 'a'; v.reviewer = 'b'; fake.exec = async () => ({ code: 1, stderr: 'offline' });
  v.create(cx); await flush(); assert.match(v.error, /offline/);
  v.close();
});

test('shows activity and evidence actions only on selection and handles Escape', async () => {
  fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({ tasks: [{ id: 'task-1', goalId: 'g', title: 'Build', state: 'running', evidence: [{ id: 'e1', kind: 'report', path: '/tmp/report.md', label: 'Report' }] }], events: [{ goalId: 'g', taskId: 'task-1', type: 'started', detail: 'Started' }] });
  const { v, cx } = await setup(); v.selected = 'task-1'; v.tab = 'Activity';
  assert.match(text(v.render()), /Who did what/);
  click(find(v.render(), 'workflow-event-log'), cx);
  assert.match(text(v.render()), /Started/);
  v.tab = 'Evidence'; let tree = v.render(); assert.ok(find(tree, 'workflow-remove-e1')); assert.ok(find(tree, 'workflow-open-e1'));
  assert.equal(find(tree, 'workflow-path'), null, 'evidence is readable before opening the attachment form');
  click(find(tree, 'workflow-evidence-add'), cx); tree = v.render(); assert.ok(find(tree, 'workflow-attach-report'));
  click(find(tree, 'workflow-new-task'), cx); tree = v.render(); assert.ok(find(tree, 'workflow-title'));
  v.selected = 'task-1'; v.h.is_focused = () => false; tree = v.render();
  const escape = find(tree, 'workflow-dialog').handlers['on_key_down'];
  v.form.title.set_value('Unsent title');
  escape({ key: 'escape' }, cx);
  assert.equal(fake.closedOverlays.length, 0); assert.equal(v.form.title.value(), 'Unsent title');
  v.h.is_focused = () => true;
  escape({ key: 'escape' }, cx);
  assert.equal(fake.runs.some(([name]) => name === 'pane.close'), false, 'Escape never closes the pane'); v.close();
});

test('blocked and review states remain reachable and shortcuts do not steal input keys', async () => {
  fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({ tasks: [
    { id: 'blocked', goalId: 'g', title: 'Blocked task', state: 'blocked' },
    { id: 'review', goalId: 'g', title: 'In review', state: 'needs_review' },
  ], events: [] });
  const { v, cx } = await setup(); let tree = v.render();
  assert.ok(find(tree, 'workflow-task-blocked'));
  v.filter = 'In progress'; tree = v.render(); assert.ok(find(tree, 'workflow-task-review'));
  v.selected = 'review'; v.h.is_focused = () => false;
  find(v.render(), 'workflow-dialog').handlers.on_key_down({ key: 'n' }, cx); assert.equal(v.selected, 'review');
  v.h.is_focused = () => true; find(v.render(), 'workflow-dialog').handlers.on_key_down({ key: '?' }, cx);
  assert.ok(find(v.render(), 'shortcut-help-search')); v.close();
});

test('Mission shortcut search filters actual window actions and Escape clears then closes help', async () => {
  const { v, cx } = await setup();
  click(find(v.render(), 'workflow-focus-queue'), cx);
  v.shortcutHelp.input.type('evidence', cx);
  let help = find(v.render(), 'shortcut-help');
  assert.match(text(help), /Evidence 3/); assert.ok(!text(help).includes('New task'));
  find(v.render(), 'workflow-dialog').handlers.on_key_down({ key: 'escape' }, cx);
  assert.equal(v.showHelp, true); assert.equal(v.shortcutHelp.query, '');
  find(v.render(), 'workflow-dialog').handlers.on_key_down({ key: 'escape' }, cx);
  assert.equal(v.showHelp, false); assert.equal(fake.closedOverlays.length, 0);
  assert.equal(fake.execs.length, 0); v.close();
});

test('exhausted blocked work offers a review and a follow-up draft without retry or resume commands', async () => {
  const old = { id: 'blocked', goalId: 'g', title: 'Implement search', state: 'blocked', root: '/repo', criteria: 'Search works',
    executor: { address: 'builder', label: 'Builder' }, reviewer: { address: 'reviewer', label: 'Reviewer' }, checks: [['npm', 'test']],
    checksResult: [{ argv: ['npm', 'test'], code: 0 }], round: 1, maxRounds: 1, maxMinutes: 12, revision: 'rev-1', dependsOn: ['prerequisite', 'blocked'],
    attempts: [
      { id: 'impl', role: 'executor', state: 'reported', report: { status: 'completed', summary: 'Added search behavior.' } },
      { id: 'review-1', role: 'reviewer', state: 'reported', revision: 'rev-1', report: { status: 'changes_requested', summary: 'Search ignores case and has no empty state.' } },
      { id: 'review-2', role: 'reviewer', state: 'reported', revision: 'rev-1', report: { status: 'changes_requested', summary: 'Latest finding: preserve the query when returning from results.' } },
    ] };
  fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({ tasks: [
    { id: 'prerequisite', goalId: 'g', title: 'Prerequisite', state: 'needs_you' }, old,
  ], events: [] });
  const { v, cx } = await setup(); v.selected = old.id;
  let tree = v.render();
  assert.equal(find(tree, 'workflow-action-retry-review'), null);
  assert.equal(find(tree, 'workflow-action-start'), null);
  assert.equal(find(tree, 'workflow-action-resume'), null);
  assert.ok(find(tree, 'workflow-prepare-follow-up'));
  assert.equal(find(tree, 'workflow-review-findings'), null, 'findings use the existing result navigation action');
  assert.equal((text(tree).match(/Findings/g) ?? []).length, 1);
  assert.ok(!text(tree).includes('Added search behavior.'), 'executor success does not obscure blocked reviewer findings on the overview');
  assert.match(text(tree), /Changes requested/);
  assert.match(text(tree), /Latest finding: preserve the query/);
  click(find(tree, 'workflow-prepare-follow-up'), cx);
  tree = v.render();
  assert.ok(find(tree, 'workflow-title')); assert.ok(find(tree, 'workflow-create'));
  assert.equal(v.form.title.value(), 'Follow up: Implement search');
  assert.equal(v.form.root.value(), '/repo');
  assert.match(v.form.criteria.value(), /Search works/);
  assert.match(v.form.criteria.value(), /Latest reviewer findings: Latest finding: preserve the query/);
  assert.equal(v.form.checks.value(), '[["npm","test"]]');
  assert.equal(v.form.maxRounds.value(), '1'); assert.equal(v.form.maxMinutes.value(), '12');
  assert.equal(v.executor, 'builder'); assert.equal(v.reviewer, 'reviewer');
  assert.deepEqual(v.dependsOn, ['prerequisite'], 'preserve prior prerequisites and never make the blocked source its own prerequisite');
  assert.equal(fake.execs.length, 0, 'preparing and inspecting a follow-up never sends or starts work');
  assert.deepEqual(v.tasks.find((task) => task.id === old.id), old, 'the blocked task remains in the task list unchanged');
  v.close();
});

test('retry controls appear only while coordinator attempt budgets and state guards allow them', async () => {
  const { v } = await setup();
  const base = { id: 'task', title: 'Task', root: '/repo', revision: 'rev', checksResult: [{ code: 0 }], maxRounds: 2,
    attempts: [{ id: 'review', role: 'reviewer', state: 'reported', revision: 'older-revision', report: { status: 'changes_requested', summary: 'Fix it.' } }] };
  v.tasks = [{ ...base, state: 'blocked', round: 1 }]; v.selected = 'task';
  let tree = v.render(); assert.ok(find(tree, 'workflow-action-retry-review')); assert.ok(find(tree, 'workflow-action-start'));
  v.tasks = [{ ...base, state: 'blocked', round: 2, attempts: [base.attempts[0], { ...base.attempts[0], id: 'review-2' }, { ...base.attempts[0], id: 'review-3' }] }];
  tree = v.render(); assert.equal(find(tree, 'workflow-action-retry-review'), null); assert.equal(find(tree, 'workflow-action-start'), null);
  v.tasks = [{ ...base, state: 'blocked', round: 1, attempts: [{ ...base.attempts[0], delivery: 'uncertain' }] }];
  tree = v.render(); assert.ok(find(tree, 'workflow-action-retry-review'), 'the coordinator permits review retry when a report exists and its retry budget remains'); assert.equal(find(tree, 'workflow-action-start'), null);
  v.tasks = [{ ...base, state: 'blocked', round: 1, paused: true }];
  tree = v.render(); assert.equal(find(tree, 'workflow-action-start'), null); assert.ok(find(tree, 'workflow-action-resume'));
  v.tasks = [{ ...base, state: 'blocked', round: 2, attempts: [{ ...base.attempts[0] }, { ...base.attempts[0], id: 'review-2' }, { ...base.attempts[0], id: 'review-3', state: 'running' }] }];
  tree = v.render(); assert.equal(find(tree, 'workflow-prepare-follow-up'), null, 'do not offer a follow-up while an attempt can still report');
  v.tasks = [{ ...base, state: 'blocked', round: 2, attempts: [{ ...base.attempts[0] }, { ...base.attempts[0], id: 'review-2' }, { ...base.attempts[0], id: 'review-3', delivery: 'uncertain' }] }];
  tree = v.render(); assert.equal(find(tree, 'workflow-prepare-follow-up'), null, 'resolve uncertain delivery before drafting more work');
  v.close();
});

test('preferences stay pending until accepted and show unavailable metrics with no accepted tasks', async () => {
  fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({ tasks: [], events: [], preferences: [
    { id: 'p1', status: 'pending', scope: 'goal', scopeId: 'g', text: 'Keep changes focused' },
  ] });
  const { v } = await setup(); v.tab = 'Preferences'; const tree = v.render();
  assert.match(text(tree), /unavailable/); assert.match(text(tree), /pending · goal/); assert.match(text(tree), /Accepted guidance applies/); v.close();
});

test('reopening selects the first goal task, while explicit New task survives refresh polling', async () => {
  fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({ tasks: [
    { id: 'needs-you', goalId: 'g', title: 'Needs decision', state: 'needs_you' },
    { id: 'planned', goalId: 'g', title: 'Later', state: 'planned' },
  ], events: [], preferences: [], engine: { enabled: false } });
  const { v, cx } = await setup();
  assert.equal(v.selected, 'needs-you');
  click(find(v.render(), 'workflow-new-task'), cx);
  assert.equal(v.explicitNew, true); assert.equal(v.selected, null);
  v.load(cx); await flush(); assert.equal(v.selected, null); assert.ok(find(v.render(), 'workflow-title'));
  v.close();
});

test('every task state produces native-compatible children, including absent optional controls', async () => {
  const {v}=await setup();
  const check=(node)=>{ assert.notEqual(node,null,'native GPUI does not accept null children'); assert.notEqual(node,undefined); for(const child of node?.items??[])check(child); };
  for(const state of ['planned','running','needs_review','needs_you','blocked','accepted','cancelled']) {
    v.tasks=[{id:'native-check',goalId:'g',title:'Task',state,criteria:'Expected result',attempts:[],checksResult:[],messages:[],evidence:[]}];v.selected='native-check';
    for(const tab of ['Overview','Activity','Changes','Evidence','Preferences','Tools']) {v.tab=tab;check(v.render());}
  }
  v.close();
});

test('the first screen explains the decision and keeps sessions and messaging secondary', async () => {
  const { v, cx } = await setup();
  v.tasks = [{ id: 'result', goalId: 'g', title: 'Search', state: 'needs_you', round: 1, maxRounds: 2,
    executor: { address: 'builder' }, reviewer: { address: 'reviewer' }, revision: 'current',
    checksResult: [{ code: 0 }], attempts: [{ role: 'executor', report: { summary: 'Search implemented' } }] }];
  v.selected = 'result'; let tree = v.render();
  assert.match(text(tree), /Ready for your review/); assert.match(text(tree), /Search implemented/);
  assert.match(text(tree), /✓ Checks 1\/1 passed/);
  assert.ok(find(tree, 'workflow-decide-accept')); assert.ok(find(tree, 'workflow-tab-Changes'));
  assert.equal(find(tree, 'workflow-inspect-result'), null); assert.equal(find(tree, 'workflow-inspect-evidence'), null);
  assert.ok(find(tree, 'workflow-tab-Evidence'));
  assert.equal(find(tree, 'workflow-message'), null); assert.equal(find(tree, 'workflow-focus-executor'), null);
  assert.equal(find(tree, 'workflow-decision'), null);
  click(find(tree, 'workflow-details-toggle'), cx); tree = v.render();
  assert.equal(find(tree, 'workflow-message'), null);
  click(find(tree, 'workflow-task-tools'), cx); tree = v.render();
  assert.ok(find(tree, 'workflow-tool-executor'));
  click(find(tree, 'workflow-tool-message'), cx); assert.ok(find(v.render(), 'workflow-message'));
  click(find(v.render(), 'workflow-tools-back'), cx); tree = v.render();
  click(find(tree, 'workflow-tab-Changes'), cx); assert.equal(v.tab, 'Changes');
  assert.ok(find(v.render(), 'workflow-decide-accept'), 'decision remains reachable after reading reports');
  assert.equal(fake.execs.length, 0); v.close();
});

test('check summary distinguishes partial evidence, failure and a fresh implementation round', async () => {
  const { v } = await setup();
  const task = { id: 'checks', goalId: 'g', title: 'Verify result', state: 'blocked',
    checks: [['node', '--test'], ['npm', 'run', 'lint']], checksResult: [{ code: 0 }], attempts: [] };
  v.tasks = [task]; v.selected = task.id;
  assert.match(text(v.render()), /Checks · 1\/2 passed · incomplete/);
  task.checksResult.push({ code: 1 });
  assert.match(text(v.render()), /✗ Checks 1 failed · 1\/2 passed/);
  task.state = 'running'; task.attempts = [{ role: 'executor', state: 'running' }];
  assert.match(text(v.render()), /Checks · awaiting checks/);
  assert.equal(fake.execs.length, 0, 'summarizing evidence never starts work');
  v.close();
});

test('requesting changes previews the next effect and requires explicit feedback submission', async () => {
  const { v, cx } = await setup();
  v.tasks = [{ id: 'result', goalId: 'g', title: 'Search', state: 'needs_you', round: 1, maxRounds: 2, revision: 'current' }];
  v.selected = 'result'; click(find(v.render(), 'workflow-decide-changes'), cx);
  let tree = v.render(); assert.equal(fake.execs.length, 0);
  assert.match(text(tree), /another implementation and review round/);
  assert.equal(find(tree, 'workflow-send-changes').isDisabled, true);
  assert.equal(find(tree, 'workflow-decide-accept'), null, 'the change request replaces the decision buttons');
  v.form.decision.set_value('Handle empty results');
  fake.exec = async (_command, args) => {
    assert.deepEqual(JSON.parse(args.at(-1)), { action: 'decide', taskId: 'result', outcome: 'changes', text: 'Handle empty results', revision: 'current' });
    return { stdout: '{}' };
  };
  click(find(v.render(), 'workflow-send-changes'), cx); await flush();
  assert.equal(fake.execs.length, 1); assert.equal(v.form.decision.value(), '');
  assert.equal(v.requestChangesFor, null); v.close();
});

test('optional notes cancel without sending and an exhausted task prepares an explicit follow-up', async () => {
  const { v, cx } = await setup();
  v.tasks = [{ id: 'result', goalId: 'g', title: 'Search', state: 'needs_you', round: 2, maxRounds: 2 }]; v.selected = 'result';
  assert.equal(find(v.render(), 'workflow-decide-changes').isDisabled, false);
  click(find(v.render(), 'workflow-decision-note-toggle'), cx); v.form.decision.set_value('Unsent thought');
  click(find(v.render(), 'workflow-decision-note-cancel'), cx);
  assert.equal(v.form.decision.value(), ''); assert.equal(find(v.render(), 'workflow-decision'), null);
  click(find(v.render(), 'workflow-decide-changes'), cx); v.form.decision.set_value('Add an empty state');
  assert.match(text(v.render()), /prepares a follow-up task for you to start/);
  click(find(v.render(), 'workflow-send-changes'), cx);
  assert.equal(v.selected, null); assert.equal(v.explicitNew, true);
  assert.match(v.form.criteria.value(), /Requested changes: Add an empty state/);
  assert.equal(v.tasks[0].state, 'needs_you');
  assert.equal(fake.execs.length, 0); v.close();
});

test('decision drafts cannot leak from one task into another task', async () => {
  const { v, cx } = await setup();
  const a = { id: 'a' }, b = { id: 'b' };
  v.editDecisionNote(a, false, cx); v.form.decision.set_value('Only for A');
  v.editDecisionNote(b, true, cx); assert.equal(v.form.decision.value(), '');
  v.editDecisionNote(a, false, cx); assert.equal(v.form.decision.value(), 'Only for A'); v.close();
});

test('number shortcuts follow the visible tab order and Escape keeps an input draft', async () => {
  const { v, cx } = await setup();
  v.tasks = [{ id: 'result', goalId: 'g', title: 'Result', state: 'needs_you' }]; v.selected = 'result';
  v.h.is_focused = () => true;
  for (const [index, tab] of ['Overview', 'Changes', 'Evidence', 'Activity', 'Preferences'].entries()) {
    find(v.render(), 'workflow-dialog').handlers.on_key_down({ key: String(index + 1) }, cx);
    assert.equal(v.tab, tab);
  }
  v.tab = 'Overview'; v.editDecisionNote(v.tasks[0], true, cx); v.form.decision.set_value('Keep this feedback');
  let focused = false; v.h.is_focused = () => focused; v.h.focus = () => { focused = true; };
  find(v.render(), 'workflow-dialog').handlers.on_key_down({ key: 'escape' }, cx);
  assert.equal(focused, true); assert.equal(v.form.decision.value(), 'Keep this feedback');
  assert.equal(v.requestChangesFor, 'result'); assert.equal(fake.closedOverlays.length, 0);
  assert.equal(fake.execs.length, 0); v.close();
});

test('compact review preserves full context on demand without dispatching or implying missing evidence passed', async () => {
  const { v, cx } = await setup();
  const title = 'Review the complete result '.repeat(12);
  const reviewerSummary = 'A detailed independent report that belongs in Result.';
  v.tasks = [{ id: 'result', goalId: 'g', title, state: 'needs_you', attempts: [
    { id: 'review', role: 'reviewer', report: { status: 'blocked', summary: reviewerSummary } },
  ] }]; v.selected = 'result'; v.engine = { enabled: true };
  let tree = v.render();
  assert.match(text(tree), /Checks · not configured ✗ Review blocked/);
  assert.ok(!text(tree).includes(reviewerSummary));
  assert.ok(!text(find(tree, 'workflow-outcome-header')).includes(title), 'long assignments are disclosed instead of dominating the first screen');
  assert.equal(find(tree, 'workflow-engine-stop'), null);
  click(find(tree, 'workflow-tools-toggle'), cx); tree = v.render();
  assert.ok(find(tree, 'workflow-engine-stop')); assert.ok(find(tree, 'workflow-tab-Preferences'));
  click(find(tree, 'workflow-details-toggle'), cx); assert.ok(text(v.render()).includes(title));
  click(find(v.render(), 'workflow-tab-Changes'), cx); assert.ok(text(v.render()).includes(reviewerSummary));
  assert.equal(fake.execs.length, 0); v.close();
});

test('acceptance from reports immediately advances to the next decision without a navigation click', async () => {
  const a = { id: 'a', goalId: 'g', title: 'First', state: 'needs_you', revision: 'r1' };
  const b = { id: 'b', goalId: 'g', title: 'Second', state: 'needs_you', revision: 'r2' };
  const file = '/home/test/.config/herdr-app/relevo-workflow/state.json';
  fake.files[file] = JSON.stringify({ tasks: [a, b] });
  const { v, cx } = await setup(); v.tab = 'Changes';
  fake.exec = async () => { const doc = { tasks: [{ ...a, state: 'accepted' }, b] }; fake.files[file] = JSON.stringify(doc); return { stdout: JSON.stringify({ doc }) }; };
  click(find(v.render(), 'workflow-decide-accept'), cx); await flush();
  assert.equal(v.selected, 'b'); assert.equal(v.tab, 'Overview'); assert.equal(v.filter, 'Needs you');
  assert.match(text(v.render()), /Acceptance saved/); assert.equal(find(v.render(), 'workflow-task-a'), null);
  assert.ok(find(v.render(), 'workflow-task-b')); v.close();
});

test('accepting the last task shows completion, persists across reopening, and keeps history accessible', async () => {
  const a = { id: 'a', goalId: 'g', title: 'First', state: 'needs_you', revision: 'r1' };
  const file = '/home/test/.config/herdr-app/relevo-workflow/state.json';
  fake.files[file] = JSON.stringify({ tasks: [a] }); const { v, cx } = await setup();
  fake.exec = async () => { const doc = { tasks: [{ ...a, state: 'accepted' }] }; fake.files[file] = JSON.stringify(doc); return { stdout: JSON.stringify({ doc }) }; };
  click(find(v.render(), 'workflow-decide-accept'), cx); await flush();
  assert.equal(v.selected, null); assert.match(text(v.render()), /You're all caught up/);
  assert.equal(find(v.render(), 'workflow-tab-Overview'), null); assert.equal(find(v.render(), 'workflow-title'), null);
  click(find(v.render(), 'workflow-view-history'), cx); assert.equal(v.selected, 'a');
  assert.match(text(v.render()), /Accepted and saved in History/); v.close();
  const reopened = await setup(); assert.equal(reopened.v.selected, null); assert.match(text(reopened.v.render()), /You're all caught up/); reopened.v.close();
});

test('filters keep selection consistent and failed work remains actionable rather than completed', async () => {
  const { v, cx } = await setup();
  v.tasks = [{ id: 'a', state: 'accepted', title: 'Accepted' }, { id: 'b', state: 'failed', title: 'Failed' }];
  v.selectFilter('Completed', cx); assert.equal(v.selected, 'a');
  v.selectFilter('Needs you', cx); assert.equal(v.selected, 'b');
  v.selectFilter('In progress', cx); assert.equal(v.selected, null); assert.match(text(v.render()), /No work in progress/); v.close();
});

test('task creation discloses setup only when needed and keeps the draft through validation', async () => {
  const { v, cx } = await setup();
  assert.ok(find(v.render(), 'workflow-title')); assert.ok(find(v.render(), 'workflow-criteria'));
  assert.equal(find(v.render(), 'workflow-root'), null); assert.equal(find(v.render(), 'workflow-checks'), null);
  v.form.title.set_value('Add search'); v.form.criteria.set_value('Find matching items');
  click(find(v.render(), 'workflow-create'), cx);
  assert.ok(find(v.render(), 'workflow-root')); assert.equal(v.form.title.value(), 'Add search');
  assert.equal(fake.execs.length, 0);
  fake.agents = [agent('a', 'A'), agent('b', 'B')];
  v.form.root.set_value('/work'); v.executor = 'a'; v.reviewer = 'b'; v.checkPreset = 'custom'; v.form.checks.set_value('invalid json');
  v.create(cx); assert.ok(find(v.render(), 'workflow-checks'));
  assert.equal(v.form.criteria.value(), 'Find matching items'); assert.equal(fake.execs.length, 0); v.close();
});

test('Tools search and skill preview never send until explicit queue confirmation', async () => {
  const { v, cx } = await setup();
  v.tasks = [{ id: 'a', goalId: 'g', title: 'Search', state: 'needs_you', executor: { address: 'builder' } }]; v.selected = 'a';
  click(find(v.render(), 'workflow-task-tools'), cx);
  v.form.toolSearch.type('fix', cx);
  let tree = v.render(); assert.equal(find(tree, 'workflow-tool-result'), null);
  assert.ok(find(tree, 'workflow-tool-skill-fix'));
  click(find(tree, 'workflow-tool-skill-fix'), cx);
  assert.match(text(v.render()), /Recipient: builder/); assert.match(text(v.render()), /may change the pending result/);
  assert.equal(fake.execs.length, 0);
  click(find(v.render(), 'workflow-tool-cancel'), cx); assert.equal(find(v.render(), 'workflow-tool-confirm'), null);
  click(find(v.render(), 'workflow-tool-skill-fix'), cx);
  fake.exec = async (_command, args) => {
    assert.deepEqual(JSON.parse(args.at(-1)), { action: 'skill', taskId: 'a', skill: 'fix-ci', mode: 'queue' });
    return { stdout: '{}' };
  };
  click(find(v.render(), 'workflow-tool-confirm'), cx); await flush();
  assert.equal(fake.execs.length, 1); assert.equal(v.toolPreview, null); v.close();
});

test('Tools keyboard escape returns to the result, isolates task previews and protects typing', async () => {
  const { v, cx } = await setup();
  v.tasks = [{ id: 'a', title: 'A', state: 'running' }, { id: 'b', title: 'B', state: 'accepted' }]; v.selected = 'a';
  v.h.is_focused = () => false;
  find(v.render(), 'workflow-dialog').handlers.on_key_down({ key: 't' }, cx); assert.equal(v.tab, 'Overview');
  v.h.is_focused = () => true;
  find(v.render(), 'workflow-dialog').handlers.on_key_down({ key: 't' }, cx); assert.equal(v.tab, 'Tools');
  click(find(v.render(), 'workflow-tool-skill-review'), cx); assert.ok(find(v.render(), 'workflow-tool-confirm'));
  v.selected = 'b'; assert.equal(find(v.render(), 'workflow-tool-confirm'), null);
  assert.equal(find(v.render(), 'workflow-tool-skill-review').isDisabled, true);
  assert.equal(find(v.render(), 'workflow-tool-message').isDisabled, true);
  v.h.is_focused = () => false;
  find(v.render(), 'workflow-dialog').handlers.on_key_down({ key: 'escape' }, cx);
  assert.equal(v.tab, 'Overview'); assert.equal(fake.closedOverlays.length, 0); assert.equal(fake.execs.length, 0); v.close();
});

test('Activity distinguishes actual delivery and reports without inventing autonomous agent calls', async () => {
  const { v, cx } = await setup();
  v.tasks = [{ id: 'a', title: 'A', state: 'blocked', attempts: [
    { id: 'one', role: 'executor', address: 'builder', delivery: 'acknowledged', state: 'reported', prompt: 'Exact assignment', report: { status: 'completed', summary: 'Implementation report' } },
    { id: 'two', role: 'reviewer', address: 'reviewer', delivery: 'uncertain', state: 'running', prompt: 'Review assignment' },
  ] }]; v.selected = 'a'; v.tab = 'Activity';
  let tree = v.render();
  assert.match(text(tree), /Coordinator → Implementer/); assert.match(text(tree), /Report: Completed/);
  assert.match(text(tree), /Coordinator → Reviewer/); assert.match(text(tree), /Delivery uncertain/);
  assert.match(text(tree), /No acceptance recorded/); assert.ok(!text(tree).includes('Exact assignment'));
  click(find(tree, 'workflow-prompt-toggle-one'), cx); assert.match(text(v.render()), /Exact assignment/);
  assert.equal(fake.execs.length, 0); v.close();
});

test('message drafts remain bound to the selected task and clear only after success', async () => {
  const { v, cx } = await setup();
  v.tasks = [{ id: 'a', title: 'A', state: 'running' }, { id: 'b', title: 'B', state: 'running' }]; v.selected = 'a'; v.openTools(cx);
  click(find(v.render(), 'workflow-tool-message'), cx); v.form.message.set_value('Only A');
  v.selected = 'b'; click(find(v.render(), 'workflow-tool-message'), cx); assert.equal(v.form.message.value(), '');
  v.form.message.set_value('Only B'); v.selected = 'a'; click(find(v.render(), 'workflow-tool-message'), cx); assert.equal(v.form.message.value(), 'Only A');
  fake.exec = async () => ({ code: 1, stderr: 'offline' });
  click(find(v.render(), 'workflow-message-queue'), cx); await flush(); assert.equal(v.form.message.value(), 'Only A');
  fake.exec = async () => ({ stdout: '{}' });
  click(find(v.render(), 'workflow-message-queue'), cx); await flush(); assert.equal(v.form.message.value(), ''); v.close();
});

test('a new prompt-only run opens agent setup directly without a plan or dispatch', async () => {
  const { newGoal, saveGoal, emptyGoals } = await import('../lib/goals.js');
  const goal = { ...newGoal('g', 'Add keyboard search'), criteria: 'Add keyboard search\nKeep the existing filters.' };
  fake.focused = { cwd: '/work/app' };
  fake.panes = [{ cwd: '/work/app' }, { cwd: '/work/other' }];
  fake.files['/home/test/.config/herdr-app/relevo-goals.json'] = JSON.stringify(saveGoal(emptyGoals(), goal, 0));
  const { v, cx } = await setup();
  assert.equal(v.tab, 'Overview'); assert.equal(v.taskSetupOpen, true);
  assert.equal(v.form.title.value(), goal.title); assert.equal(v.form.criteria.value(), goal.criteria);
  assert.equal(fake.execs.length, 0);
  assert.match(text(v.render()), /Start run/);
  assert.doesNotMatch(text(v.render()), /WORK QUEUE/);
  assert.equal(v.form.root.value(), '/work/app');
  assert.ok(find(v.render(), 'workflow-change-repository'));
  click(find(v.render(), 'workflow-change-repository'), cx);
  click(find(v.render(), 'workflow-repository-1'), cx);
  assert.equal(v.form.root.value(), '/work/other');
  assert.ok(find(v.render(), 'workflow-change-repository'));
  assert.equal(find(v.render(), 'workflow-criteria'), null, 'the saved prompt is summarized without asking for it twice');
  click(find(v.render(), 'workflow-edit-prompt'), cx);
  assert.ok(find(v.render(), 'workflow-criteria'));
  v.form.criteria.set_value('Edited prompt');
  v.load(cx); await flush();
  assert.equal(v.form.criteria.value(), 'Edited prompt', 'refresh never reseeds an edited draft');
  v.close();
});

test('a result link selects its exact task once and cannot select a task from another run', async () => {
  const path = '/home/test/.config/herdr-app/relevo-workflow/state.json';
  const state = { tasks: [
    { id: 'first', goalId: 'g', title: 'First result', state: 'needs_you' },
    { id: 'second', goalId: 'g', title: 'Second result', state: 'needs_you' },
    { id: 'foreign', goalId: 'other', title: 'Other run', state: 'needs_you' },
  ], events: [] };
  fake.files[path] = JSON.stringify(state);
  openWorkflow('g', 'second'); fake.props = fake.runs.findLast(([name]) => name === 'pane.split')[1].props;
  const v = new Workflow(), cx = fakeCx(); v.init({}, cx); await flush();
  assert.equal(v.selected, 'second'); assert.equal(v.filter, 'Needs you');
  v.selected = 'first'; state.tasks[0].title = 'Updated result'; fake.files[path] = JSON.stringify(state);
  v.load(cx); await flush(); assert.equal(v.selected, 'first', 'polling does not steal selection back'); v.close();
  fake.props = { goalId: 'g', taskId: 'foreign' };
  const other = new Workflow(); other.init({}, cx); await flush();
  assert.equal(other.selected, 'first'); assert.equal(fake.execs.length, 0); other.close();
});

test('a new run reuses the agents of the last task in its repository and Start creates and starts at once', async () => {
  const { newGoal, saveGoal, emptyGoals } = await import('../lib/goals.js');
  const goal = { ...newGoal('g', 'Add keyboard search'), criteria: 'Add keyboard search' };
  fake.focused = { cwd: '/work/app' }; fake.panes = [{ cwd: '/work/app' }];
  fake.agents = [{ ...agent('agent:one', 'Codex'), cwd: '/work/app' }, { ...agent('agent:two', 'Claude'), cwd: '/work/app' }];
  fake.files['/home/test/.config/herdr-app/relevo-goals.json'] = JSON.stringify(saveGoal(emptyGoals(), goal, 0));
  fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({ tasks: [{ id: 'old', goalId: 'other', title: 'Earlier', state: 'accepted', root: '/work/app',
    executor: { address: 'agent:one' }, reviewer: { address: 'agent:two' }, checks: [], maxRounds: 3, maxMinutes: 15 }], events: [], preferences: [], engine: { enabled: false } });
  const { v, cx } = await setup();
  assert.equal(v.executor, 'agent:one'); assert.equal(v.reviewer, 'agent:two');
  assert.equal(v.taskSetupOpen, false, 'resolved setup stays folded');
  assert.match(text(find(v.render(), 'workflow-task-setup')), /app · Codex → Claude/);
  let payload;
  fake.exec = async (_cmd, args) => { payload = JSON.parse(args.at(-1)); return { stdout: '{"doc":{},"result":{"taskId":"new"}}' }; };
  v.render().handlers.on_key_down({ key: 'enter', modifiers: { platform: true } }, cx); await flush();
  assert.equal(payload.action, 'create'); assert.equal(payload.start, true);
  assert.equal(payload.task.maxRounds, 3); assert.equal(payload.task.maxMinutes, 15);
  v.close();
});

test('Save for later creates without starting', async () => {
  const { v, cx } = await setup(); fake.agents = [agent('agent:one', 'One'), agent('agent:two', 'Two')];
  v.form.title.set_value('Later'); v.form.root.set_value('/work/app'); v.form.criteria.set_value('Works'); v.executor = 'agent:one'; v.reviewer = 'agent:two';
  let payload;
  fake.exec = async (_cmd, args) => { payload = JSON.parse(args.at(-1)); return { stdout: '{"doc":{},"result":{"taskId":"new"}}' }; };
  click(find(v.render(), 'workflow-create'), cx); await flush();
  assert.equal(payload.action, 'create'); assert.equal(payload.start, undefined);
  v.close();
});

test('the decision shows the whole agent summary behind one toggle and opens the diff with a way back', async () => {
  const long = `${'Detail. '.repeat(200)}Final line`;
  fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({ tasks: [{ id: 't', goalId: 'g', title: 'Result', state: 'needs_you', revision: 'r1', root: '/work/app',
    executor: { address: 'agent:one' }, reviewer: { address: 'agent:two' }, checks: [], checksResult: [], evidence: [], round: 1, maxRounds: 2,
    attempts: [{ id: 'a1', role: 'executor', state: 'reported', report: { status: 'completed', summary: long } }] }], events: [], preferences: [], engine: { enabled: false } });
  const { v, cx } = await setup();
  assert.doesNotMatch(text(v.render()), /Final line/);
  click(find(v.render(), 'workflow-summary-toggle'), cx);
  assert.match(text(v.render()), /Final line/);
  fake.exec = async (cmd) => ({ stdout: cmd === 'git' ? '/work/app\n' : '' });
  click(find(v.render(), 'workflow-decision-diff'), cx); await flush();
  const split = fake.runs.find(([name]) => name === 'pane.split');
  assert.deepEqual(split[1].props.back, { goalId: 'g', taskId: 't' });
  v.close();
});

test('Command-Enter from the prompt or the change request field acts like the shortcut on the window', async () => {
  const { v, cx } = await setup(); fake.agents = [agent('agent:one', 'One'), agent('agent:two', 'Two')];
  v.form.title.set_value('Search'); v.form.root.set_value('/work/app'); v.form.criteria.set_value('Works\n'); v.executor = 'agent:one'; v.reviewer = 'agent:two';
  const payloads = [];
  fake.exec = async (_cmd, args) => { payloads.push(JSON.parse(args.at(-1))); return { stdout: '{"doc":{},"result":{"taskId":"new"}}' }; };
  v.form.criteria.submit({ secondary: true }, cx); await flush();
  assert.equal(payloads[0].action, 'create'); assert.equal(payloads[0].start, true); assert.equal(payloads[0].task.criteria, 'Works');
  v.close();

  fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({ tasks: [{ id: 't', goalId: 'g', title: 'Result', state: 'needs_you', revision: 'r1', root: '/work/app',
    executor: { address: 'agent:one' }, reviewer: { address: 'agent:two' }, checks: [], checksResult: [], evidence: [], round: 1, maxRounds: 3, attempts: [] }], events: [], preferences: [], engine: { enabled: false } });
  const second = await setup();
  second.v.editDecisionNote(second.v.tasks[0], true, second.cx);
  second.v.form.decision.set_value('Handle empty input\n');
  second.v.form.decision.submit({ secondary: true }, second.cx); await flush();
  assert.equal(payloads.at(-1).action, 'decide'); assert.equal(payloads.at(-1).outcome, 'changes');
  second.v.close();
});

test('agents are named by program and tab, not their changing terminal title, and a preloaded setup stays folded', async () => {
  const { newGoal, saveGoal, emptyGoals } = await import('../lib/goals.js');
  fake.focused = { cwd: '/work/lab' }; fake.panes = [{ cwd: '/work/lab' }];
  fake.agents = [
    { address: 't1', title: 'lab | main | Ready', tab_name: '1', program: { name: 'Codex' }, status: 'idle', cwd: '/work/lab' },
    { address: 't2', title: 'Review task setup', tab_name: 'Review · Team Haiku', program: { name: 'Claude Code' }, status: 'idle', cwd: '/work/lab' },
  ];
  fake.files['/home/test/.config/herdr-app/relevo-goals.json'] = JSON.stringify(saveGoal(emptyGoals(), { ...newGoal('g', 'Check'), criteria: 'Check' }, 0));
  fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({ tasks: [{ id: 'old', goalId: 'other', title: 'Earlier', state: 'accepted', root: '/work/lab',
    executor: { address: 't1' }, reviewer: { address: 't2' }, checks: [['node', '--test']], maxRounds: 2, maxMinutes: 5 }], events: [], preferences: [], engine: { enabled: false } });
  const { v } = await setup();
  assert.match(text(find(v.render(), 'workflow-task-setup')), /^lab · Codex → Claude Code · Review · Team Haiku$/);
  assert.equal(v.taskAdvancedOpen, false);
  v.close();
});

test('a run pane registers itself, is reused when opened again and closes with its own pane', async () => {
  fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({ tasks: [
    { id: 'a', goalId: 'g', title: 'First', state: 'needs_you' }, { id: 'b', goalId: 'g', title: 'Second', state: 'needs_you' }], events: [], preferences: [], engine: { enabled: false } });
  fake.focused = { pane: 'run-pane' }; fake.panes = [{ pane: 'run-pane', mod: 'relevo' }];
  fake.props = { goalId: 'g' };
  const v = new Workflow(), cx = fakeCx(); v.init({}, cx); await flush();
  cx.timers.find((timer) => timer.ms === 300)?.fn(cx);
  assert.deepEqual(fake.stored['relevo.runs.open'], { g: 'run-pane' });
  fake.runs.length = 0;
  openWorkflow('g', 'b');
  assert.deepEqual(fake.runs, [['pane.focus', { pane: 'run-pane' }]], 'no second pane for the same run');
  v.render(); assert.equal(v.selected, 'b');
  click(find(v.render(), 'workflow-close'), cx);
  assert.deepEqual(fake.runs.at(-1), ['pane.close', { pane: 'run-pane' }]);
  v.close(); assert.deepEqual(fake.stored['relevo.runs.open'], {});
});

test('a run window left open from an earlier version can still be closed', async () => {
  fake.props = { goalId: 'g', overlay: 'old-window' };
  const v = new Workflow(), cx = fakeCx(); v.init({}, cx); await flush();
  click(find(v.render(), 'workflow-close'), cx);
  assert.deepEqual(fake.closedOverlays, ['old-window']); v.close();
});

test('the decision bar sits outside the scrolling content and the summary renders as markdown', async () => {
  fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({ tasks: [{ id: 't', goalId: 'g', title: 'Result', state: 'needs_you', revision: 'r1', root: '/work/app',
    executor: { address: 'a', label: 'Codex' }, reviewer: { address: 'b', label: 'Claude' }, checks: [], checksResult: [], evidence: [], round: 1, maxRounds: 2,
    attempts: [{ id: 'x', role: 'executor', state: 'reported', report: { status: 'completed', summary: 'Uses `workflowItems`.' } }] }], events: [], preferences: [], engine: { enabled: false } });
  const { v } = await setup(); const tree = v.render();
  const scroll = find(tree, 'workflow-panel-Overview-t');
  assert.ok(find(tree, 'workflow-decision-card'));
  assert.equal(find(scroll, 'workflow-decision-card'), null);
  assert.equal(find(tree, 'workflow-summary-x').kind, 'textview');
  assert.match(text(find(tree, 'workflow-status-chips')), /Codex → Claude · round 1\/2/);
  v.close();
});
