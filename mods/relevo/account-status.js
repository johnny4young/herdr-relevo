import { div } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { closeOverlay, focused, openOverlay, panes, props, theme } from 'herdr';
import { Sidebar } from './sidebar.js';
import { ACCOUNTS, CODEX, chip } from './accounts.js';
import { accountFor } from './context.js';
import { openSettings } from './settings.js';
import { button, overlayHeight } from './ui.js';
import { ago, resetText } from './lib/time.js';
import { quotaFreshness, quotaRingDots, quotaStatusText } from './lib/account-status.js';

const ACCOUNTS_ALL = [...ACCOUNTS, CODEX];

export function openAccountStatus() {
  openOverlay({ mod: 'relevo', kind: 'popup', width: 360, props: { role: 'account-status', detail: true } });
}

export class AccountStatus extends Sidebar {
  init(_props, cx) {
    this.detail = _props?.detail === true;
    if (!this.detail) return super.init(_props, cx);
    this.quota = {};
    this.load(cx);
    cx.timer.every(30000, (cx) => this.load(cx));
  }

  focusedAccount() {
    const focus = focused();
    const pane = focus?.pane ? panes().find((item) => item.pane === focus.pane) : null;
    return ACCOUNTS.find((item) => item.key === accountFor(pane?.cwd ?? focus?.cwd)) ?? ACCOUNTS[0] ?? CODEX;
  }

  freshnessText(account, quota) {
    const freshness = quotaFreshness(quota);
    if (freshness === 'unknown') return `${account.label} · 5h usage unavailable`;
    const updated = Number.isFinite(quota.updated) ? ` · last updated ${ago(quota.updated)}` : '';
    return `${account.label} · ${quotaStatusText(quota, freshness)}${updated}`;
  }

  ring(t, account, quota, id) {
    const freshness = quotaFreshness(quota);
    const pct = quota?.h5?.pct;
    const color = freshness !== 'fresh' ? t.dim : pct >= 80 ? t.blocked : pct >= 50 ? t.ansi3 : t.accent;
    const info = this.freshnessText(account, quota);
    return div().id(id).relative().size(18).flex_none().tooltip(`${info}. Click to view weekly usage and account controls.`)
      .children(quotaRingDots(pct).map((dot) => div().id(`${id}-dot-${dot.index}`).absolute().left(dot.x).top(dot.y).size(2).rounded(1)
        .bg(dot.active ? color : t.raised)))
      .when(freshness !== 'fresh', (el) => el.child(div().id(`${id}-marker`).absolute().left(0).top(0).size(18).flex().items_center().justify_center()
        .text_size(11).font_semibold().text_color(t.foreground).child(freshness === 'stale' ? '!' : '?')));
  }

  statusLeaf(t) {
    const current = this.focusedAccount();
    return h_flex().id('account-status').w_full().h_full().px(3).gap(3).items_center()
      .children(ACCOUNTS_ALL.map((account) => {
        const quota = this.quota?.[account.key], status = quotaFreshness(quota);
        const detail = this.freshnessText(account, quota);
        return button(t, `account-status-${account.key}`,
          [chip(div, account, 14), div().w(52).min_w(0).truncate().text_size(11).text_color(account.key === current.key ? t.foreground : t.muted).child(account.label), this.ring(t, account, quota, `account-status-ring-${account.key}`)],
          () => openAccountStatus(), { tip: `${detail}. Open detailed account usage and controls.`, accessibleLabel: `${account.label}. ${detail}. Open account usage details` })
          .h(28).px(4).gap(5).rounded(6).when(status === 'fresh', (el) => el.hover((s) => s.bg(t.hover)));
      }));
  }

  usageWindow(t, account, name, value, stale) {
    const label = name === 'h5' ? '5h window' : '7d window';
    const percent = Number.isFinite(value?.pct) ? `${Math.round(value.pct)}% used` : 'Usage unavailable';
    const reset = value ? resetText(value) : null;
    return v_flex().id(`account-status-${account.key}-${name}`).w(150).min_w(0).gap(2)
      .tooltip(value ? `${label} · ${percent} · ${stale ? 'stale reading' : 'current reading'}${reset ? ` · ${reset}` : ''}` : `${label} unavailable`)
      .child(div().text_size(11).text_color(t.muted).child(label))
      .child(div().text_size(13).text_color(stale || !value ? t.dim : t.foreground).child(percent))
      .child(div().text_size(11).text_color(t.dim).truncate().child(reset ?? 'No reset time available'));
  }

  detailView(t) {
    const overlay = props()?.overlay;
    const close = () => { if (overlay) closeOverlay(overlay); };
    return v_flex().id('account-status-detail').w_full().h(overlayHeight(500, 0.85)).overflow_hidden().p(9).gap(6).bg(t.popover ?? t.surface).text_color(t.foreground)
      .child(h_flex().justify_between().items_center().gap(8)
        .child(div().font_semibold().text_size(13).child('Account usage'))
        .child(h_flex().gap(4)
          .child(button(t, 'account-status-settings', 'Settings', () => { close(); openSettings(); }, { size: 'sm', tip: 'Configure accounts and repository contexts' }))
          .child(button(t, 'account-status-refresh', 'Refresh', (cx) => this.load(cx), { size: 'sm', tip: 'Read the latest available quota snapshot' }))))
      .child(this.focusPicker(t))
      .child(v_flex().id('account-status-details-scroll').flex_1().min_h(0).overflow_y_scrollbar().gap(6).children(ACCOUNTS_ALL.map((account) => {
        const quota = this.quota?.[account.key], freshness = quotaFreshness(quota), stale = freshness !== 'fresh';
        const status = freshness === 'unknown' ? 'Unavailable' : freshness === 'stale' ? `Stale · ${Number.isFinite(quota.updated) ? ago(quota.updated) : 'time unknown'}` : 'Current';
        return v_flex().id(`account-status-card-${account.key}`).w_full().p(7).gap(5).rounded(7).bg(t.background).border_1().border_color(t.border)
          .child(h_flex().items_center().gap(6)
            .child(chip(div, account, 16))
            .child(div().flex_1().min_w(0).truncate().font_medium().text_size(13).child(account.label))
            .child(div().text_size(11).text_color(stale ? t.dim : t.muted).child(status))
            .child(button(t, `account-status-start-${account.key}`, 'Start here', (cx) => { this.launch(account.key); close(); }, { size: 'sm', tip: `Start ${account.label} in the focused repository` })))
          .child(h_flex().gap(8).children([
            this.usageWindow(t, account, 'h5', quota?.h5, stale),
            this.usageWindow(t, account, 'd7', quota?.d7, stale),
          ]));
      })))
      .child(div().role('status').text_size(11).text_color(t.dim).child('Quota is an estimate from the latest available account snapshot. Stale or unavailable values are shown as such.'));
  }

  render() {
    const t = theme();
    return this.detail ? this.detailView(t) : this.statusLeaf(t);
  }
}
