// Before a deep review starts: how many reviewers, and each one's account, model and effort, from this setup's own
// accounts (Codex only when it is on and installed). The Inbox launches it, since this dialog closes on Start.
import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { closeOverlay, openOverlay, props, run, setShared, shared, theme } from "herdr";
import { CODEX, accountOf, agentAccounts, codexOn, hasRoom, loadClaudeQuotas } from "./accounts.js";
import { accountFor } from "./context.js";
import * as config from "./config.js";
import { CLAUDE_EFFORTS, CODEX_EFFORTS, MAX_REVIEWERS, checkDeepReview } from "./lib/deep-setup.js";
import { reviewTitle } from "./lib/deep-review.js";
import { deepSetup } from "./deep-review.js";
import { button, checkbox, digit, grabFocus, held, keycap } from "./ui.js";

export const DEEP_ASK = "relevo.deep.ask";
export const DEEP_LAST = "relevo.deep.last";
const CLAUDE_MODELS = ["opus", "sonnet", "haiku"];
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
    const start = (shared(DEEP_LAST) ?? deepSetup()).filter((r) => r.account !== CODEX.key || codexOn());
    this.rows = (start.length ? start : deepSetup()).slice(0, MAX_REVIEWERS).map((r) => this.row(r));
    this.h = cx.focus_handle();
    grabFocus(this.h, cx, () => !this.gone);
    cx.spawn(async (cx) => { this.quotas = await loadClaudeQuotas().catch(() => ({})); cx.notify(); });
  }

  close() { this.gone = true; for (const r of this.rows) r.model.release(); }

  row(r = { account: "repo", model: "sonnet", effort: "high" }) {
    return { account: r.account, effort: r.effort ?? "high", model: InputState.new({ value: r.model ?? "", placeholder: "default" }) };
  }

  setup() {
    return this.rows.map((r) => ({ account: r.account, model: r.model.value().trim(), effort: r.effort }));
  }

  count(n, cx) {
    while (this.rows.length < n) this.rows.push(this.row({ ...this.setup().at(-1) }));
    while (this.rows.length > n) this.rows.pop().model.release();
    cx.notify();
  }

  pick(row, change, cx) {
    Object.assign(row, change);
    const efforts = row.account === CODEX.key ? CODEX_EFFORTS : CLAUDE_EFFORTS;
    if (!efforts.includes(row.effort)) row.effort = "high";
    if (change.account) row.model.set_value(row.account === CODEX.key ? "" : CLAUDE_MODELS.includes(row.model.value()) ? row.model.value() : "sonnet");
    cx.notify();
  }

  errors() {
    return checkDeepReview(this.setup(), agentAccounts().map((a) => a.key).filter((k) => k !== CODEX.key), CODEX.key);
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
    if (e.key === "escape") { cx.stop_propagation(); return closeOverlay(props().overlay); }
    if (e.key === "enter" && !held(e)) { cx.stop_propagation(); return this.start(); }
    const n = held(e) ? null : digit(e);
    if (n && n <= MAX_REVIEWERS && !this.typing()) { cx.stop_propagation(); this.count(n, cx); }
  }

  typing() {
    return this.rows.some((r) => r.model.focused?.());
  }

  chips(t, id, options, current, pick) {
    return h_flex().id(id).flex_wrap().gap(4).children(options.map(([value, label, note, dim]) => div().id(`${id}-${value}`).h(24).px(8).flex().items_center().gap(5)
      .rounded(6).border_1().border_color(current === value ? t.accent : t.border).when(current === value, (el) => el.bg(t.selected))
      .cursor_pointer().hover((s) => s.bg(t.hover)).text_size(11).text_color(dim ? t.dim : t.foreground)
      .on_click((_e, cx) => pick(value, cx)).child(label)
      .when(Boolean(note), (el) => el.child(div().text_color(t.dim).child(note)))));
  }

  reviewerView(t, r, i) {
    const repoKey = accountFor(this.pr.repo), codex = r.account === CODEX.key;
    const note = (key) => (this.quotas?.[key] ? `${Math.round(used(this.quotas[key]))}%` : null);
    const accounts = [["repo", `Repo's · ${accountOf(repoKey).label}`, note(repoKey), this.quotas && !hasRoom(this.quotas[repoKey])],
      ...agentAccounts().map((a) => [a.key, a.label, note(a.key), this.quotas && !hasRoom(this.quotas[a.key])])];
    const models = codex ? [["", config.RUN_CODEX_MODEL ? `default · ${config.RUN_CODEX_MODEL}` : "default"]] : CLAUDE_MODELS.map((m) => [m, m]);
    const label = (s) => div().w(56).flex_none().pt(4).text_size(11).text_color(t.dim).child(s);
    return v_flex().id(`deep-row-${i}`).w_full().min_w(0).gap(6).p(10).rounded(8).bg(t.raised)
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(`Reviewer ${i + 1}`))
      .child(h_flex().items_start().gap(6).child(label("Account"))
        .child(this.chips(t, `deep-${i}-account`, accounts, r.account, (account, cx) => this.pick(r, { account }, cx))))
      .child(h_flex().items_start().gap(6).child(label("Model"))
        .child(h_flex().flex_1().min_w(0).flex_wrap().gap(4).items_center()
          .child(this.chips(t, `deep-${i}-model`, models, r.model.value(), (model, cx) => { r.model.set_value(model); cx.notify(); }))
          .child(div().w(130).h(24).px(6).flex().items_center().rounded(6).border_1().border_color(t.border).bg(t.background).text_size(11)
            .child(Input.new(r.model).w_full()))))
      .child(h_flex().items_start().gap(6).child(label("Effort"))
        .child(this.chips(t, `deep-${i}-effort`, (codex ? CODEX_EFFORTS : CLAUDE_EFFORTS).map((e) => [e, e]), r.effort, (effort, cx) => this.pick(r, { effort }, cx))));
  }

  render() {
    const t = theme(), errors = this.errors();
    return v_flex().id("deep-review-dialog").w_full().p(16).gap(12).bg(t.popover ?? t.surface).text_color(t.foreground).text_size(13)
      .track_focus(this.h).on_key_down((e, cx) => this.key(e, cx))
      .child(div().font_semibold().child(reviewTitle({ url: this.pr.url, number: this.pr.number, head: this.pr.headRefOid })))
      .child(h_flex().gap(8).items_center().child(div().text_size(11).text_color(t.dim).child("Reviewers"))
        .child(this.chips(t, "deep-count", [1, 2, 3].map((n) => [n, String(n)]), this.rows.length, (n, cx) => this.count(n, cx))))
      .children(this.rows.map((r, i) => this.reviewerView(t, r, i)))
      .children(errors.map((e, i) => div().id(`deep-error-${i}`).text_size(11).text_color(t.blocked).child(e.message)))
      .child(h_flex().gap(8).items_center()
        .child(h_flex().id("deep-remember").gap(6).items_center().cursor_pointer().on_click((_e, cx) => { this.remember = !this.remember; cx.notify(); })
          .child(checkbox(t, this.remember)).child(div().text_size(11).text_color(t.muted).child("Remember for next time")))
        .child(div().flex_1())
        .child(button(t, "deep-cancel", [keycap(t, "esc"), "Cancel"], () => closeOverlay(props().overlay), { kind: "ghost" }))
        .child(button(t, "deep-start", [keycap(t, "enter"), "Start review"], () => this.start(), { kind: "solid", disabled: errors.length > 0 })));
  }
}
