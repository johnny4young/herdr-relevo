import './fake/register.mjs';
import { registerHooks } from 'node:module';
import { URL } from 'node:url';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, flush, find, click, text, spinners } from './fake/ui.mjs';
// Only the optional loaders are synthetic; account chips, ranking and actions
// continue using the real modules. Each test controls their completion order.
const accounts = new URL('../accounts.js', import.meta.url).href;
const sessions = new URL('../prsession.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/account-menu.js')) {
    const source = specifier === './accounts.js'
      ? `export { ACCOUNTS, CODEX, accountOf, chip } from ${JSON.stringify(accounts)}; export const loadClaudeQuotas = () => globalThis.menuLoaders.quotas();`
      : specifier === './prsession.js'
        ? `export { openPrSession } from ${JSON.stringify(sessions)}; export const skillUses = () => globalThis.menuLoaders.uses();` : null;
    if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { AccountMenu } = await import('../account-menu.js');
const quota = { personal: { h5: { pct: 23 }, d7: { pct: 31 } } };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const start = () => {
  const menu = new AccountMenu(), cx = fakeCx(), errors = [];
  // Capture a rejected host task as a regression, not an unhandled test crash.
  cx.spawn = (body) => Promise.resolve().then(() => body(cx)).catch((e) => errors.push(e));
  menu.init({}, cx); return { menu, cx, errors };
};
beforeEach(() => {
  resetFake();
  fake.props = { pr: { repo: 'acme/app', number: 1, url: 'https://github.com/acme/app/pull/1', headRefName: 'search' }, current: 'personal', skill: 'conflicts', folder: '/work/app' };
  globalThis.menuLoaders = { quotas: async () => quota, uses: async () => ({ review: 4 }) };
});

test('history failure retains available quota and explains the fallback without launching', async () => {
  globalThis.menuLoaders.uses = async () => { throw Error('Synthetic history failure'); };
  const { menu, errors } = start(); await flush(); const tree = menu.render();
  assert.deepEqual(errors, []); assert.deepEqual(menu.quotas, quota); assert.deepEqual(menu.uses, {});
  assert.match(text(tree), /5h 23%/); assert.match(text(find(tree, 'menu-history-unavailable')), /Skill history unavailable/);
  assert.equal(spinners(tree), 0); assert.equal(find(tree, 'menu-skill-conflicts').isDisabled, false);
  assert.equal(find(tree, 'menu-session').isDisabled, false); assert.deepEqual(fake.runs, []);
});

test('quota failure preserves skill history and clears its spinner', async () => {
  globalThis.menuLoaders.quotas = async () => { throw Error('Synthetic quota failure'); };
  const { menu, errors } = start(); await flush(); const tree = menu.render();
  assert.deepEqual(errors, []); assert.deepEqual(menu.uses, { review: 4 });
  assert.match(text(find(tree, 'menu-usage')), /Usage unavailable/); assert.equal(spinners(tree), 0);
  assert.match(text(find(tree, 'menu-skill-review')), /used 4×/); assert.equal(menu.account, 'personal');
});

test('a pending history request does not hide already loaded quota', async () => {
  const pending = deferred(); globalThis.menuLoaders.uses = () => pending.promise;
  const { menu } = start(); await flush();
  assert.match(text(find(menu.render(), 'menu-usage')), /5h 23%/); assert.equal(menu.uses, null);
  pending.resolve({ review: 2 }); await flush(); assert.equal(menu.uses.review, 2);
});

test('a pending quota request does not delay available skill ranking', async () => {
  const pending = deferred(); globalThis.menuLoaders.quotas = () => pending.promise;
  const { menu, cx } = start(); await flush();
  assert.equal(menu.uses.review, 4); assert.match(text(find(menu.render(), 'menu-skill-review')), /used 4×/);
  click(find(menu.render(), 'menu-acct-work'), cx); assert.equal(menu.account, 'work');
  pending.resolve(quota); await flush(); assert.equal(menu.account, 'work');
});

test('both optional failures keep configured actions and do not retry automatically', async () => {
  let calls = 0; const fail = async () => { calls++; throw Error('Synthetic unavailable'); };
  globalThis.menuLoaders = { quotas: fail, uses: fail };
  const { menu, errors } = start(); await flush(); menu.render(); menu.render(); await flush();
  assert.deepEqual(errors, []); assert.equal(calls, 2); assert.equal(menu.account, 'personal');
  assert.equal(find(menu.render(), 'menu-skill-conflicts').isDisabled, false);
  assert.deepEqual(fake.runs, []); assert.deepEqual(fake.execs, []); assert.deepEqual(fake.closedOverlays, []);
});

test('dismissed menu ignores late optional success and failure', async () => {
  const q = deferred(), u = deferred(); globalThis.menuLoaders = { quotas: () => q.promise, uses: () => u.promise };
  const { menu, cx, errors } = start(); await flush(); menu.close(); const notified = cx.notified;
  q.resolve(quota); u.reject(Error('Synthetic late failure')); await flush();
  assert.deepEqual(errors, []); assert.equal(cx.notified, notified); assert.equal(menu.quotas, null); assert.equal(menu.uses, null);
  assert.equal(menu.historyError, false); assert.deepEqual(fake.runs, []);
});

test('successful optional loads keep quota, ranking and the requested account', async () => {
  const { menu, errors } = start(); await flush();
  assert.deepEqual(errors, []); assert.deepEqual(menu.quotas, quota); assert.equal(menu.uses.review, 4);
  assert.equal(menu.account, 'personal'); assert.equal(find(menu.render(), 'menu-history-unavailable'), null);
  assert.doesNotMatch(text(find(menu.render(), 'menu-usage')), /unavailable/);
});
