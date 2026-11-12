import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, flush, find, text, click } from './fake/ui.mjs';

const { InboxButton } = await import('../toolbar.js');
const { Inbox } = await import('../inbox.js');
const { GOAL_MODE } = await import('../inbox-goals.js');

beforeEach(() => {
  resetFake();
  fake.layout = { id: 'root', children: [
    { id: 'panel', hidden: false },
    { id: 'panel-body', active: 'inbox' },
    { id: 'panel-bar', hidden: true },
  ] };
});

test('Reviews and Runs tabs persist only the mode and select the existing Inbox panel', () => {
  const savedData = { goals: [{ id: 'g1', title: 'Keep me' }] };
  fake.stored['relevo.goals.data'] = savedData;
  fake.stored[GOAL_MODE] = false;
  const bar = new InboxButton();
  let tree = bar.render();

  assert.match(text(tree), /Reviews.*Runs/);
  click(find(tree, 'runs-toggle'), fakeCx());
  assert.equal(fake.stored[GOAL_MODE], true);
  assert.equal(fake.stored['relevo.goals.data'], savedData);
  assert.deepEqual(fake.runs.slice(-2), [
    ['layout.select', { stack: 'panel-body', child: 'inbox' }],
    ['layout.show', { id: 'panel' }],
  ]);

  click(find(bar.render(), 'reviews-toggle'), fakeCx());
  assert.equal(fake.stored[GOAL_MODE], false);
  assert.equal(fake.stored['relevo.goals.data'], savedData);
});

test('topbar reads an existing Runs mode and hides/restores only the file panel bar', () => {
  fake.stored[GOAL_MODE] = true;
  fake.layout.children.find((node) => node.id === 'panel-bar').hidden = false;
  const bar = new InboxButton();
  let tree = bar.render();
  assert.match(text(tree), /Runs/);
  assert.deepEqual(fake.runs, [['layout.hide', { id: 'panel-bar' }]]);
  assert.equal(fake.layout.children.find((node) => node.id === 'panel').hidden, false);
  fake.layout.children.find((node) => node.id === 'panel-bar').hidden = true;
  bar.render();
  assert.equal(fake.runs.length, 1, 'a settled layout does not repeat the hide command on later renders');

  fake.runs.length = 0;
  fake.layout.children.find((node) => node.id === 'panel-body').active = 'files';
  fake.layout.children.find((node) => node.id === 'panel-bar').hidden = true;
  tree = bar.render();
  assert.deepEqual(fake.runs, [['layout.show', { id: 'panel-bar' }]]);
  assert.equal(fake.layout.children.find((node) => node.id === 'panel').hidden, false);
});

async function createInbox() {
  fake.exec = (cmd) => cmd === 'gh' ? { stdout: JSON.stringify({ data: { viewer: { login: 'me', pullRequests: { nodes: [] } }, search: { nodes: [] } } }) } : null;
  const view = new Inbox(), cx = fakeCx();
  view.init({}, cx); await flush();
  return { view, cx };
}

test('Inbox opens directly into the selected queue without nested mode tabs and keeps help focus', async () => {
  fake.stored[GOAL_MODE] = true;
  const { view, cx } = await createInbox();
  view.h.is_focused = () => true;
  let focusedSearch = 0;
  const focus = view.shortcutHelp.focus.bind(view.shortcutHelp);
  view.shortcutHelp.focus = () => { focusedSearch += 1; focus(); };

  let tree = view.render(cx);
  assert.match(tree.accessibleLabel, /^Runs\./);
  assert.equal(find(tree, 'inbox-mode-true'), null);
  assert.equal(find(tree, 'inbox-mode-false'), null);
  assert.ok(find(tree, 'goal-new'));

  view.navKey({ key: '?' }, cx);
  tree = view.render(cx);
  assert.equal(focusedSearch, 1);
  assert.ok(find(tree, 'shortcut-help-search'));
  assert.ok(find(tree, 'goal-new'));
  assert.equal(view.goalHelp, true);

  click(find(tree, 'goal-key-help'), cx);
  assert.equal(view.goalHelp, false);
  assert.ok(find(view.render(cx), 'goal-new'));
});

test('isolated previews retain a single preview route without suggesting live run execution', () => {
  const bar = new InboxButton(); bar.init({ syntheticPreview: true });
  const tree = bar.render();
  assert.equal(find(tree, 'runs-toggle'), null);
  click(find(tree, 'preview-queue'), fakeCx());
  assert.equal(fake.stored[GOAL_MODE], undefined);
  assert.deepEqual(fake.runs, [['layout.select', { stack: 'panel-body', child: 'inbox' }], ['layout.show', { id: 'panel' }]]);
});
