import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake, theme } from './fake/herdr.mjs';
import { fakeCx, find, click, text } from './fake/ui.mjs';
const { AccountStatus, openAccountStatus } = await import('../account-status.js');
const { accountNote, quotaFreshness, quotaRingDots, quotaStatusText, tightestWindow } = await import('../lib/account-status.js');
const { ACCOUNTS, CODEX } = await import('../accounts.js');
const { resetClock } = await import('../lib/time.js');
const { meTint } = await import('../ui.js');
const t = theme();
const press = (tree, key, cx = fakeCx(), modifiers = {}) => find(tree, 'account-status-detail').handlers.on_key_down({ key, modifiers }, cx);

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

test('details show fresh, stale and unavailable accounts as band rows with the reset, plus controls', () => {
  const view = new AccountStatus();
  view.detail = true;
  const now = Date.now() / 1000, current = ACCOUNTS[0], stale = ACCOUNTS[1], unavailable = CODEX;
  const h5 = { pct: 30, resets: now + 3600, pace: 0.5 }, d7 = { pct: 60, resets: now + 86400, pace: 0.4 };
  view.quota = {
    [current.key]: { updated: now - 120, h5, d7 },
    [stale.key]: { updated: now - 3601, h5: { pct: 95, resets: now + 60 }, d7: null },
    [unavailable.key]: null,
  };
  fake.props = { overlay: 'account-popup' };
  const tree = view.render();
  assert.equal(text(find(tree, 'account-status-read')), 'read 2m ago', 'the header says how old the newest reading is');
  assert.equal(text(find(tree, `acct-note-${current.key}`)), 'focused repository');
  assert.equal(text(find(tree, `acct-note-${stale.key}`)), 'stale · read 1h ago');
  assert.equal(text(find(tree, `acct-note-${unavailable.key}`)), '');
  assert.equal(text(find(tree, `account-status-${unavailable.key}-unknown`)), 'Usage unavailable · no reading yet');
  assert.equal(find(tree, `account-status-${unavailable.key}-h5`), null, 'an unknown account draws no bands');
  assert.ok(find(tree, 'account-status-details-scroll'), 'accounts scroll inside the viewport-bounded popup');
  assert.equal(text(find(tree, `account-status-${current.key}-h5`)), `5h 30% · resets ${resetClock(h5)}`);
  assert.equal(text(find(tree, `account-status-${current.key}-d7`)), `Weekly 60% · resets ${resetClock(d7)}`);
  assert.equal(text(find(tree, `account-status-${stale.key}-d7`)), 'Weekly no data');
  assert.match(find(tree, `account-status-${stale.key}-h5`).tip, /stale reading/);
  assert.equal(find(tree, `account-status-card-${stale.key}`).fill, meTint(t), 'an account at 80% or over is tinted');
  assert.equal(find(tree, `account-status-card-${current.key}`).fill, null);
  assert.ok(find(tree, 'account-status-settings'));
  assert.equal(text(find(tree, 'account-status-refresh')), 'R Refresh');
  assert.ok(find(tree, 'focus-all'), 'the existing focus/context control remains available');
  assert.equal(text(find(tree, `acct-action-${current.key}`)), '1 Start here');
  assert.equal(text(find(tree, `acct-action-${unavailable.key}`)), '3 Start here');
  click(find(tree, `acct-action-${current.key}`), fakeCx());
  assert.equal(fake.runs.at(-1)[0], 'tab.new');
  assert.deepEqual(fake.closedOverlays, ['account-popup']);
});

test('an account says what stops it first: full soon, then the tight long window', () => {
  const view = new AccountStatus();
  view.detail = true;
  const now = Date.now() / 1000, [soon, weekly] = ACCOUNTS;
  const calm = { pct: 12, resets: now + 3600, pace: 0.5 };
  view.quota = {
    [soon.key]: { updated: now, h5: { pct: 90, resets: now + 3600, pace: 0.8 }, d7: { pct: 58, resets: now + 86400, pace: 0.5 } },
    [weekly.key]: { updated: now, h5: calm, d7: { pct: 64, resets: now + 86400, pace: 0.9 } },
    [CODEX.key]: { updated: now, h5: calm, d7: { pct: 64, resets: now + 86400, pace: 0.9, span: 30 * 86400 } },
  };
  const tree = view.render();
  assert.equal(text(find(tree, `acct-note-${soon.key}`)), 'full in 27 min at this pace', 'it outranks "focused repository"');
  assert.equal(find(tree, `account-status-card-${soon.key}`).fill, meTint(t));
  assert.equal(text(find(tree, `acct-note-${weekly.key}`)), 'weekly window is the tight one');
  assert.equal(text(find(tree, `acct-note-${CODEX.key}`)), '30d window is the tight one');
  assert.match(text(find(tree, `account-status-${CODEX.key}-d7`)), /^30d 64% · resets /);
  assert.equal(accountNote({ updated: now, h5: calm, d7: { pct: 20, resets: now + 86400 } }), null, 'a calm account says nothing');
  assert.equal(accountNote({ updated: now, h5: { pct: 60, resets: now + 5 * 3600, pace: 0.4 } }), null, 'full in more than an hour is not said');
  assert.equal(accountNote({ updated: now - 7200, h5: { pct: 90, resets: now + 3600, pace: 0.8 } }).kind, 'stale', 'an old reading predicts nothing');
  assert.equal(accountNote(null, { focused: true }).text, 'focused repository');
});

test('number keys run each account\'s action and R refreshes, only without a modifier', () => {
  const view = new AccountStatus();
  view.detail = true;
  view.quota = {};
  let loads = 0;
  view.load = () => { loads += 1; };
  fake.props = { overlay: 'account-popup' };
  const tree = view.render();
  press(tree, '2');
  assert.equal(fake.runs.length, 1);
  assert.equal(fake.runs[0][0], 'tab.new');
  assert.ok(fake.runs[0][1].argv.join(' ').includes(ACCOUNTS[1].launcher), 'the second row starts the second account');
  press(tree, '3');
  assert.ok(fake.runs[1][1].argv.join(' ').includes('codex'));
  press(tree, '9');
  press(tree, '1', fakeCx(), { platform: true });
  press(tree, 'x');
  assert.equal(fake.runs.length, 2, 'a key with no row, or a chord, does nothing');
  press(tree, 'r');
  assert.equal(loads, 1);
  press(tree, 'r', fakeCx(), { control: true });
  assert.equal(loads, 1);
});

test('an account near full with an agent offers the handoff, by click and by number', () => {
  const view = new AccountStatus();
  view.detail = true;
  const now = Date.now() / 1000, [full, other] = ACCOUNTS;
  view.quota = {
    [full.key]: { updated: now, h5: { pct: 99, resets: now + 3600 }, d7: null },
    [other.key]: { updated: now, h5: { pct: 99, resets: now + 3600 }, d7: null },
  };
  fake.props = { overlay: 'account-popup' };
  assert.equal(text(find(view.render(), `acct-action-${full.key}`)), '1 Start here', 'with no agent to move there is nothing to continue');
  fake.terminals = [{ address: 't1', labels: { 'agent.account': full.key } }];
  fake.agents = [{ address: 't1', pane: 'p1', space: 'sp1', tab_name: 'work', status: 'working' }];
  const tree = view.render();
  assert.equal(text(find(tree, `acct-action-${full.key}`)), '1 Continue with…');
  assert.equal(text(find(tree, `acct-action-${other.key}`)), '2 Start here', 'the agent belongs to the other account');
  for (const act of [() => click(find(tree, `acct-action-${full.key}`), fakeCx()), () => press(tree, '1')]) {
    fake.overlays.length = 0;
    fake.closedOverlays.length = 0;
    act();
    assert.equal(fake.overlays.at(-1).props.role, 'handoff');
    assert.equal(fake.overlays.at(-1).props.terminal, 't1');
    assert.equal(fake.overlays.at(-1).props.reason, 'quota');
    assert.deepEqual(fake.closedOverlays, ['account-popup']);
    assert.equal(fake.runs.some(([name]) => name === 'tab.new'), false, 'no new session starts');
  }
  view.quota[full.key].h5.pct = 94;
  assert.equal(text(find(view.render(), `acct-action-${full.key}`)), '1 Start here');
});

test('the status item has six states, each drawn and each said', () => {
  const now = Date.now() / 1000, [mine, other] = ACCOUNTS;
  const leaf = (quota, width = 440) => {
    const view = new AccountStatus();
    view.detail = false;
    view.width = width;
    view.quota = quota;
    return { view, tree: view.render() };
  };
  const item = (tree, account) => find(tree, `account-status-${account.key}`);
  const ringFill = (tree, account) => find(tree, `account-status-ring-${account.key}-dot-0`).fill;
  const fresh = (pct, resets = now + 3600) => ({ updated: now, h5: { pct, resets }, d7: null });

  // focused: chip, name and ring.
  let { tree } = leaf({ [mine.key]: fresh(12), [other.key]: fresh(58) });
  assert.equal(text(item(tree, mine)), `${mine.letter} ${mine.label}`);
  assert.equal(ringFill(tree, mine), t.accent);
  assert.match(item(tree, mine).accessibleLabel, /Focused repository/);
  assert.equal(item(tree, mine).fill, null);

  // 50–79%: the ring turns ansi3 and no number is shown.
  assert.equal(text(item(tree, other)), other.letter);
  assert.equal(ringFill(tree, other), t.ansi3);
  assert.match(item(tree, other).accessibleLabel, /58% used.*Over half used/);
  assert.doesNotMatch(item(tree, other).accessibleLabel, /Focused repository/);

  // 80% and over: number, tint, and the reset when it fits.
  const high = fresh(99);
  ({ tree } = leaf({ [other.key]: high }));
  assert.equal(text(item(tree, other)), `${other.letter} 99% resets ${resetClock(high.h5)}`);
  assert.equal(item(tree, other).fill, meTint(t));
  assert.equal(ringFill(tree, other), t.blocked);
  assert.match(item(tree, other).accessibleLabel, new RegExp(`Nearly full, resets ${resetClock(high.h5)}`));
  ({ tree } = leaf({ [other.key]: high }, 300));
  assert.equal(text(item(tree, other)), `${other.letter} 99%`, 'the reset goes first when the block is short');

  // stale: a dim ring and the age of the reading.
  ({ tree } = leaf({ [other.key]: { ...fresh(46), updated: now - 42 * 60 } }));
  assert.equal(text(item(tree, other)), `${other.letter} 42m`);
  assert.equal(ringFill(tree, other), t.dim);
  assert.match(item(tree, other).accessibleLabel, /Stale reading, read 42m ago/);

  // unknown: "?" in an empty ring, never a number.
  assert.equal(text(item(tree, CODEX)), `${CODEX.letter} ?`);
  assert.equal(ringFill(tree, CODEX), t.raised);
  assert.match(item(tree, CODEX).accessibleLabel, /Usage unknown/);

  // narrow: chips and rings only; the label still says what the item no longer shows.
  let view;
  ({ view, tree } = leaf({ [mine.key]: { ...fresh(12), updated: now - 42 * 60 }, [other.key]: high }, 150));
  assert.equal(text(item(tree, mine)), mine.letter);
  assert.equal(text(item(tree, other)), other.letter);
  assert.equal(item(tree, other).fill, meTint(t));
  assert.ok(find(tree, `account-status-ring-${CODEX.key}-marker`));
  assert.match(item(tree, other).accessibleLabel, new RegExp(`${other.label}.*99% used.*Nearly full`));
  assert.match(item(tree, mine).accessibleLabel, new RegExp(`${mine.label}.*Focused repository.*Stale reading`));

  // The block reports its own width.
  const cx = fakeCx();
  find(tree, 'account-status').handlers.on_size_change({ width: 151, height: 28 }, cx);
  assert.equal(cx.notified, 1);
  assert.equal(text(item(view.render(), mine)), `${mine.letter} ${mine.label} 42m`);
});

test('status popup omits fixed height and explains unknown usage in its tooltip', () => {
  openAccountStatus();
  assert.deepEqual(fake.overlays.at(-1), { mod: 'relevo', kind: 'popup', width: 420, props: { role: 'account-status', detail: true } });
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
