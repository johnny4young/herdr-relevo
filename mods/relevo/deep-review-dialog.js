// Before a deep review starts: how many reviewers, and each one's account, model and effort, from this setup's own
// accounts (Codex only when it is on and installed). The Inbox launches it, since this dialog closes on Start.
import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { closeOverlay, openOverlay, props, run, setShared, shared, theme } from "herdr";
import { CODEX, accountOf, allAccounts, chip, cliFound, codexOn, runnableAccounts, hasRoom, loadClaudeQuotas, providerFor } from "./accounts.js";
import { bestAlternate, quotaRisk } from "./lib/quota-routing.js";
import { accountFor } from "./context.js";
import * as config from "./config.js";
import { MAX_REVIEWERS, checkDeepReview, recentModels } from "./lib/deep-setup.js";
import { readReport } from "./usage-scan.js";
import { openSettings } from "./settings.js";
import { ago } from "./lib/time.js";
import { reviewTitle } from "./lib/deep-review.js";
import { deepSetup } from "./deep-review.js";
import { button, checkbox, digit, grabFocus, held, keycap } from "./ui.js";

export const DEEP_ASK = "relevo.deep.ask";
export const DEEP_LAST = "relevo.deep.last";
const used = (q) => Math.max(q?.h5?.pct ?? 0, q?.d7?.pct ?? 0);

export function openDeepReview(pr, folder) {
  const keep = ["url", "number", "title", "repo", "headRefOid", "baseRefName", "headRefName", "isCrossRepository"];
  openOverlay({ mod: "relevo", kind: "dialog", width: 560, props: { role: "deep-review", folder, pr: Object.fromEntries(keep.map((k) => [k, pr[k]])) } });
}

export class DeepReviewDialog {
  init(_props, cx) {
    const p = props();
    this.pr = p.pr; this.folder = p.folder;
    this.remember = true;
    this.quotas = null;
    const start = (shared(DEEP_LAST) ?? deepSetup()).filter((r) => r.account === "repo" || providerFor(r.account).caps.accounts || runnableAccounts().some((a) => a.key === r.account));
    this.rows = (start.length ? start : deepSetup()).slice(0, MAX_REVIEWERS).map((r) => this.row(r));
    this.h = cx.focus_handle();
    grabFocus(this.h, cx, () => !this.gone);
    cx.spawn(async (cx) => { this.quotas = await loadClaudeQuotas().catch(() => ({})); cx.notify(); });
    cx.spawn(async (cx) => { this.report = await readReport().catch(() => null); cx.notify(); });
  }

  close() { this.gone = true; this.h?.release(); for (const r of this.rows) r.model.release(); }

  row(r = { account: "repo", model: "sonnet", effort: "high" }) {
    return { account: r.account, effort: r.effort ?? "high", model: InputState.new({ value: r.model ?? "", placeholder: "default" }) };
  }

  setup() {
    return this.rows.map((r) => ({ account: r.account, model: r.model.value().trim(), effort: r.effort }));
  }

  count(n, cx) {
    n = Math.max(1, Math.min(MAX_REVIEWERS, n));
    while (this.rows.length < n) this.rows.push(this.row({ ...this.setup().at(-1) }));
    while (this.rows.length > n) this.rows.pop().model.release();
    this.menu = null;
    cx.notify();
  }

  remove(i, cx) {
    if (this.rows.length < 2) return;
    this.rows.splice(i, 1)[0].model.release();
    this.menu = null;
    cx.notify();
  }

  pick(row, change, cx) {
    Object.assign(row, change);
    const { efforts, models } = providerFor(row.account);
    if (!efforts.includes(row.effort)) row.effort = "high";
    if (change.account) row.model.set_value(!models.length ? "" : models.includes(row.model.value()) ? row.model.value() : "sonnet");
    cx.notify();
  }

  errors() {
    return checkDeepReview(this.setup(), allAccounts());
  }

  // Pre-flight check: flags reviewers whose account is full, near 90%, or filling within 15 minutes.
  quotaAdvice() {
    if (!this.quotas) return [];
    const candidates = runnableAccounts().map((a) => a.key);
    return this.rows.map((r, i) => {
      const resolved = r.account === "repo" ? accountFor(this.pr.repo) : r.account;
      const risk = quotaRisk(this.quotas?.[resolved]);
      if (!risk) return null;
      const alt = bestAlternate(resolved, candidates, this.quotas);
      return { index: i, row: r, account: resolved, risk, alt };
    }).filter(Boolean);
  }

  switchTightAccounts(cx) {
    for (const item of this.quotaAdvice()) {
      if (item.alt) this.pick(item.row, { account: item.alt.key }, cx);
    }
  }

  // The Inbox outlives this dialog: it takes the ask and opens the reviewers.
  start() {
    if (this.errors().length) return;
    if (this.remember) setShared(DEEP_LAST, this.setup());
    setShared(DEEP_ASK, { pr: this.pr, folder: this.folder, setup: this.setup(), at: Date.now() });
    run("relevo.deep-review-start");
    closeOverlay(props().overlay);
  }

  key(e, cx) {
    if (e.key === "escape") { cx.stop_propagation(); if (this.menu) { this.menu = null; return cx.notify(); } return closeOverlay(props().overlay); }
    if (e.key === "enter" && !held(e)) { cx.stop_propagation(); return this.start(); }
    if (this.typing() || held(e)) return;
    const n = digit(e);
    if (n && n <= MAX_REVIEWERS) { cx.stop_propagation(); this.count(n, cx); }
    else if (e.key === "+" || e.key === "=") { cx.stop_propagation(); this.count(this.rows.length + 1, cx); }
    else if (e.key === "-") { cx.stop_propagation(); this.count(this.rows.length - 1, cx); }
  }

  typing() {
    return this.rows.some((r) => r.model.focused?.());
  }

  // A pill that opens its options under the row; the open one is `this.menu`.
  pill(t, i, field, content, width) {
    const open = this.menu?.i === i && this.menu.field === field;
    return h_flex().id(`deep-${i}-${field}`).w(width).flex_none().h(28).px(8).gap(6).items_center().rounded(7).border_1()
      .border_color(open ? t.accent : t.border).bg(open ? t.selected : t.background).cursor_pointer().hover((st) => st.border_color(t.accent))
      .on_click((_e, cx) => { this.menu = open ? null : { i, field }; cx.notify(); })
      .child(h_flex().flex_1().min_w(0).gap(6).items_center().children(content))
      .child(div().flex_none().text_size(11).text_color(t.dim).child("▾"));
  }

  // Each account with its letter, its color and how much of its quota is used.
  accountChoice(t, key) {
    const repo = key === "repo", acct = accountOf(repo ? accountFor(this.pr.repo) : key), q = this.quotas?.[acct.key], pct = q ? Math.round(used(q)) : null;
    const full = q && !hasRoom(q);
    return [chip(div, acct, 16), div().min_w(0).truncate().text_size(13).text_color(full ? t.dim : t.foreground).child(repo ? `${acct.label} · repo's` : acct.label),
      ...(pct === null ? [] : [h_flex().flex_none().w(36).h(4).rounded(2).bg(t.border).child(div().h_full().rounded(2).w(Math.max(2, Math.round(36 * pct / 100)))
        .bg(pct >= 90 ? t.blocked : pct >= 60 ? t.ansi3 : t.done)), div().flex_none().text_size(11).text_color(t.dim).child(`${pct}%`)])];
  }

  // Models this account used here lately, newest first, then the names its CLI takes for any of them.
  modelOptions(r) {
    const key = r.account === "repo" ? accountFor(this.pr.repo) : r.account, { models } = providerFor(key);
    const recent = recentModels(this.report, key).slice(0, 5).map(({ model, day }) => ({ model, note: `used ${ago(Date.parse(day) / 1000)}` }));
    const names = (models.length ? models : [""]).filter((m) => !recent.some((x) => x.model === m)).map((model) => ({ model, note: model ? "latest" : "" }));
    return [...recent, ...names];
  }

  menuView(t, r, i) {
    const field = this.menu?.field, provider = providerFor(r.account), pickable = provider.models.length > 0;
    const option = (id, content, on, pick) => h_flex().id(id).h(28).px(8).gap(6).items_center().rounded(6).cursor_pointer()
      .when(on, (el) => el.bg(t.selected)).hover((st) => st.bg(t.hover)).on_click((_e, cx) => { pick(cx); this.menu = null; cx.notify(); }).children(content);
    // Codex installed but off in Settings shows, dimmed, with the way to turn it on.
    const codexOff = !codexOn() && config.USE_CODEX === false && cliFound("codex");
    const list = field === "account" ? [...["repo", ...runnableAccounts().map((a) => a.key)].map((key) => option(`deep-${i}-account-${key}`, this.accountChoice(t, key), r.account === key,
        (cx) => this.pick(r, { account: key }, cx))),
      ...(codexOff ? [h_flex().id(`deep-${i}-account-codex-off`).h(28).px(8).gap(6).items_center().opacity(0.5)
        .child(chip(div, CODEX, 16)).child(div().text_size(13).child("Codex"))
        .child(div().id(`deep-${i}-codex-on`).text_size(11).text_color(t.accent).cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); closeOverlay(props().overlay); openSettings(); })
          .child("off in Settings · turn on"))] : [])]
      : field === "model" ? this.modelOptions(r).map(({ model, note }) => option(`deep-${i}-model-${model || "default"}`,
        [div().text_size(13).child(model || (provider.defaultModel(config) ? `default · ${provider.defaultModel(config)}` : "default")),
          ...(note ? [div().text_size(11).text_color(t.dim).child(note)] : [])], r.model.value() === model, () => r.model.set_value(model)))
      : provider.efforts.map((e) => option(`deep-${i}-effort-${e}`, [div().text_size(13).child(e)], r.effort === e, (cx) => this.pick(r, { effort: e }, cx)));
    return v_flex().id(`deep-${i}-menu`).w_full().p(4).gap(1).rounded(8).border_1().border_color(t.border).bg(t.popover ?? t.surface)
      .children(list)
      .when(field === "model" && pickable, (el) => el.child(h_flex().h(28).px(8).gap(6).items_center()
        .child(div().text_size(11).text_color(t.dim).child("Other"))
        .child(div().flex_1().h(24).px(6).flex().items_center().rounded(6).border_1().border_color(t.border).bg(t.background).text_size(13).child(Input.new(r.model).w_full()))));
  }

  reviewerView(t, r, i) {
    return v_flex().id(`deep-row-${i}`).w_full().min_w(0).gap(4)
      .child(h_flex().w_full().min_w(0).gap(8).items_center()
        .child(div().w(18).flex_none().text_size(11).text_color(t.dim).child(String(i + 1)))
        .child(this.pill(t, i, "account", this.accountChoice(t, r.account), 230))
        .child(this.pill(t, i, "model", [div().text_size(13).child(r.model.value() || "default")], 110))
        .child(this.pill(t, i, "effort", [div().text_size(13).child(r.effort)], 96))
        .child(div().flex_1())
        .when(this.rows.length > 1, (el) => el.child(div().id(`deep-${i}-remove`).size(24).flex().items_center().justify_center().rounded(6)
          .text_color(t.dim).cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip("Remove this reviewer")
          .on_click((_e, cx) => this.remove(i, cx)).child("×"))))
      .when(this.menu?.i === i, (el) => el.child(div().pl(26).child(this.menuView(t, r, i))));
  }

  render() {
    const t = theme(), errors = this.errors(), n = this.rows.length, advice = this.quotaAdvice();
    const switchTarget = advice.find((a) => a.alt)?.alt ?? null;
    return v_flex().id("deep-review-dialog").w_full().p(18).gap(14).bg(t.popover ?? t.surface).text_color(t.foreground).text_size(13)
      .track_focus(this.h).on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(reviewTitle({ url: this.pr.url, number: this.pr.number, head: this.pr.headRefOid })))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`${n} ${n === 1 ? "reviewer" : "reviewers"}`)))
      .child(v_flex().gap(8).children(this.rows.map((r, i) => this.reviewerView(t, r, i)))
        .when(n < MAX_REVIEWERS, (el) => el.child(h_flex().id("deep-add").pl(26).gap(6).items_center().cursor_pointer().text_size(11).text_color(t.accent)
          .on_click((_e, cx) => this.count(n + 1, cx)).child(keycap(t, "+")).child("Add reviewer"))))
      .when(advice.length > 0, (el) => el.child(h_flex().id("deep-quota-warn").px(10).py(6).gap(8).items_center().rounded(7).bg(t.raised)
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.ansi3)
          .child(advice.map((a) => `${accountOf(a.account).label} ${a.risk.reason}`).join(" · ")))
        .when(Boolean(switchTarget), (row) => row.child(button(t, "deep-quota-switch", `Switch to ${accountOf(switchTarget.key).label}`,
          (cx) => this.switchTightAccounts(cx), { size: "sm", kind: "outline" })))))
      .children(errors.map((e, i) => div().id(`deep-error-${i}`).text_size(11).text_color(t.blocked).child(e.message)))
      .child(h_flex().gap(8).items_center().pt(4).border_t(1).border_color(t.border)
        .child(h_flex().id("deep-remember").pt(10).gap(6).items_center().cursor_pointer().on_click((_e, cx) => { this.remember = !this.remember; cx.notify(); })
          .child(checkbox(t, this.remember)).child(div().text_size(11).text_color(t.muted).child("Remember for next time")))
        .child(div().flex_1())
        .child(div().pt(10).child(button(t, "deep-cancel", [keycap(t, "esc"), "Cancel"], () => closeOverlay(props().overlay), { kind: "ghost" })))
        .child(div().pt(10).child(button(t, "deep-start", [keycap(t, "enter"), `Start ${n} ${n === 1 ? "reviewer" : "reviewers"}`], () => this.start(), { kind: "solid", disabled: errors.length > 0 }))));
  }
}
