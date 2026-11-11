import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake, appHome } from './fake/herdr.mjs';
import { buildShortcutHelpRows, filterShortcutHelpRows, shortcutSearchText, INBOX_SHORTCUT_ACTIONS } from '../lib/shortcut-help.js';
const { loadKeys, shortcutBindings, shortcut } = await import('../ui.js');
const { ShortcutHelp } = await import('../shortcut-help.js');

beforeEach(resetFake);

test('help rows use the loaded effective bindings and keep unbound actions searchable', async () => {
  fake.files[`${appHome()}/keys.json`] = JSON.stringify({
    global: { 'cmd-n': 'workspace.new', 'cmd-g': 'relevo.review' },
    'layout:relevo': { 'cmd-alt-shift-k': 'relevo.review' },
  });
  await loadKeys();
  const rows = buildShortcutHelpRows([
    { id: 'relevo.review', label: 'Open review', section: 'Work' },
    { id: 'relevo.next-waiting', label: 'Next waiting agent', section: 'Inbox' },
  ], shortcutBindings());

  assert.equal(shortcut('relevo.review'), '⌥⇧⌘K');
  assert.equal(rows[0].shortcut, '⌥⇧⌘K');
  assert.equal(rows[0].assigned, true);
  assert.equal(rows[1].shortcut, '');
  assert.equal(rows[1].assigned, false);
  assert.deepEqual(filterShortcutHelpRows(rows, 'next waiting'), [rows[1]]);
  assert.equal(filterShortcutHelpRows(rows, 'cmd+g').some((row) => row.id === 'relevo.review'), false);
});

test('search matches rendered glyphs and common modifier spellings', () => {
  const rows = buildShortcutHelpRows([
    { id: 'relevo.new', label: 'New item' },
  ], { 'relevo.new': 'cmd-shift-n' });

  assert.equal(rows[0].shortcut, '⇧⌘N');
  for (const query of ['⇧⌘n', 'cmd+shift+n', 'command+shift+n', 'meta+shift+n']) {
    assert.equal(filterShortcutHelpRows(rows, query).length, 1, query);
  }
});

test('multi-step chords keep their steps separate during alias expansion', () => {
  const rows = buildShortcutHelpRows([
    { id: 'relevo.chord', label: 'Open chord command' },
  ], { 'relevo.chord': 'cmd-k cmd-n' });

  assert.equal(rows[0].shortcut, '⌘K ⌘N');
  assert.match(shortcutSearchText(rows[0].combo), /command\+k command\+n/);
  assert.doesNotMatch(shortcutSearchText(rows[0].combo), /cmd\+k\+cmd\+n/);
  assert.deepEqual(filterShortcutHelpRows(rows, 'cmd+k cmd+n'), rows);
  assert.deepEqual(filterShortcutHelpRows(rows, 'open chord'), rows);
});

test('a rebound combo replaces the old key and an unassigned action remains findable', () => {
  const rows = buildShortcutHelpRows([
    { id: 'relevo.next', label: 'Next waiting item' },
    { id: 'relevo.unbound', label: 'Open settings' },
  ], { 'relevo.next': 'ctrl-alt-j' });

  assert.equal(filterShortcutHelpRows(rows, 'ctrl+alt+j')[0].id, 'relevo.next');
  assert.equal(filterShortcutHelpRows(rows, 'cmd+j').length, 0);
  assert.equal(filterShortcutHelpRows(rows, 'open settings')[0].assigned, false);
});

test('Inbox help combines fixed navigation with only effective configurable bindings', async () => {
  fake.files[`${appHome()}/keys.json`] = JSON.stringify({ global: { 'cmd-g': 'relevo.next-waiting' } });
  await loadKeys();
  const rows = buildShortcutHelpRows(INBOX_SHORTCUT_ACTIONS, shortcutBindings());
  assert.equal(rows.find((row) => row.id === 'inbox.down').shortcut, 'down');
  assert.equal(rows.find((row) => row.id === 'relevo.next-waiting').shortcut, '⌘G');
  assert.equal(rows.find((row) => row.id === 'relevo.review').assigned, false);
});

test('help Escape clears search first and closes only on the next Escape', () => {
  let closed = 0;
  const help = new ShortcutHelp();
  help.init({ onClose: () => { closed += 1; } }, {});
  help.query = 'command';
  help.key({ key: 'escape' }, { stop_propagation() {}, notify() {} });
  assert.equal(help.query, '');
  assert.equal(closed, 0);
  help.key({ key: 'escape' }, { stop_propagation() {}, notify() {} });
  assert.equal(closed, 1);
});
