import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, flush, find, text } from './fake/ui.mjs';
const { launchSkill, LAUNCHED } = await import('../skills.js');
const { AccountMenu } = await import('../account-menu.js');
const pr = { url: 'https://github.com/acme/app/pull/1', number: 1, repo: 'acme/app', title: 'Search', headRefName: 'search' };
beforeEach(resetFake);
const prior = () => ({ tab: 'earlier review', skill: 'review', account: 'personal', at: 1 });

test('failed worktree preparation returns its error and preserves prior launch metadata', async () => {
  const old = prior(); fake.stored[LAUNCHED] = { [pr.url]: old };
  fake.exec = (cmd) => cmd === 'test' ? { code: 0 } : null;
  const error = await launchSkill(pr, 'conflicts', 'personal', '/work/app');
  assert.match(error, /already exists/); assert.deepEqual(fake.stored[LAUNCHED][pr.url], old);
  assert.deepEqual(fake.runs, []);
});

test('preparation is not recorded as a launched skill before a session request succeeds', async () => {
  let resolve; fake.exec = (cmd) => cmd === 'test' ? new Promise((done) => { resolve = done; }) : null;
  const started = launchSkill(pr, 'conflicts', 'personal', '/work/app'); await flush();
  assert.equal(fake.stored[LAUNCHED], undefined);
  resolve({ code: 1 }); assert.equal(await started, null);
  assert.equal(fake.stored[LAUNCHED][pr.url].skill, 'conflicts'); assert.equal(fake.runs.length, 1);
});

test('a late failed preparation cannot erase a newer launch record', async () => {
  let resolve; fake.exec = (cmd) => cmd === 'test' ? new Promise((done) => { resolve = done; }) : null;
  const started = launchSkill(pr, 'conflicts', 'personal', '/work/app'); await flush();
  launchSkill(pr, 'review', 'personal', '/work/app'); const latest = fake.stored[LAUNCHED][pr.url];
  resolve({ code: 0 }); await started;
  assert.deepEqual(fake.stored[LAUNCHED][pr.url], latest); assert.equal(latest.skill, 'review');
});

test('a late successful preparation cannot overwrite a newer requested action', async () => {
  let resolve; fake.exec = (cmd) => cmd === 'test' ? new Promise((done) => { resolve = done; }) : null;
  const started = launchSkill(pr, 'conflicts', 'personal', '/work/app'); await flush();
  launchSkill(pr, 'review', 'personal', '/work/app'); const latest = fake.stored[LAUNCHED][pr.url];
  resolve({ code: 1 }); await started;
  assert.deepEqual(fake.stored[LAUNCHED][pr.url], latest);
});

test('expected skill failure stays visible in the picker and never retries automatically', async () => {
  fake.props = { pr, skill: 'conflicts', current: 'personal', folder: '/work/app', overlay: 'own' };
  fake.exec = (cmd) => cmd === 'test' ? { code: 0 } : null;
  const menu = new AccountMenu(), cx = fakeCx(); menu.init({}, cx); await flush();
  menu.runSkill('conflicts', cx); await flush();
  assert.deepEqual(fake.closedOverlays, []); assert.equal(menu.opening, null);
  assert.match(text(find(menu.render(), 'menu-launch-error')), /already exists/);
  assert.equal(find(menu.render(), 'menu-skill-conflicts').isDisabled, false);
  const count = fake.execs.length; menu.render(); await flush(); assert.equal(fake.execs.length, count);
});

test('dismissal suppresses late menu effects and rejects additional launches', async () => {
  fake.props = { pr, skill: 'conflicts', current: 'personal', folder: '/work/app', overlay: 'own' };
  let resolve; fake.exec = (cmd) => cmd === 'test' ? new Promise((done) => { resolve = done; }) : null;
  const menu = new AccountMenu(), cx = fakeCx(); menu.init({}, cx); await flush();
  menu.runSkill('conflicts', cx); await flush(); menu.close(); const notified = cx.notified;
  resolve({ code: 0 }); await flush();
  assert.equal(cx.notified, notified); assert.deepEqual(fake.closedOverlays, []);
  const count = fake.execs.length; menu.runSkill('review', cx); menu.session(cx); await flush();
  assert.equal(fake.execs.length, count); assert.deepEqual(fake.runs, []);
});

test('rejected preparation reports an uncertain outcome without closing or retrying', async () => {
  fake.props = { pr, skill: 'conflicts', current: 'personal', folder: '/work/app', overlay: 'own' };
  const old = prior(); fake.stored[LAUNCHED] = { [pr.url]: old };
  fake.exec = (cmd) => { if (cmd === 'test') throw Error('Synthetic bridge failure'); return null; };
  const menu = new AccountMenu(), cx = fakeCx(); menu.init({}, cx); await flush();
  menu.runSkill('conflicts', cx); await flush();
  assert.match(menu.error, /Could not confirm launch/); assert.match(menu.error, /Check for an existing session before trying again/);
  assert.equal(menu.opening, null); assert.deepEqual(fake.closedOverlays, []);
  assert.deepEqual(fake.stored[LAUNCHED][pr.url], old); assert.deepEqual(fake.runs, []);
});

test('a dismissed session picker never reacts to its late result', async () => {
  fake.props = { pr, skill: 'review', current: 'personal', folder: '/work/app', overlay: 'own' };
  let resolve; fake.exec = (cmd) => cmd === 'test' ? new Promise((done) => { resolve = done; }) : null;
  const menu = new AccountMenu(), cx = fakeCx(); menu.init({}, cx); await flush();
  menu.session(cx); await flush(); menu.close(); const notified = cx.notified;
  resolve({ code: 0 }); await flush();
  assert.equal(cx.notified, notified); assert.deepEqual(fake.closedOverlays, []);
});
