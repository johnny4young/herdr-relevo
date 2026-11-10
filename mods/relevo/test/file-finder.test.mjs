import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, flush, find, click, text } from './fake/ui.mjs';
const { FileFinder, PanelBar, openFinder } = await import('../panelbar.js');

beforeEach(() => {
  resetFake();
  fake.props = { root: '/work/repo', overlay: 'finder-overlay' };
});

test('panel bar exposes an accessible file finder and opens it at the displayed checkout root', () => {
  const bar = new PanelBar(); bar.syntheticPreview = false; bar.top = '/work/repo'; bar.list = [];
  const tree = bar.render(), action = find(tree, 'find-file'), cx = fakeCx();
  assert.equal(action.kind, 'button');
  assert.equal(action.accessibleLabel, 'Find file');
  assert.match(text(action), /Find file…/);
  assert.doesNotMatch(text(action), /Open file/);
  assert.match(action.tip, /\/work\/repo/);
  assert.equal(action.hasFocusStyle, true);
  click(action, cx);
  assert.equal(fake.overlays[0].props.root, '/work/repo');
  assert.equal(fake.overlays[0].height, 0.8);
});

test('missing roots give feedback and do not render a dead enabled action', () => {
  fake.panes = []; fake.focused = null; fake.spaces = [];
  openFinder();
  assert.match(fake.notices[0].body, /No repository folder/);
  const bar = new PanelBar(); bar.syntheticPreview = false; bar.list = []; bar.top = null;
  const action = find(bar.render(), 'find-file');
  assert.equal(action.isDisabled, true);
  assert.equal(action.tabStop, false);
});

test('finder loads NUL-delimited paths, removes duplicates and opens the selected file', async () => {
  fake.exec = async (_cmd, args) => {
    assert.ok(args.includes('-z'));
    return { stdout: 'src/hello world.js\0src/hello world.js\0notes\nwith-newline.txt\0' };
  };
  const finder = new FileFinder(), cx = fakeCx(); finder.init({}, cx); await flush();
  const tree = finder.render();
  assert.match(text(find(tree, 'find-file-status')), /2 files/);
  assert.ok(find(tree, 'ff-src/hello world.js'));
  finder.open('src/hello world.js');
  assert.deepEqual(fake.closedOverlays, ['finder-overlay']);
  assert.deepEqual(fake.runs[0], ['pane.split', {
    direction: 'right', mod: 'relevo-files', props: { role: 'view', root: '/work/repo', file: 'src/hello world.js' },
  }]);
  finder.close();
});

test('finder shows git failures instead of presenting an empty repository', async () => {
  fake.exec = async () => ({ code: 128, stderr: 'not a git repository' });
  const finder = new FileFinder(), cx = fakeCx(); finder.init({}, cx); await flush();
  const tree = finder.render();
  assert.equal(finder.loadState, 'error');
  assert.match(text(find(tree, 'find-file-status')), /Could not load files: not a git repository/);
  assert.match(text(find(tree, 'find-file-list')), /Could not load files/);
  assert.doesNotMatch(text(tree), /No files found/);
  finder.close();
});

test('finder distinguishes no matches and keeps arrow and Escape navigation', async () => {
  fake.exec = async () => ({ stdout: 'README.md\0src/main.js\0' });
  const finder = new FileFinder(), cx = fakeCx(); finder.init({}, cx); await flush();
  finder.input.type('zzz', cx);
  assert.match(text(finder.render()), /No matching files/);
  finder.input.type('', cx);
  finder.key({ key: 'down' }, cx); assert.equal(finder.at, 1);
  finder.key({ key: 'up' }, cx); assert.equal(finder.at, 0);
  finder.key({ key: 'escape' }, cx); assert.equal(fake.closedOverlays.at(-1), 'finder-overlay');
  finder.close();
});

test('closing during file loading suppresses late redraws and releases the input once', async () => {
  let resolveExec;
  fake.exec = () => new Promise((resolve) => { resolveExec = resolve; });
  const finder = new FileFinder(), cx = fakeCx(); finder.init({}, cx); await flush();
  let released = 0; finder.input.release = () => { released++; };
  finder.close(); const notified = cx.notified;
  resolveExec({ stdout: 'late.txt\0' }); await flush();
  assert.equal(released, 1);
  assert.equal(cx.notified, notified);
  finder.close(); assert.equal(released, 1);
});
