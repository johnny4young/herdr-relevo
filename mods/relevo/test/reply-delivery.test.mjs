import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake, calls } from './fake/herdr.mjs';
import { fakeCx, flush, find, text } from './fake/ui.mjs';
const { QuickReplies } = await import('../replies.js');
const pending = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const start = () => {
  const view = new QuickReplies(), cx = fakeCx(), errors = [];
  cx.spawn = (body) => Promise.resolve().then(() => body(cx)).catch((error) => errors.push(error));
  view.init({}, cx); view.input.set_value('Keep this draft'); return { view, cx, errors };
};
beforeEach(() => { resetFake(); fake.props = { address: 't-synthetic', name: 'Synthetic lead', overlay: 'own-overlay', replies: [{ text: 'Continue' }] }; });

test('a rejected send becomes a visible uncertain outcome and preserves the draft without retrying', async () => {
  fake.exec = async () => { throw Error('Synthetic bridge disconnected'); };
  const { view, cx, errors } = start(); view.send(view.input.value(), cx); await flush();
  assert.deepEqual(errors, []); assert.equal(view.sending, false);
  assert.match(text(find(view.render(), 'reply-send-error')), /Delivery not confirmed/);
  assert.match(view.error, /Check the agent before sending again/);
  assert.equal(view.input.value(), 'Keep this draft'); assert.equal(find(view.render(), 'reply-input').isDisabled, false);
  view.render(); await flush(); assert.equal(calls(/^hc send/).length, 1); assert.deepEqual(fake.closedOverlays, []); view.close();
});

test('pending delivery exposes status and blocks new input, choice activation and keyboard sends', async () => {
  const wait = pending(); fake.exec = () => wait.promise;
  const { view, cx } = start(); view.send(view.input.value(), cx); await flush(); const tree = view.render();
  assert.match(text(find(tree, 'reply-send-status')), /Sending/); assert.equal(find(tree, 'reply-input').isDisabled, true);
  assert.equal(find(tree, 'reply-0').handlers.on_click, undefined);
  for (const key of ['enter', '1', 'h']) view.key({ key, key_char: key, modifiers: {} }, cx);
  view.send('Another message', cx); assert.equal(view.input.value(), 'Keep this draft'); assert.equal(calls(/^hc send/).length, 1);
  wait.resolve({ code: 1, stderr: 'Synthetic refusal' }); await flush(); view.close();
});

test('a nonzero send keeps the picker open with uncertainty guidance and the original reason', async () => {
  fake.exec = () => ({ code: 1, stderr: 'Synthetic agent blocked\nmore' });
  const { view, cx } = start(); view.send(view.input.value(), cx); await flush();
  assert.equal(fake.notices.at(-1).body, 'Synthetic agent blocked'); assert.match(view.error, /Delivery not confirmed/);
  assert.equal(view.sending, false); assert.equal(find(view.render(), 'reply-input').isDisabled, false);
  assert.deepEqual(fake.closedOverlays, []); assert.equal(calls(/^hc send/).length, 1); view.close();
});

test('dismissal ignores late delivery failure and rejects all further sends', async () => {
  const wait = pending(); fake.exec = () => wait.promise;
  const { view, cx, errors } = start(); view.send(view.input.value(), cx); await flush(); view.close(); const notified = cx.notified;
  wait.reject(Error('Synthetic late failure')); await flush();
  assert.deepEqual(errors, []); assert.equal(cx.notified, notified); assert.deepEqual(fake.closedOverlays, []);
  view.send('Do not send', cx); await flush(); assert.equal(calls(/^hc send/).length, 1);
});

test('dismissal releases both handles once and prevents the delayed focus callback', () => {
  const { view, cx } = start(); let released = 0, focused = 0;
  view.h.release = () => { released++; }; view.input.release = () => { released++; };
  view.h.focus = () => { focused++; }; view.input.value = () => assert.fail('released input accessed');
  view.close(); view.close(); cx.timers.find((t) => t.ms === 300).fn(cx);
  assert.equal(released, 2); assert.equal(focused, 0);
});

test('successful submitted text and overlay remain bound to the original recipient', async () => {
  const wait = pending(); fake.exec = () => wait.promise;
  const { view, cx } = start(); view.send(view.input.value(), cx); await flush();
  fake.props.address = 'other-agent'; fake.props.name = 'Other'; fake.props.overlay = 'other-overlay';
  wait.resolve({ code: 0 }); await flush();
  assert.deepEqual(calls(/^hc send/), ['hc send t-synthetic Keep this draft']);
  assert.deepEqual(fake.closedOverlays, ['own-overlay']); view.close();
});

test('dismissed successful request never closes a later overlay', async () => {
  const wait = pending(); fake.exec = () => wait.promise;
  const { view, cx } = start(); view.send(view.input.value(), cx); await flush(); view.close(); const notified = cx.notified;
  fake.props = { address: 'other-agent', overlay: 'other-overlay' }; wait.resolve({ code: 0 }); await flush();
  assert.deepEqual(fake.closedOverlays, []); assert.equal(cx.notified, notified);
});

test('OS-modified Enter does not send a reply', async () => {
  const { view, cx } = start();
  for (const key of ['platform', 'control', 'alt']) view.key({ key: 'enter', modifiers: { [key]: true } }, cx);
  await flush(); assert.deepEqual(calls(/^hc send/), []); view.close();
});
