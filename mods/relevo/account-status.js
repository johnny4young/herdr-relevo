import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { closeOverlay, focused, openOverlay, panes, props, theme } from 'herdr';
import { Sidebar } from './sidebar.js';
import { ACCOUNTS, CODEX, chip } from './accounts.js';
import { accountFor } from './context.js';
import { openSettings } from './settings.js';
import { handoffAgent, handoffFrom } from './handoff.js';
import { band, button, keycap, meTint, overlayHeight, quotaTone } from './ui.js';
import { ago, resetClock, resetText, windowLabel } from './lib/time.js';
import { HANDOFF_AT, QUOTA_WARN, accountNote, quotaFreshness, quotaRingDots, quotaStatusText, readAge, tightestWindow } from './lib/account-status.js';

const ACCOUNTS_ALL = [...ACCOUNTS, CODEX];
// At or under NARROW the status item is chips and rings; a reset time needs RESET_FITS.
const NARROW = 150, RESET_FITS = 360, BAND = 150;
const held = (e) => e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt;

export function openAccountStatus() {
  openOverlay({ mod: 'relevo', kind: 'popup', width: 420, props: { role: 'account-status', detail: true } });
}

export class AccountStatus extends Sidebar {
  init(_props, cx) {
    this.detail = _props?.detail === true;
    if (!this.detail) return super.init(_props, cx);
    this.quota = {};
    this.h = cx.focus_handle();
    this.h.focus();
    // The popup takes the keyboard a moment after it opens.
    cx.timer.after(300, () => this.h.focus());
    this.load(cx);
    // Redrawn even when nothing changed, so the age of the reading keeps counting.
    cx.timer.every(30000, (cx) => {
      this.load(cx);
      cx.notify();
    });
  }

  focusedAccount() {
    const focus = focused();
    const pane = focus?.pane ? panes().find((item) => item.pane === focus.pane) : null;
    return ACCOUNTS.find((item) => item.key === accountFor(pane?.cwd ?? focus?.cwd)) ?? ACCOUNTS[0] ?? CODEX;
  }

  freshnessText(account, quota) {
    const freshness = quotaFreshness(quota);
    if (freshness === 'unknown') return `${account.label} · usage unavailable`;
    const updated = freshness === 'stale' && Number.isFinite(quota.updated) ? ` · read ${ago(quota.updated)}` : '';
    return `${account.label} · ${quotaStatusText(quota, freshness)}${updated}`;
  }

  level(t, quota) {
    const freshness = quotaFreshness(quota), pct = tightestWindow(quota)?.pct;
    if (freshness === 'unknown') return t.dim;
    const color = quotaTone(t, pct);
    return freshness === 'stale' && pct < QUOTA_WARN ? t.dim : color;
  }

  ring(t, account, quota, id) {
    const freshness = quotaFreshness(quota), pct = tightestWindow(quota)?.pct, color = this.level(t, quota);
    return div().id(id).relative().size(18).flex_none()
      .children(quotaRingDots(pct).map((dot) => div().id(`${id}-dot-${dot.index}`).absolute().left(dot.x).top(dot.y).size(2).rounded(1)
        .bg(dot.active ? color : t.raised)))
      .when(freshness === 'unknown', (el) => el.child(div().id(`${id}-marker`).absolute().left(0).top(0).size(18).flex().items_center().justify_center()
        .text_size(11).text_color(t.dim).child('?')));
  }

  // One account in the status bar. Every state it draws is also said in its label.
  statusItem(t, account, { current, narrow, roomy }) {
    const quota = this.quota?.[account.key], status = quotaFreshness(quota), w = tightestWindow(quota), pct = w?.pct;
    const known = status !== 'unknown', stale = status === 'stale', warn = known && pct >= QUOTA_WARN;
    const isFocused = account.key === current.key, reset = resetClock(w), color = this.level(t, quota);
    const detail = this.freshnessText(account, quota);
    const says = [
      isFocused ? 'Focused repository' : null,
      !known ? 'Usage unknown' : null,
      stale ? `Stale reading, ${readAge(quota.updated)}` : null,
      warn ? `Nearly full${reset ? `, resets ${reset}` : ''}` : null,
      known && !stale && !warn && pct >= 50 ? 'Over half used' : null,
    ].filter(Boolean);
    const id = `account-status-${account.key}`;
    return button(t, id,
      [chip(div, account, 14),
        isFocused && !narrow ? div().id(`${id}-name`).max_w(80).min_w(0).truncate().text_size(11).text_color(t.foreground).child(account.label) : null,
        this.ring(t, account, quota, `account-status-ring-${account.key}`),
        warn && !narrow ? div().id(`${id}-pct`).text_size(11).font_semibold().text_color(color).child(`${Math.round(pct)}%`) : null,
        warn && roomy && reset ? div().id(`${id}-reset`).flex_none().text_size(11).text_color(color).child(`resets ${reset}`) : null,
        stale && !narrow && Number.isFinite(quota.updated)
          ? div().id(`${id}-age`).flex_none().text_size(11).text_color(t.dim).child(ago(quota.updated).replace(' ago', '')) : null].filter(Boolean),
      () => openAccountStatus(), { kind: 'ghost', tip: detail, accessibleLabel: `${[detail, ...says].join('. ')}. Open account usage` })
      .h(28).px(4).gap(5).rounded(6).when(warn, (el) => el.bg(meTint(t))).hover((s) => s.bg(t.hover));
  }

  statusLeaf(t) {
    const width = this.width ?? RESET_FITS, state = { current: this.focusedAccount(), narrow: width <= NARROW, roomy: width >= RESET_FITS };
    return h_flex().id('account-status').w_full().h_full().px(3).gap(3).items_center()
      .on_size_change((size, cx) => {
        if (size.width === this.width) return;
        this.width = size.width;
        cx.notify();
      })
      .children(ACCOUNTS_ALL.map((account) => this.statusItem(t, account, state)));
  }

  dismiss() {
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }

  // Start a session, or move the agent of an account about to stop to another one.
  action(account) {
    const pct = tightestWindow(this.quota?.[account.key])?.pct;
    if (pct >= HANDOFF_AT && handoffAgent(account.key)) {
      return {
        label: 'Continue with…', tip: `Continue ${account.label}'s agent with another account`,
        run: () => { this.dismiss(); handoffFrom(account.key); },
      };
    }
    return { label: 'Start here', tip: `Start ${account.label} in the focused repository`, run: () => { this.launch(account.key); this.dismiss(); } };
  }

  key(e, cx) {
    if (held(e)) return;
    const account = /^[1-9]$/.test(e.key) ? ACCOUNTS_ALL[Number(e.key) - 1] : null;
    if (e.key === 'r') this.load(cx);
    else if (account) this.action(account).run(cx);
    else return;
    cx.stop_propagation();
  }

  usageWindow(t, account, name, w, stale) {
    const label = name === 'h5' ? '5h' : windowLabel(w, 'Weekly'), known = Number.isFinite(w?.pct);
    const hot = known && w.pct >= QUOTA_WARN, reset = resetClock(w);
    const value = known ? `${Math.round(w.pct)}%${reset ? ` · resets ${reset}` : ''}` : 'no data';
    return h_flex().id(`account-status-${account.key}-${name}`).h(18).gap(8).items_center()
      .tooltip(known ? `${label} window · ${stale ? 'stale reading' : 'current reading'} · ${resetText(w)}` : `${label} window unavailable`)
      .child(div().w(52).flex_none().text_size(13).text_color(t.muted).child(label))
      .when(known, (el) => el.child(band(t, BAND, w.pct, w.pace, { tone: stale && !hot ? t.dim : null })))
      .child(div().flex_1().min_w(0).truncate().text_right().text_size(13)
        .text_color(hot ? t.blocked : stale || !known ? t.dim : t.muted).when(hot, (el) => el.font_semibold()).child(value));
  }

  section(t, account, index, current) {
    const quota = this.quota?.[account.key], freshness = quotaFreshness(quota), stale = freshness !== 'fresh';
    const note = accountNote(quota, { focused: account.key === current.key }), action = this.action(account);
    const hot = freshness !== 'unknown' && tightestWindow(quota).pct >= QUOTA_WARN;
    return v_flex().id(`account-status-card-${account.key}`).w_full().px(8).py(6).gap(3).rounded(6).when(hot, (el) => el.bg(meTint(t)))
      .child(h_flex().h(26).items_center().gap(7)
        .child(chip(div, account, 16))
        .child(div().flex_none().max_w(120).truncate().font_medium().text_size(13).child(account.label))
        .child(div().id(`acct-note-${account.key}`).flex_1().min_w(0).truncate().text_size(11)
          .text_color(note?.kind === 'full-soon' ? t.blocked : note?.kind === 'stale' ? t.dim : t.muted).child(note?.text ?? ''))
        .child(button(t, `acct-action-${account.key}`, [index < 9 ? keycap(t, String(index + 1)) : null, action.label].filter(Boolean),
          (cx) => action.run(cx), { size: 'sm', tip: action.tip })))
      .when(freshness === 'unknown', (el) => el.child(div().id(`account-status-${account.key}-unknown`).h(18).text_size(13).text_color(t.dim)
        .child('Usage unavailable · no reading yet')))
      .when(freshness !== 'unknown', (el) => el
        .child(this.usageWindow(t, account, 'h5', quota?.h5, stale))
        .child(this.usageWindow(t, account, 'd7', quota?.d7, stale)));
  }

  detailView(t) {
    const current = this.focusedAccount();
    const read = Math.max(...ACCOUNTS_ALL.map((account) => this.quota?.[account.key]?.updated).filter(Number.isFinite));
    return v_flex().id('account-status-detail').w_full().h(overlayHeight(500, 0.85)).overflow_hidden().p(9).gap(6).bg(t.popover ?? t.surface).text_color(t.foreground)
      .when(Boolean(this.h), (el) => el.track_focus(this.h))
      .on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().items_center().gap(8)
        .child(div().flex_none().font_semibold().text_size(13).child('Account usage'))
        .child(div().id('account-status-read').flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(Number.isFinite(read) ? readAge(read) : ''))
        .child(h_flex().flex_none().gap(4)
          .child(button(t, 'account-status-settings', 'Settings', () => { this.dismiss(); openSettings(); }, { kind: 'ghost', size: 'sm', tip: 'Configure accounts and repository contexts' }))
          .child(button(t, 'account-status-refresh', [keycap(t, 'R'), 'Refresh'], (cx) => this.load(cx), { size: 'sm', tip: 'Read the latest available quota snapshot' }))))
      .child(this.focusPicker(t))
      .child(v_flex().id('account-status-details-scroll').flex_1().min_h(0).overflow_y_scrollbar().gap(3)
        .children(ACCOUNTS_ALL.flatMap((account, index) => [
          index ? div().h(1).flex_none().bg(t.border).opacity(0.55) : null,
          this.section(t, account, index, current),
        ]).filter(Boolean)));
  }

  render() {
    const t = theme();
    return this.detail ? this.detailView(t) : this.statusLeaf(t);
  }
}
