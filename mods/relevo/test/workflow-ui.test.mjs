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
  openWorkflow('g'); assert.deepEqual(fake.overlays.at(-1).props, { role: 'workflow', goalId: 'g' });
  const { v } = await setup(); const tree = v.render();
  assert.match(text(tree), /Create task/); assert.match(text(tree), /After Start/); assert.equal(fake.execs.length, 0);
  assert.ok(find(tree, 'workflow-dialog')); v.close();
});

test('create validates two connected agents and sends the explicit task contract', async () => {
  const { v, cx } = await setup(); fake.agents = [agent('agent:one', 'One'), agent('agent:two', 'Two')];
  v.form.title.set_value('Implement search'); v.form.root.set_value('/work/app'); v.form.criteria.set_value('Search works'); v.executor = 'agent:one'; v.reviewer = 'agent:two';
  fake.exec = async (_cmd, args) => { const payload = JSON.parse(args.at(-1)); assert.equal(payload.action, 'create'); assert.equal(payload.task.root, '/work/app'); assert.equal(payload.task.executor.address, 'agent:one'); assert.equal(payload.task.maxRounds, 2); assert.equal(payload.task.maxMinutes, 20); fake.files['/home/test/.config/herdr-app/relevo-workflow/state.json'] = JSON.stringify({ tasks: [{ id: 'created-task', goalId: 'g', title: 'Implement search', state: 'planned' }], events: [], preferences: [], engine: { enabled: false } }); return { stdout: '{"doc":{},"result":{"taskId":"created-task"}}' }; };
  v.create(cx); await flush(); assert.equal(fake.execs.length, 1); assert.equal(v.error, null); assert.equal(v.selected, 'created-task'); assert.equal(v.form.title.value(), ''); v.close();
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
  assert.match(text(v.render()), /Started/);
  v.tab = 'Evidence'; let tree = v.render(); assert.ok(find(tree, 'workflow-remove-e1')); assert.ok(find(tree, 'workflow-open-e1'));
  assert.equal(find(tree, 'workflow-path'), null, 'evidence is readable before opening the attachment form');
  click(find(tree, 'workflow-evidence-add'), cx); tree = v.render(); assert.ok(find(tree, 'workflow-attach-report'));
  click(find(tree, 'workflow-new-task'), cx); tree = v.render(); assert.ok(find(tree, 'workflow-title'));
  v.selected = 'task-1'; v.h.is_focused = () => false; tree = v.render();
  const escape = find(tree, 'workflow-dialog').handlers['on_key_down'];
  escape({ key: 'escape' }, { stop_propagation() {} });
  assert.equal(fake.closedOverlays.at(-1), 'o'); v.close();
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
  assert.match(text(v.render()), /Keyboard:/); v.close();
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
    for(const tab of ['Overview','Activity','Changes','Evidence','Preferences']) {v.tab=tab;check(v.render());}
  }
  v.close();
});

test('the first screen explains the decision and keeps sessions and messaging secondary', async () => {
  const { v, cx } = await setup();
  v.tasks = [{ id: 'result', goalId: 'g', title: 'Search', state: 'needs_you', round: 1, maxRounds: 2,
    executor: { address: 'builder' }, reviewer: { address: 'reviewer' }, revision: 'current',
    checksResult: [{ code: 0 }], attempts: [{ role: 'executor', report: { summary: 'Search implemented' } }] }];
  v.selected = 'result'; let tree = v.render();
  assert.match(text(tree), /READY FOR YOUR REVIEW/); assert.match(text(tree), /Search implemented/);
  assert.match(text(tree), /CHECKS 1\/1 passed/);
  assert.ok(find(tree, 'workflow-decide-accept')); assert.ok(find(tree, 'workflow-inspect-result'));
  assert.equal(find(tree, 'workflow-message'), null); assert.equal(find(tree, 'workflow-focus-executor'), null);
  assert.equal(find(tree, 'workflow-decision'), null);
  click(find(tree, 'workflow-details-toggle'), cx); tree = v.render();
  assert.ok(find(tree, 'workflow-message')); assert.ok(find(tree, 'workflow-focus-executor'));
  click(find(tree, 'workflow-inspect-result'), cx); assert.equal(v.tab, 'Changes');
  assert.ok(find(v.render(), 'workflow-decide-accept'), 'decision remains reachable after reading reports');
  assert.equal(fake.execs.length, 0); v.close();
});

test('requesting changes previews the next effect and requires explicit feedback submission', async () => {
  const { v, cx } = await setup();
  v.tasks = [{ id: 'result', goalId: 'g', title: 'Search', state: 'needs_you', round: 1, maxRounds: 2, revision: 'current' }];
  v.selected = 'result'; click(find(v.render(), 'workflow-decide-changes'), cx);
  let tree = v.render(); assert.equal(fake.execs.length, 0);
  assert.match(text(tree), /another implementation and review round/);
  assert.equal(find(tree, 'workflow-send-changes').isDisabled, true);
  assert.equal(find(tree, 'workflow-decide-accept').isDisabled, true);
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
  assert.match(text(v.render()), /Nothing runs until you create and start it/);
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

test('compact review preserves full context on demand without dispatching or implying missing evidence passed', async () => {
  const { v, cx } = await setup();
  const title = 'Review the complete result '.repeat(12);
  const reviewerSummary = 'A detailed independent report that belongs in Result.';
  v.tasks = [{ id: 'result', goalId: 'g', title, state: 'needs_you', attempts: [
    { id: 'review', role: 'reviewer', report: { status: 'blocked', summary: reviewerSummary } },
  ] }]; v.selected = 'result'; v.engine = { enabled: true };
  let tree = v.render();
  assert.match(text(tree), /CHECKS Not recorded INDEPENDENT REVIEW Blocked EVIDENCE 0 attached/);
  assert.ok(!text(tree).includes(reviewerSummary));
  assert.ok(!text(find(tree, 'workflow-outcome-header')).includes(title), 'long assignments are disclosed instead of dominating the first screen');
  assert.equal(find(tree, 'workflow-engine-stop'), null);
  click(find(tree, 'workflow-tools-toggle'), cx); tree = v.render();
  assert.ok(find(tree, 'workflow-engine-stop')); assert.ok(find(tree, 'workflow-tab-Preferences'));
  click(find(tree, 'workflow-details-toggle'), cx); assert.ok(text(v.render()).includes(title));
  click(find(v.render(), 'workflow-inspect-result'), cx); assert.ok(text(v.render()).includes(reviewerSummary));
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
