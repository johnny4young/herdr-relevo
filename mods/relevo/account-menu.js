import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, props, closeOverlay } from "herdr";
import { ACCOUNTS, chip, loadClaudeQuotas } from "./accounts.js";
import { accountFor } from "./context.js";
import { SKILLS, launchSkill } from "./skills.js";
import { spinner } from "./ui.js";

// The ▾ beside a PR skill: every account with its quota, the repo's default marked.
export class AccountMenu {
  init(_props, cx) {
    this.quotas = null;
    cx.spawn(async (cx) => {
      this.quotas = await loadClaudeQuotas();
      cx.notify();
    });
  }

  render() {
    const t = theme(), p = props();
    if (!p?.pr) return div();
    const base = accountFor(p.pr.repo);
    const usage = (q) => [q?.h5 ? `5h ${q.h5.pct}%` : null, q?.d7 ? `7d ${q.d7.pct}%` : null]
      .filter(Boolean).join(" · ") || "no data";
    return v_flex().id("account-menu").size_full().p(4).gap(1).bg(t.popover ?? t.surface).text_color(t.foreground)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child(`${SKILLS[p.skill].name} with…`))
      .children(ACCOUNTS.map((acct) => {
        const q = this.quotas?.[acct.key], full = q?.h5?.pct >= 100 || q?.d7?.pct >= 100;
        return h_flex().id(`menu-${acct.key}`).h(36).px(8).gap(8).items_center().rounded(6).cursor_pointer()
          .when(acct.key === p.current, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click(() => {
            closeOverlay(p.overlay);
            launchSkill(p.pr, p.skill, acct.key, p.folder);
          })
          .child(chip(div, acct))
          .child(v_flex().flex_1().min_w(0)
            .child(h_flex().gap(6).items_center().text_size(12.5)
              .child(acct.label)
              .when(acct.key === base, (el) => el.child(div().text_size(10).text_color(t.dim).child("repo default"))))
            .child(div().text_size(10.5).text_color(full ? t.blocked : t.muted).child(this.quotas ? usage(q) : spinner(t.dim, 10))));
      }));
  }
}
