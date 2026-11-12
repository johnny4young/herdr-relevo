import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
const { Inbox } = await import('../inbox.js');
const { GOAL_MODE } = await import('../inbox-goals.js');

beforeEach(resetFake);

test('keyboard ? opens help and moves focus to search; queue keys are suppressed while open', () => {
  fake.stored[GOAL_MODE] = true;
  let focused = 0, helpEscapes = 0;
  const inbox = Object.create(Inbox.prototype);
  inbox.goalHelp = false;
  inbox.h = { focus: () => { focused += 1; }, is_focused: () => true };
  inbox.shortcutHelp = { focus: () => { focused += 10; }, key: () => { helpEscapes += 1; } };

  assert.equal(inbox.goalAction('?', { notify() {} }), true);
  assert.equal(focused, 10);
  inbox.navKey({ key: 'escape' }, { stop_propagation() {}, notify() {} });
  assert.equal(helpEscapes, 1);
  assert.equal(inbox.goalHelp, true);
});

test('Inbox close releases shortcut search state', () => {
  let released = 0, closed = 0, cleared = 0;
  const inbox = Object.create(Inbox.prototype);
  inbox.reply = { release: () => { released += 1; } };
  inbox.shortcutHelp = { close: () => { closed += 1; } };
  inbox.wanted = { clear: () => { cleared += 1; } };

  inbox.close();
  assert.deepEqual([released, closed, cleared], [1, 1, 1]);
});
