import { div } from "gpui-kit";
import { h_flex, v_flex, Button } from "gpui-base";
import { theme, props, closeOverlay } from "herdr";
import { windowLabel } from "./lib/time.js";
import { ACCOUNTS, CODEX, accountOf, chip, loadClaudeQuotas } from "./accounts.js";
import { accountFor } from "./context.js";
import { SKILLS, configuredSkill, launchSkill } from "./skills.js";
import { skillUses, openPrSession } from "./prsession.js";
import { rankSkills, localBranch } from "./lib/prmenu.js";
import { spinner } from "./ui.js";

// The ▾ beside a PR skill: one chip per account, the recommended and most used skills, and a new
// session on the PR in its own worktree. Skills run on Claude accounts; Codex only takes the session.
export class AccountMenu {
  init(_props, cx) {
    this.closed = false;
    this.quotas = null;
    this.uses = null;
    this.quotaError = false;
    this.historyError = false;
    this.account = props()?.current ?? ACCOUNTS[0]?.key;
    // Optional context must not block another source or turn a failed read
    // into an endless spinner. Never change the person's selected account.
    for (const [field, errorField, load] of [
      ["quotas", "quotaError", loadClaudeQuotas], ["uses", "historyError", skillUses],
    ]) cx.spawn(async (cx) => {
      try {
        const value = await load();
        if (this.closed) return;
        this[field] = value;
      } catch {
        if (this.closed) return;
        this[field] = {};
        this[errorField] = true;
      }
      cx.notify();
    });
  }

  close() { this.closed = true; }

  // Keep failures in the picker. Closing it does not cancel an already
  // requested session, but a late result must not touch the disposed menu.
  runSkill(verb, cx) {
    if (this.closed || this.opening || this.busy || this.account === CODEX.key || !configuredSkill(verb)) return;
    this.opening = verb;
    this.error = null;
    const p = props();
    let started;
    try { started = launchSkill(p.pr, verb, this.account, p.folder); }
    catch (e) {
      this.opening = null;
      this.error = `Could not confirm launch: ${e.message ?? e}. Check for an existing session before trying again.`;
      cx.notify(); return;
    }
    if (!started) return closeOverlay(p.overlay);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const error = await started;
        if (this.closed) return;
        if (!error) return closeOverlay(p.overlay);
        this.error = error;
      } catch (e) {
        if (this.closed) return;
        this.error = `Could not confirm launch: ${e.message ?? e}. Check for an existing session before trying again.`;
      }
      this.opening = null;
      cx.notify();
    });
  }

  session(cx) {
    if (this.closed || this.busy || this.opening) return;
    const p = props(), account = this.account;
    if (p.pr.untrusted) return;
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const error = await openPrSession(p.pr, p.folder, account);
        if (this.closed) return;
        if (!error) return closeOverlay(p.overlay);
        this.error = error;
      } catch (e) {
        if (this.closed) return;
        this.error = `Could not confirm launch: ${e.message ?? e}. Check for an existing session before trying again.`;
      }
      this.busy = false;
      cx.notify();
    });
  }

  render() {
    const t = theme(), p = props();
    if (!p?.pr) return div();
    const base = accountFor(p.pr.repo), acct = accountOf(this.account), claude = this.account !== CODEX.key;
    const q = this.quotas?.[this.account];
    const usage = [q?.h5 ? `5h ${q.h5.pct}%` : null, q?.d7 ? `${windowLabel(q.d7, "7d")} ${q.d7.pct}%` : null].filter(Boolean).join(" · ");
    const pickChip = (a) => Button.new(`menu-acct-${a.key}`).id(`menu-acct-${a.key}`).tab_index(0)
      .accessibility_label(`Use ${a.label}${a.key === base ? ", repository default" : ""}`).selected(a.key === this.account)
      .disabled(Boolean(this.opening || this.busy)).focus((s) => s.border_2().border_color(t.accent))
      .min_w(28).min_h(28).p(2).rounded(6).cursor_pointer()
      .when(a.key === this.account, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .tooltip(`${a.label}${a.key === base ? " · repo default" : ""}`)
      .on_click((_e, cx) => {
        if (this.opening || this.busy) return;
        cx.stop_propagation();
        this.account = a.key;
        cx.notify();
      })
      .child(chip(div, a));
    const row = (id, label, note, onClick, enabled = true) => Button.new(id).id(id).tab_index(0).tab_stop(enabled).disabled(!enabled)
      .accessibility_label(`${label}${note ? `. ${note}` : ""}`).tooltip(label)
      .focus((s) => s.border_2().border_color(t.accent)).flex().h(32).px(8).gap(8).items_center().rounded(6)
      .text_size(13).text_color(enabled ? t.foreground : t.dim)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(Boolean(note), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(note)));
    // For conflicts the full PR fix is the other way to go.
    const skills = rankSkills(p.skill, SKILLS, this.uses ?? {}, p.skill === "conflicts" ? ["fix"] : []);
    return v_flex().id("account-menu").w_full().p(4).gap(1).bg(t.popover ?? t.surface).text_color(t.foreground)
      .child(h_flex().px(8).pt(4).pb(4).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`${p.pr.repo.split("/").pop()} #${p.pr.number} with`))
        .children([...ACCOUNTS, CODEX].map(pickChip)))
      .child(div().id("menu-usage").px(8).pb(4).text_size(11).text_color(t.muted)
        .child(this.quotaError ? `${acct.label} · Usage unavailable` : this.quotas ? `${acct.label}${usage ? ` · ${usage}` : ""}` : spinner(t.dim, 10)))
      .child(div().h(1).mx(6).my(2).bg(t.border))
      .when(!configuredSkill(p.skill), (el) => el.child(div().id("menu-skill-unavailable").role("status").px(8).py(4).text_size(11).text_color(t.muted)
        .child("Recommended action is not configured. Choose another listed action or open a session.")))
      .when(this.historyError, (el) => el.child(div().id("menu-history-unavailable").role("status").px(8).py(4).text_size(11).text_color(t.muted)
        .child("Skill history unavailable. Showing configured suggestions.")))
      .children(skills.map(({ verb, uses }) => row(`menu-skill-${verb}`, this.opening === verb ? "Opening…" : SKILLS[verb].name,
        verb === p.skill ? "recommended" : uses ? `used ${uses}×` : "",
        (cx) => this.runSkill(verb, cx), claude && !this.opening && !this.busy)))
      .when(!claude, (el) => el.child(div().px(8).pb(2).text_size(11).text_color(t.dim).child("Skills run on Claude accounts")))
      .child(div().h(1).mx(6).my(2).bg(t.border))
      .child(row("menu-session", this.busy ? "Creating the worktree…" : `New session in a worktree of ${localBranch(p.pr)}`,
        null, (cx) => this.session(cx), !this.busy && !this.opening && !p.pr.untrusted))
      .when(Boolean(p.pr.untrusted), (el) => el.child(div().px(8).pb(4).text_size(11).text_color(t.dim).child("Someone else's fork: check it out yourself")))
      .when(Boolean(this.error), (el) => el.child(div().id("menu-launch-error").role("alert").px(8).pb(4).text_size(11).text_color(t.blocked).child(this.error)));
  }
}
