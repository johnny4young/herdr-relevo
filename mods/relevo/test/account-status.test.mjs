import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, find, click, text } from './fake/ui.mjs';
const { AccountStatus, openAccountStatus } = await import('../account-status.js');
const { quotaFreshness, quotaRingDots, quotaStatusText, tightestWindow } = await import('../lib/account-status.js');
const { ACCOUNTS, CODEX } = await import('../accounts.js');

beforeEach(() => {
  resetFake();
  fake.focused = { pane: 'p1', cwd: '/work/app' };
  fake.panes = [{ pane: 'p1', cwd: '/work/app' }];
});

test('quota ring uses 20 bounded native dots and freshness distinguishes unknown and stale', () => {
  assert.equal(quotaRingDots(40).length, 20);
  assert.equal(quotaRingDots(40).filter((dot) => dot.active).length, 8);
  assert.equal(quotaRingDots(-10).filter((dot) => dot.active).length, 0);
  assert.equal(quotaRingDots(150).filter((dot) => dot.active).length, 20);
  assert.equal(quotaFreshness(null, 1000), 'unknown');
  assert.equal(quotaFreshness({ updated: 100, h5: { pct: 40 } }, 1900), 'fresh');
  assert.equal(quotaFreshness({ updated: 100, h5: { pct: 40 } }, 2000), 'stale');
});

test('status leaf shows every account, unknown values, focus and a keyboard-accessible details trigger', () => {
  const view = new AccountStatus();
  view.detail = false;
  view.quota = { [ACCOUNTS[0].key]: { updated: Date.now() / 1000, h5: { pct: 45, resets: null } } };
  const tree = view.render();
  assert.ok(find(tree, 'account-status'));
  for (const account of [...ACCOUNTS, CODEX]) assert.ok(find(tree, `account-status-${account.key}`));
  assert.ok(find(tree, `account-status-ring-${ACCOUNTS[0].key}-dot-0`));
  assert.match(find(tree, `account-status-${CODEX.key}`).accessibleLabel, /unavailable/);
  assert.equal(find(tree, `account-status-${ACCOUNTS[0].key}`).tabIndex, 0);
  click(find(tree, `account-status-${ACCOUNTS[0].key}`), fakeCx());
  assert.equal(fake.overlays.at(-1).props.role, 'account-status');
  assert.equal(fake.overlays.at(-1).props.detail, true);
  assert.equal(fake.runs.length, 0, 'opening details never starts a session');
});

test('details show current, stale and unavailable five-hour and weekly windows plus controls', () => {
  const view = new AccountStatus();
  view.detail = true;
  const current = ACCOUNTS[0], stale = ACCOUNTS[1], unavailable = CODEX;
  view.quota = {
    [current.key]: { updated: Date.now() / 1000, h5: { pct: 30, resets: Date.now() / 1000 + 3600 }, d7: { pct: 60, resets: Date.now() / 1000 + 86400 } },
    [stale.key]: { updated: Date.now() / 1000 - 3601, h5: { pct: 95, resets: Date.now() / 1000 + 60 }, d7: null },
    [unavailable.key]: null,
  };
  fake.props = { overlay: 'account-popup' };
  const tree = view.render();
  assert.match(text(tree), /Current/);
  assert.match(text(tree), /Stale/);
  assert.match(text(tree), /Unavailable/);
  assert.ok(find(tree, 'account-status-details-scroll'), 'quota cards scroll inside the viewport-bounded popup');
  assert.ok(find(tree, `account-status-${current.key}-h5`));
  assert.ok(find(tree, `account-status-${current.key}-d7`));
  assert.match(text(find(tree, `account-status-${current.key}-h5`)), /5h window 30% used/);
  assert.ok(find(tree, 'account-status-settings'));
  assert.ok(find(tree, 'account-status-refresh'));
  assert.ok(find(tree, 'focus-all'), 'the existing focus/context control remains available');
  click(find(tree, `account-status-start-${current.key}`), fakeCx());
  assert.equal(fake.runs.at(-1)[0], 'tab.new');
  assert.deepEqual(fake.closedOverlays, ['account-popup']);
});

test('status popup omits fixed height and explains unknown usage in its tooltip', () => {
  openAccountStatus();
  assert.deepEqual(fake.overlays.at(-1), { mod: 'relevo', kind: 'popup', width: 360, props: { role: 'account-status', detail: true } });
  const view = new AccountStatus(); view.detail = false; view.quota = {};
  const trigger = find(view.render(), `account-status-${ACCOUNTS[0].key}`);
  assert.match(trigger.tip, /usage unavailable/);
});

test('the tightest window drives the status, and a weekly-only reading is not unavailable', () => {
  const now = Date.now() / 1000;
  const team = { updated: now, h5: { pct: 30, resets: now + 3600 }, d7: { pct: 82, resets: now + 86400 } };
  assert.equal(tightestWindow(team).name, 'd7');
  assert.match(quotaStatusText(team), /^7d 82% used/);
  const weeklyOnly = { updated: now, h5: null, d7: { pct: 11, resets: now + 86400 } };
  assert.equal(quotaFreshness(weeklyOnly), 'fresh');
  assert.match(quotaStatusText({ ...weeklyOnly, updated: now - 4 * 86400 }), /7d 11% used \(stale\)/);
});

test('status bar names only the focused account, shows stale readings and flags 80% with its value', () => {
  const now = Date.now() / 1000, [focused, other] = ACCOUNTS;
  const view = new AccountStatus(); view.detail = false;
  view.quota = {
    [focused.key]: { updated: now - 4 * 86400, h5: { pct: 0, resets: null }, d7: { pct: 11, resets: now + 86400 } },
    [other.key]: { updated: now, h5: { pct: 30, resets: now + 3600 }, d7: { pct: 82, resets: now + 86400 } },
  };
  const tree = view.render();
  assert.match(text(find(tree, `account-status-${focused.key}`)), new RegExp(focused.label));
  assert.doesNotMatch(text(find(tree, `account-status-${other.key}`)), new RegExp(other.label));
  assert.match(find(tree, `account-status-${other.key}`).accessibleLabel, new RegExp(`${other.label}.*7d 82% used`));
  assert.match(text(find(tree, `account-status-${other.key}`)), /82%/);
  assert.equal(find(tree, `account-status-ring-${focused.key}-marker`), null, 'a stale reading stays visible');
  assert.match(find(tree, `account-status-${focused.key}`).tip, /stale.*read 4d ago/);
});

test('a provider window longer than a week is labeled by its real length', async () => {
  const { fromClaude } = await import('../accounts.js');
  const { windowLabel } = await import('../lib/time.js');
  const now = Date.now() / 1000;
  const codex = fromClaude({ updated: now, rate_limits: { seven_day: { used_percentage: 1, resets_at: now + 25 * 86400, window_seconds: 30 * 86400 } } });
  assert.equal(windowLabel(codex.d7, '7d'), '30d');
  assert.match(quotaStatusText(codex), /^30d 1% used/);
  const claude = fromClaude({ updated: now, rate_limits: { seven_day: { used_percentage: 40, resets_at: now + 86400 } } });
  assert.equal(windowLabel(claude.d7, '7d'), '7d');
});
