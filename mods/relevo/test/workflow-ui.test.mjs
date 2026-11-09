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
  assert.match(text(tree), /Create task/); assert.match(text(tree), /does not launch an agent/); assert.equal(fake.execs.length, 0);
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
  v.tab = 'Evidence'; let tree = v.render(); assert.ok(find(tree, 'workflow-remove-e1')); assert.ok(find(tree, 'workflow-open-e1')); assert.ok(find(tree, 'workflow-attach-report'));
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
