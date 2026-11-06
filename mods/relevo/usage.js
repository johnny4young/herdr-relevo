import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, openOverlay, shared } from "herdr";
import { ACCOUNTS, CODEX } from "./accounts.js";
import { ago } from "./lib/time.js";
import { RANGES, compact, summarize } from "./lib/usage.js";
import { USAGE, readReport } from "./usage-scan.js";
import { TURNS } from "./turns.js";
import { button, spinner, withKey } from "./ui.js";

const NEW_TIP = "New context: tokens cached for the first time. Rereading the cache costs far less, so this and output are what grow a session's cost";
const QUOTA_TIP = "Tokens are not quota: Anthropic doesn't publish how a subscription weighs them";

export function openUsage() {
  openOverlay({ mod: "relevo", kind: "dialog", width: 880, height: 620, props: { role: "usage" } });
}

const segment = (t, id, options, on, pick) => h_flex().id(id).flex_none().h(22).p(1).gap(1).rounded(5).bg(t.raised).text_size(11)
  .children(options.map(([key, label]) => div().id(`${id}-${key ?? "all"}`).h_full().px(7).flex().items_center().rounded(4).cursor_pointer()
    .text_color(on === key ? t.foreground : t.muted).when(on === key, (el) => el.bg(t.selected))
    .on_click((_e, cx) => pick(key, cx))
    .child(label)));

const title = (t, label, tip = null) => div().id(`usage-h-${label}`).pb(4).text_size(11).text_color(t.dim)
  .when(Boolean(tip), (el) => el.tooltip(tip)).child(label);

// The sidebar's copy reads the transcripts; this one shows its report and asks it to read again.
export class UsageDialog {
  init(_props, cx) {
    this.range = "7d";
    this.account = null;
    this.load(cx);
    run("relevo.usage-scan");
  }

  load(cx) {
    this.loadedAt = shared(USAGE)?.updated ?? null;
    cx.spawn(async (cx) => {
      this.report = await readReport();
      cx.notify();
    });
  }

  surface(t, s) {
    return v_flex().id(`usage-${s.key}`).flex_1().min_w(0).h(76).p(10).gap(2).rounded(8).bg(t.background).border_1().border_color(t.border)
      .tooltip(`${s.label}: ${Math.round(s.share * 100)}% of the output in this range`)
      .child(h_flex().justify_between().text_size(11).text_color(t.muted)
        .child(s.label).child(`${Math.round(s.share * 100)}%`))
      .child(div().text_size(13).font_semibold().child(`${compact(s.output)} output`))
      .when(s.write > 0, (el) => el.child(div().text_size(11).text_color(t.muted).child(`${compact(s.write)} new context`)));
  }

  // One hue for one measure; each bar says its day and numbers on hover.
  chart(t, days) {
    const top = Math.max(1, ...days.map((d) => d.write));
    return v_flex().flex_none()
      .child(h_flex().justify_between().child(title(t, "NEW CONTEXT PER DAY", NEW_TIP))
        .child(div().text_size(11).text_color(t.dim).child(`peak ${compact(top)}`)))
      .child(h_flex().id("usage-days").h(56).gap(2).items_end()
        .children(days.map((d) => div().id(`day-${d.key}`).flex_1().min_w(0).h_full().flex().flex_col().justify_end()
          .tooltip(`${d.key} · ${compact(d.write)} new context · ${compact(d.output)} output`)
          .child(div().w_full().rounded(2).bg(d.write ? t.accent : t.raised).h(Math.max(2, Math.round(52 * d.write / top)))))))
      .child(h_flex().pt(3).justify_between().text_size(11).text_color(t.dim)
        .child(days[0].key.slice(5)).child(days.at(-1).key.slice(5)));
  }

  projects(t, list) {
    const top = Math.max(1, ...list.map((p) => p.write));
    return v_flex().flex_1().min_w(0)
      .child(h_flex().gap(8).text_size(11).text_color(t.dim)
        .child(div().id("usage-h-project").flex_1().pb(4).child("BY PROJECT"))
        .child(div().id("usage-h-new").w(44).text_right().tooltip(NEW_TIP).child("New"))
        .child(div().w(44).text_right().child("Output")))
      .children(list.slice(0, 14).map((p) => h_flex().id(`pj-${p.key}`).h(24).flex_none().gap(8).items_center()
        .child(div().w(110).flex_none().truncate().text_size(13).child(p.key))
        .child(div().flex_1().min_w(0).h(4).rounded(2).bg(t.raised)
          .child(div().h(4).rounded(2).bg(t.accent).w(`${Math.max(1, Math.round(100 * p.write / top))}%`)))
        .child(div().w(44).flex_none().text_right().text_size(11).child(compact(p.write)))
        .child(div().w(44).flex_none().text_right().text_size(11).text_color(t.muted).child(compact(p.output)))));
  }

  // Today's heaviest turns, Herdr's and Desktop's, with what their subagents took.
  turns(t) {
    const today = new Date().setHours(0, 0, 0, 0) / 1000;
    const list = (shared(TURNS) ?? []).filter((r) => r.at >= today).sort((a, b) => b.write + b.output - a.write - a.output).slice(0, 5);
    if (!list.length) return null;
    return v_flex().pt(8)
      .child(title(t, "HEAVIEST TURNS TODAY", "New context and output of one turn, from when the agent started working until it stopped"))
      .children(list.map((r, i) => v_flex().id(`turn-${i}`).py(3).flex_none()
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(13).child(r.where))
          .child(div().flex_none().text_size(11).child(compact(r.write + r.output))))
        .child(div().truncate().text_size(11).text_color(t.dim)
          .child([r.surface === "desktop" ? "Desktop" : "Terminal", r.subs ? `${r.subs} subagents · ${compact(r.subWrite + r.subOutput)}` : null,
            `${Math.max(1, Math.round(r.took / 60))}m`].filter(Boolean).join(" · ")))));
  }

  kinds(t, s) {
    const share = (n) => (s.total.write ? `${Math.round(100 * n / s.total.write)}%` : "");
    return v_flex()
      .child(title(t, "WHAT FILLED IT", NEW_TIP))
      .children(s.kinds.map((k) => h_flex().id(`kind-${k.key}`).h(22).flex_none().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(k.sub ? t.muted : t.foreground).child(k.sub && k.key !== "Other subagents" ? `Subagent · ${k.key}` : k.key))
        .child(div().flex_none().text_size(11).child(compact(k.write)))
        .child(div().w(30).flex_none().text_right().text_size(11).text_color(t.muted).child(share(k.write)))))
      .when(s.paused.count > 0, (el) => el.child(h_flex().id("usage-paused").mt(4).h(22).flex_none().gap(8).items_center()
        .tooltip("Conversations cached again after more than an hour without activity. These tokens are already counted above.")
        .child(div().flex_1().min_w(0).truncate().text_size(13).child(`After a pause · ${s.paused.count} times`))
        .child(div().flex_none().text_size(11).child(compact(s.paused.write)))
        .child(div().w(30).flex_none().text_right().text_size(11).text_color(t.muted).child(share(s.paused.write)))));
  }

  sessions(t, list) {
    const named = { desktop: "Desktop", terminal: "Terminal" };
    return v_flex()
      .child(title(t, "BIGGEST SESSIONS", "Whole sessions that were active in this range"))
      .children(list.map((x) => v_flex().id(`ss-${x.id}`).py(3).flex_none()
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(13).child(x.title || x.project))
          .child(div().flex_none().text_size(11).child(compact(x.write))))
        .child(div().truncate().text_size(11).text_color(t.dim).child(`${x.project} · ${named[x.surface] ?? x.surface}`))));
  }

  render(cx) {
    const usage = shared(USAGE) ?? {};
    if (usage.updated && usage.updated !== this.loadedAt) this.load(cx);
    const reading = usage.total && usage.done < usage.total;
    const t = theme(), days = RANGES.find(([key]) => key === this.range)[2];
    const s = this.report ? summarize(this.report, days, this.account) : null;
    const accounts = [[null, "All"], ...[...ACCOUNTS, CODEX].map((a) => [a.key, a.label])];
    const empty = s && !s.total.output && !s.total.write;
    const header = h_flex().h(44).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().id("usage-title").font_semibold().text_size(13).tooltip(QUOTA_TIP).child("Tokens"))
      .child(segment(t, "usage-range", RANGES, this.range, (key, cx) => {
        this.range = key;
        cx.notify();
      }))
      .child(segment(t, "usage-account", accounts, this.account, (key, cx) => {
        this.account = key;
        cx.notify();
      }))
      .child(div().flex_1())
      .when(Boolean(reading), (el) => el.child(h_flex().gap(5).items_center().text_size(11).text_color(t.dim)
        .child(spinner(t.dim, 11)).child(`Reading ${Math.round(100 * usage.done / usage.total)}%`)))
      .when(!reading && Boolean(this.report), (el) => el.child(div().text_size(11).text_color(t.dim).child(ago(this.report.updated))))
      .child(button(t, "usage-refresh", "↻", () => run("relevo.usage-scan"), { tip: withKey("Read again", "relevo.usage"), disabled: Boolean(reading) }));
    const center = (el) => h_flex().flex_1().justify_center().items_center().text_size(13).text_color(t.dim).child(el);
    const body = !s
      ? center("Reading transcripts…")
      : empty
        ? center(reading ? "Reading transcripts…" : "No tokens in this range")
        : v_flex().id("usage-body").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(14)
          .child(h_flex().gap(8).children(s.surfaces.map((x) => this.surface(t, x))))
          .when(days > 1, (el) => el.child(this.chart(t, s.days)))
          .child(h_flex().gap(20).items_start()
            .child(v_flex().flex_1().min_w(0).child(this.projects(t, s.projects)).when(Boolean(this.turns(t)), (el) => el.child(this.turns(t))))
            .child(v_flex().w(320).flex_none().gap(14)
              .child(this.kinds(t, s))
              .when(s.sessions.length > 0, (el) => el.child(this.sessions(t, s.sessions)))));
    return v_flex().id("relevo-usage").size_full().bg(t.popover ?? t.surface).text_color(t.foreground).child(header).child(body);
  }
}
