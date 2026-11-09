import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake, calls } from './fake/herdr.mjs';
const { openReplies } = await import('../replies.js');
const { CONTEXTS } = await import('../config.js');
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
beforeEach(() => {
  resetFake(); fake.agents = [{ address: 'a', tab_name: 'Lead A', focused: true, cwd: '/personal/app' }, { address: 'b', tab_name: 'Lead B', cwd: '/personal/other' }];
});

test('a slower earlier request cannot replace the newest reply recipient', async () => {
  const pending = deferred(); let reads = 0; fake.read = () => ++reads === 1 ? pending.promise : null;
  const older = openReplies('a'); await openReplies('b'); pending.resolve(null); await older;
  assert.deepEqual(fake.overlays.map((x) => x.props.address), ['b']); assert.deepEqual(calls(/^hc send/), []);
});

test('a newer request with no focused agent cancels a pending opening', async () => {
  const pending = deferred(); fake.read = () => pending.promise; const older = openReplies('a');
  fake.agents.forEach((a) => { a.focused = false; }); await openReplies(); pending.resolve(null); await older;
  assert.deepEqual(fake.overlays, []); assert.equal(fake.notices.at(-1).title, 'No agent in focus');
});

test('a disconnected recipient is not offered after optional context resolves', async () => {
  const pending = deferred(); fake.read = () => pending.promise; const request = openReplies('a'); fake.agents = [fake.agents[1]];
  pending.resolve(null); await request; assert.deepEqual(fake.overlays, []);
  assert.equal(fake.notices.at(-1).title, 'Agent no longer available'); assert.deepEqual(fake.runs, []);
});

test('cross-context changes require a fresh opening instead of showing old suggestions', async () => {
  fake.stored['space-folders'] = { '': { list: [{ id: CONTEXTS[1].key, match: 'work-app' }] } };
  const pending = deferred(); fake.read = () => pending.promise; const request = openReplies('a'); fake.agents[0].cwd = '/work/work-app';
  pending.resolve(null); await request; assert.deepEqual(fake.overlays, []); assert.equal(fake.notices.at(-1).title, 'Agent context changed');
  assert.match(fake.notices.at(-1).body, /refresh the suggestions/);
});

test('the latest connected recipient label is used without changing the requested address', async () => {
  const pending = deferred(); fake.read = () => pending.promise; const request = openReplies('a');
  fake.agents[0] = { ...fake.agents[0], tab_name: 'Renamed lead' }; pending.resolve(null); await request;
  assert.equal(fake.overlays[0].props.address, 'a'); assert.equal(fake.overlays[0].props.name, 'Renamed lead');
});

test('same-context directory changes preserve the requested reply workflow', async () => {
  const pending = deferred(); fake.read = () => pending.promise; const request = openReplies('a'); fake.agents[0].cwd = '/personal/another';
  pending.resolve(null); await request; assert.equal(fake.overlays[0].props.address, 'a'); assert.ok(fake.overlays[0].props.replies.length); assert.deepEqual(fake.notices, []);
});

test('a focus change alone never retargets an explicit request', async () => {
  const pending = deferred(); fake.read = () => pending.promise; const request = openReplies('a'); fake.agents[0].focused = false; fake.agents[1].focused = true;
  pending.resolve(null); await request; assert.equal(fake.overlays[0].props.address, 'a'); assert.deepEqual(fake.notices, []);
});

test('a superseded disconnected request stays silent after the latest picker opens', async () => {
  const pending = deferred(); let reads = 0; fake.read = () => ++reads === 1 ? pending.promise : null;
  const older = openReplies('a'); await openReplies('b'); fake.agents = [fake.agents[1]]; pending.resolve(null); await older;
  assert.deepEqual(fake.overlays.map((x) => x.props.address), ['b']); assert.deepEqual(fake.notices, []);
});
