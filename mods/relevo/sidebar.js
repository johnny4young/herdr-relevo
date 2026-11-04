import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, focused, panes, setShared, notify } from "herdr";
import { BackgroundWatch, quotaAlerts } from "./alerts.js";
import { ACCOUNTS, CODEX, API_QUOTAS, launchArgv, chip, loadClaudeQuotas } from "./accounts.js";
import { FOCUS, focus, publishSetup, contextOfPath } from "./context.js";
import { ago, resetText, resetClock, runsOut, clock, FIVE_HOURS, WEEK } from "./lib/time.js";

const LENGTH = { "5h": FIVE_HOURS, "7d": WEEK };
// The reset, and when the window runs out first at the pace used so far.
const meterTip = (w, label) => {
  const out = runsOut(w, LENGTH[label]);
  return out ? `${resetText(w)} · at this pace 100% at ${clock(out)}` : resetText(w);
};
import { collectQuotas } from "./quota.js";
import { syncFolders, foldFor } from "./folders.js";
import { CONTEXTS, FALLBACK } from "./config.js";
import { mostMargin } from "./lib/margin.js";
import { ledgerTick } from "./ledger.js";
import { spinner, withKey } from "./ui.js";
import { openSettings } from "./settings.js";

// Chip and label; wide enough for an 8-letter account name.
const NAME_W = 92;

const STALE = 30 * 60;

export class Sidebar {
  init(_props, cx) {
    this.quota = {};
    publishSetup(ACCOUNTS);
    this.width = 268;
    // The snapshots on disk answer at once; the usage endpoints follow.
    this.load(cx);
    this.collect(cx);
    cx.timer.every(30000, (cx) => this.load(cx));
    cx.timer.every(300000, (cx) => this.collect(cx));
    cx.spawn(async () => {
      await syncFolders();
    });
    this.watch = new BackgroundWatch();
    cx.timer.every(3000, (cx) => {
      this.watch.tick();
      cx.spawn(async () => {
        await ledgerTick();
      });
    });
    cx.timer.every(600000, (cx) => cx.spawn(async () => {
      await syncFolders();
    }));
  }

  // The usage endpoints; the statusline also writes a snapshot while a session runs.
  collect(cx) {
    cx.spawn(async (cx) => {
      setShared(API_QUOTAS, await collectQuotas());
      Object.assign(this.quota, await loadClaudeQuotas());
      quotaAlerts(this.quota);
      cx.notify();
    });
  }

  load(cx) {
    cx.spawn(async (cx) => {
      Object.assign(this.quota, await loadClaudeQuotas());
      this.loaded = true;
      cx.notify();
    });
  }

  launch(key) {
    const f = focused();
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    if (key === "best") key = this.best(pane?.cwd ?? f?.cwd);
    const argv = key === CODEX.key ? ["zsh", "-ilc", "codex"] : launchArgv(key);
    run("tab.new", { folder: pane?.cwd ?? f?.cwd ?? undefined, argv });
  }

  // The Claude account with the most room left; ties go to the folder's account, then the fallback order.
  best(folder) {
    const own = CONTEXTS.find((c) => c.key === contextOfPath(folder))?.account;
    const keys = [...new Set([own, ...FALLBACK, ...ACCOUNTS.map((a) => a.key)])].filter((k) => ACCOUNTS.some((a) => a.key === k));
    const pick = mostMargin(keys, this.quota), q = this.quota?.[pick.key];
    const used = [q?.h5 && `5h ${q.h5.pct}%`, q?.d7 && `7d ${q.d7.pct}%`].filter(Boolean).join(" · ");
    notify({
      title: `Starting ${ACCOUNTS.find((a) => a.key === pick.key).label}`,
      body: pick.margin === null ? "No quota data yet: the folder's account" : `Most room left · ${used}`,
      level: "info", timeout: 2500,
    });
    return pick.key;
  }

  meter(t, id, label, w, barWidth, stale, hovered) {
    const level = !w || stale ? t.dim : w.pct >= 80 ? t.blocked : w.pct >= 50 ? t.ansi3 : t.accent;
    const ahead = !stale && w?.pace != null && w.pct > w.pace * 100 + 5;
    return v_flex().id(id).w(barWidth).flex_none().gap(3).tooltip(meterTip(w, label))
      .child(h_flex().justify_between().text_size(11).text_color(ahead ? t.ansi3 : t.muted)
        .child(hovered && resetClock(w) ? `↻ ${resetClock(w)}` : ahead ? `${label} ▲` : label)
        .when(!(hovered && resetClock(w)), (el) => el.child(w ? `${w.pct}%` : "—")))
      .child(div().relative().w(barWidth).h(4).rounded(2).bg(t.raised)
        .when(Boolean(w?.pct), (el) => el.child(
          div().absolute().left(0).top(0).h(4).rounded(2).bg(level)
            .w(Math.max(2, barWidth * Math.min(w.pct, 100) / 100))))
        .when(w?.pace != null, (el) => el.child(
          div().absolute().top(-2).h(8).w(1.5).bg(t.foreground).opacity(0.5)
            .left(Math.round(barWidth * w.pace)))));
  }

  row(t, p, q, barWidth) {
    const age = q ? Date.now() / 1000 - q.updated : Infinity, stale = age > STALE;
    const note = !q
      ? "No data yet"
      : stale ? `Last updated ${ago(q.updated)}; the usage endpoint did not answer since` : `Updated ${ago(q.updated)}`;
    const hovered = this.hovered === p.key, app = p.key === CODEX.key ? "Codex" : "Claude";
    return h_flex().id(`account-${p.key}`).h(30).px(8).gap(8).items_center().rounded(6)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => this.launch(p.key))
      .on_hover((on, cx) => {
        this.hovered = on ? p.key : this.hovered === p.key ? null : this.hovered;
        cx.notify();
      })
      .child(div().id(`account-name-${p.key}`).w(NAME_W).flex_none().flex().items_center().gap(8)
        .tooltip(withKey(`${note}. Click to start ${app} here.`, `relevo.launch-${p.key}`))
        .child(chip(div, p))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium().text_color(stale ? t.muted : t.foreground)
          .child(p.label)))
      .when(!this.loaded && !q, (el) => el.child(h_flex().flex_1().justify_center().child(spinner(t.dim, 10))))
      .when(this.loaded || Boolean(q), (el) => el
        .child(this.meter(t, `meter-5h-${p.key}`, "5h", q?.h5, barWidth, stale, hovered))
        .child(this.meter(t, `meter-7d-${p.key}`, "7d", q?.d7, barWidth, stale, hovered)));
  }

  // Hides the other context in the Inbox, folds its space folder and mutes its alerts.
  focusPicker(t) {
    const now = focus();
    return h_flex().id("focus").h(18).p(1).gap(1).rounded(5).bg(t.raised).text_size(11)
      .tooltip(withKey("Which context the Inbox and alerts show", "relevo.focus-next"))
      .children([["all", "All"], ...CONTEXTS.map((c) => [c.key, c.label])].map(([key, label]) =>
        div().id(`focus-${key}`).h_full().px(5).flex().items_center().rounded(4).cursor_pointer()
          .text_color(now === key ? t.foreground : t.dim).when(now === key, (el) => el.bg(t.selected))
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => {
            setShared(FOCUS, key);
            cx.spawn(async () => {
              await foldFor(key);
            });
          })
          .child(label)));
  }

  // The folded sidebar: chips with one bar for the fuller window, details in the tooltip.
  rail(t) {
    const cell = (p) => {
      const q = this.quota[p.key], w = [q?.h5, q?.d7].filter(Boolean).sort((a, b) => b.pct - a.pct)[0];
      const stale = !q || Date.now() / 1000 - q.updated > STALE;
      const level = !w || stale ? t.dim : w.pct >= 80 ? t.blocked : w.pct >= 50 ? t.ansi3 : t.accent;
      const usage = [q?.h5 ? `5h ${q.h5.pct}%` : null, q?.d7 ? `7d ${q.d7.pct}%` : null]
        .filter(Boolean).join(" · ") || "no data";
      return v_flex().id(`account-${p.key}`).w_full().py(3).gap(3).items_center().rounded(6)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .tooltip(withKey(`${p.label} · ${usage}`, `relevo.launch-${p.key}`))
        .on_click(() => this.launch(p.key))
        .child(chip(div, p, 20))
        .child(div().relative().w(20).h(3).rounded(2).bg(t.raised)
          .when(Boolean(w?.pct), (el) => el.child(
            div().absolute().left(0).top(0).h(3).rounded(2).bg(level)
              .w(Math.max(2, 20 * Math.min(w.pct, 100) / 100)))));
    };
    return v_flex().id("relevo-accounts").size_full().px(6).pt(4).gap(2).bg(t.chrome).text_color(t.foreground)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 1) {
          this.width = size.width;
          cx.notify();
        }
      })
      .children([...ACCOUNTS, CODEX].map(cell));
  }

  cycleFocus(cx) {
    const keys = ["all", ...CONTEXTS.map((c) => c.key)], next = keys[(keys.indexOf(focus()) + 1) % keys.length];
    setShared(FOCUS, next);
    cx.spawn(async () => { await foldFor(next); });
  }

  render() {
    const t = theme();
    if (this.width < 160) return this.rail(t);
    const barWidth = Math.max(40, Math.floor((this.width - 16 - 16 - NAME_W - 16) / 2));
    return v_flex().id("relevo-accounts").size_full().px(8).pt(4).pb(8).gap(1).bg(t.chrome).text_color(t.foreground)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 1) {
          this.width = size.width;
          cx.notify();
        }
      })
      .child(h_flex().h(22).pl(8).items_center().justify_between().text_size(11).text_color(t.dim)
        .child(h_flex().gap(4).items_center()
          .child("ACCOUNTS")
          .child(div().id("relevo-settings").size(16).flex().items_center().justify_center().rounded(4).cursor_pointer()
            .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip(withKey("Settings", "relevo.settings"))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              openSettings();
            })
            .child(svg("mods/relevo/settings.svg").size(11))))
        .child(this.focusPicker(t)))
      .children([...ACCOUNTS, CODEX].map((p) => this.row(t, p, this.quota[p.key], barWidth)));
  }
}
