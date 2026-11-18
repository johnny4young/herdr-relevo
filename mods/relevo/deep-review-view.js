// Findings and notes laid out for a person: a card per finding (its level, its file, the problem and the fix), what
// nobody checked folded under a count, a deep review's verdicts, and a fix run's verdict on each finding.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { mergedFindings, unchecked, verdicts } from "./lib/deep-review.js";
import { LEVELS } from "./lib/run-report.js";
import { icon } from "./ui.js";

const LONG = 220;
const toneOf = (t, level) => (level === "blocker" ? t.blocked : level === "major" ? t.ansi3 : t.muted);
const mark = { approve: ["check", "done"], changes: ["warn", "blocked"], unsure: ["warn", "muted"], working: ["dot", "dim"] };
// "Sources/App/Settings/View.swift:12" reads as "View.swift:12"; the whole path is the tooltip.
const shortWhere = (where) => String(where).split("/").pop();

// A small bordered action, like Ask to fix.
const chip = (t, id, label, onClick) => div().id(id).flex_none().px(6).h(20).flex().items_center().rounded(5).border_1().border_color(t.border)
  .text_size(11).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(label);

// `ui`: { open: Set of expanded keys, toggle(key, cx), openFile?(where, cx), ask?(findings, cx) }. `f.by` names who found it.
export function findingCard(t, key, f, ui) {
  const open = ui.open.has(key), long = f.issue.length > LONG || Boolean(f.proof);
  return v_flex().id(key).w_full().min_w(0).gap(4).px(10).py(8).rounded(8).bg(t.raised)
    .child(h_flex().w_full().min_w(0).gap(6).items_center()
      .child(div().flex_none().px(6).h(18).flex().items_center().rounded(4).bg(`${toneOf(t, f.level)}26`).text_size(11).font_semibold()
        .text_color(toneOf(t, f.level)).child(f.level))
      .when(Boolean(f.where), (el) => el.child(div().id(`${key}-where`).min_w(0).truncate().text_size(11).font_family("JetBrains Mono")
        .text_color(ui.openFile ? t.accent : t.muted).tooltip(f.where)
        .when(Boolean(ui.openFile), (w) => w.cursor_pointer().hover((s) => s.underline())
          .on_click((_e, cx) => { cx.stop_propagation(); ui.openFile(f.where, cx); }))
        .child(shortWhere(f.where))))
      .child(div().flex_1())
      .when(Boolean(ui.outcomeOf?.(f)), (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(4).text_size(11)
        .bg(`${["Fixed", "Changed"].includes(ui.outcomeOf(f)) ? t.done : t.dim}26`).text_color(["Fixed", "Changed"].includes(ui.outcomeOf(f)) ? t.done : t.muted).child(ui.outcomeOf(f))))
      .when(f.by?.length > 1, (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(4).bg(t.selected).text_size(11).child("Both")))
      .when(f.by?.length === 1, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(f.by[0])))
      .when(Boolean(ui.ask), (el) => el.child(chip(t, `${key}-ask`, "Ask to fix", (cx) => ui.ask([f], cx)))))
    .child(div().w_full().min_w(0).text_size(13).text_color(t.foreground).child(long && !open ? `${f.issue.slice(0, LONG).trimEnd()}…` : f.issue))
    .when(open && Boolean(f.proof), (el) => el.child(div().w_full().min_w(0).text_size(11).text_color(t.muted).child(f.proof)))
    .when(Boolean(f.fix), (el) => el.child(h_flex().w_full().min_w(0).gap(6).items_start()
      .child(div().flex_none().text_size(11).font_semibold().text_color(t.done).child("Fix"))
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.muted).child(f.fix))))
    .when(long, (el) => el.child(div().id(`${key}-more`).self_start().text_size(11).text_color(t.accent).cursor_pointer()
      .on_click((_e, cx) => ui.toggle(key, cx)).child(open ? "Less" : "More")));
}

// A count that opens to one line per item; the whole item is its tooltip.
export function foldList(t, key, label, items, ui) {
  const folded = !ui.open.has(key);
  return v_flex().id(key).w_full().min_w(0).gap(3)
    .child(h_flex().id(`${key}-head`).gap(6).items_center().cursor_pointer().on_click((_e, cx) => ui.toggle(key, cx))
      .child(icon(folded ? "chevron-right" : "chevron-down", t.dim, 10))
      .child(div().text_size(11).text_color(t.dim).child(`${label} · ${items.length}`)))
    .when(!folded, (inner) => inner.children(items.map((n, i) => h_flex().id(`${key}-${i}`).w_full().min_w(0).gap(6).pl(16).tooltip(n)
      .child(div().flex_none().text_size(11).text_color(t.dim).child("•"))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(n)))));
}

// What a person weighs before accepting a run: the reviewer's findings, then what nobody checked.
export function notesView(t, id, notes, ui) {
  const findings = [...notes.findings].sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level));
  return v_flex().id(id).w_full().min_w(0).gap(8)
    .when(findings.length > 0, (el) => el.child(h_flex().w_full().gap(6).items_center()
      .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child("The reviewer found"))
      .when(Boolean(ui.ask) && findings.length > 1, (h) => h.child(chip(t, `${id}-ask-all`, `Ask to fix all (${findings.length})`, (cx) => ui.ask(findings, cx))))))
    .children(findings.map((f, i) => findingCard(t, `${id}-f-${i}`, f, ui)))
    .when(notes.unchecked.length > 0, (el) => el.child(foldList(t, `${id}-unchecked`, "Not checked", notes.unchecked, ui)));
}

export function deepReviewView(t, id, reviews, ui) {
  const findings = mergedFindings(reviews), nobody = unchecked(reviews);
  return v_flex().id(id).w_full().min_w(0).gap(10)
    .child(v_flex().id(`${id}-verdicts`).w_full().min_w(0).gap(4).children(verdicts(reviews).map((v) => {
      const [glyph, tone] = mark[v.state];
      return h_flex().id(`${id}-v-${v.id}`).w_full().min_w(0).gap(8).items_center().tooltip(v.summary || v.line)
        .child(v.state === "working" ? div().size(6).flex_none().rounded_full().bg(t.working) : icon(glyph, t[tone], 13))
        .child(div().flex_none().text_size(13).font_semibold().child(v.label))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t[tone]).child(v.line));
    })))
    .when(!findings.length && reviews.every((r) => r.attempts?.some((a) => a.report)), (el) => el.child(div().text_size(13).text_color(t.done).child("No findings.")))
    // What could stop the merge first; minor notes fold under a count.
    .children(findings.map((f, i) => [f, i]).filter(([f]) => f.level !== "minor").map(([f, i]) => findingCard(t, `${id}-f-${i}`, f, ui)))
    .when(findings.some((f) => f.level === "minor"), (el) => {
      const key = `${id}-minor`, open = ui.open.has(key), minors = findings.map((f, i) => [f, i]).filter(([f]) => f.level === "minor");
      return el.child(v_flex().id(key).w_full().min_w(0).gap(6)
        .child(h_flex().id(`${key}-head`).gap(6).items_center().cursor_pointer().on_click((_e, cx) => ui.toggle(key, cx))
          .child(icon(open ? "chevron-down" : "chevron-right", t.dim, 10)).child(div().text_size(11).text_color(t.dim).child(`Minor notes · ${minors.length}`)))
        .when(open, (inner) => inner.children(minors.map(([f, i]) => findingCard(t, `${id}-f-${i}`, f, ui)))));
    })
    .when(nobody.length > 0, (el) => el.child(foldList(t, `${id}-unchecked`, "What nobody checked", nobody, ui)));
}

const VERDICT_MARK = { "Needs your call": ["ask", "blocked"], Fixed: ["check", "done"], "False positive": ["x", "muted"], "Won't fix": ["note", "muted"] };

// A fix run's answer to each finding, grouped by verdict, what needs you first.
export function fixChecklistView(t, id, list) {
  return v_flex().id(id).w_full().min_w(0).gap(8)
    .child(div().text_size(11).font_semibold().text_color(t.muted).child(list.head))
    .children(list.groups.map((g, gi) => {
      const [glyph, tone] = VERDICT_MARK[g.verdict];
      return v_flex().id(`${id}-g-${gi}`).w_full().min_w(0).gap(4)
        .child(h_flex().gap(6).items_center().child(icon(glyph, t[tone], 12))
          .child(div().text_size(13).font_semibold().text_color(g.verdict === "Needs your call" ? t.blocked : t.foreground).child(`${g.verdict} · ${g.items.length}`)))
        .children(g.items.map((item, i) => {
          const [, where, why] = /^(\S+?)\s+[—-]\s+(.+)$/.exec(item.text) ?? [null, null, item.text];
          return h_flex().id(`${id}-g-${gi}-${i}`).w_full().min_w(0).gap(8).pl(18).items_start()
            .when(Boolean(where), (el) => el.child(div().flex_none().max_w(180).truncate().text_size(11).font_family("JetBrains Mono").text_color(t.muted).tooltip(where)
              .child(shortWhere(where))))
            .child(div().flex_1().min_w(0).text_size(13).text_color(t.foreground).child(why));
        }));
    }));
}

const OUTCOME_MARK = { ...VERDICT_MARK, Changed: ["check", "done"], "Not touched": ["dot", "dim"] };

// A fix run's result against the deep review it came from: per finding, what happened to it, one line each.
export function fixOutcomeView(t, id, outcome) {
  return v_flex().id(id).w_full().min_w(0).gap(8)
    .child(div().text_size(13).font_semibold().child(outcome.head))
    .children(outcome.groups.map((g, gi) => {
      const [glyph, tone] = OUTCOME_MARK[g.outcome];
      return v_flex().id(`${id}-g-${gi}`).w_full().min_w(0).gap(3)
        .child(h_flex().gap(6).items_center()
          .child(glyph === "dot" ? div().size(6).flex_none().rounded_full().bg(t.dim) : icon(glyph, t[tone], 12))
          .child(div().text_size(11).font_semibold().text_color(g.outcome === "Needs your call" ? t.blocked : t.muted).child(`${g.outcome} · ${g.rows.length}`)))
        .children(g.rows.map(({ f, why }, i) => v_flex().id(`${id}-g-${gi}-${i}`).w_full().min_w(0).pl(18).gap(1).tooltip(f.issue)
          .child(h_flex().w_full().min_w(0).gap(6).items_center()
            .child(div().flex_none().text_size(11).text_color(toneOf(t, f.level)).child(f.level))
            .child(div().flex_none().max_w(200).truncate().text_size(11).font_family("JetBrains Mono").text_color(t.muted).child(shortWhere(f.where ?? "")))
            .child(div().flex_1().min_w(0).truncate().text_size(13).child(f.issue)))
          .when(Boolean(why), (el) => el.child(div().w_full().min_w(0).truncate().text_size(11).text_color(t.muted).child(why)))));
    }));
}

const OPEN = ["Not touched", "Needs your call"];

// The fix at a glance: how many majors it handled, the ones left, what it handled and the minor notes, one line each.
// Anything still open carries Ask to fix. `ui`: { ask?(findings, cx) }.
export function fixGlanceView(t, id, outcome, ui) {
  const line = (r, i, key) => h_flex().id(`${key}-${i}`).w_full().min_w(0).gap(6).items_center().tooltip(r.why || r.f.issue)
    .child(div().flex_none().text_size(11).text_color(toneOf(t, r.f.level)).child(r.f.level))
    .child(div().flex_none().max_w(170).truncate().text_size(11).font_family("JetBrains Mono").text_color(t.muted).child(shortWhere(r.f.where ?? "")))
    .child(div().flex_1().min_w(0).truncate().text_size(13).child(r.f.issue))
    .child(ui.ask && OPEN.includes(r.outcome) ? chip(t, `${key}-${i}-ask`, "Ask to fix", (cx) => ui.ask([r.f], cx))
      : div().flex_none().text_size(11).text_color(["Fixed", "Changed"].includes(r.outcome) ? t.done : t.muted).child(r.outcome));
  const section = (key, label, rows) => v_flex().id(key).w_full().min_w(0).gap(3).pt(4)
    .child(div().text_size(11).text_color(t.dim).child(label)).children(rows.map((r, i) => line(r, i, key)));
  const handled = outcome.majors.filter((r) => !outcome.left.includes(r)), minors = outcome.rows.filter((r) => r.f.level === "minor");
  const open = [...outcome.left, ...minors.filter((r) => OPEN.includes(r.outcome))].map((r) => r.f);
  return v_flex().id(id).w_full().min_w(0).gap(3)
    .child(h_flex().w_full().gap(6).items_center()
      .child(div().flex_1().text_size(13).font_semibold().text_color(outcome.left.length ? t.blocked : t.done).child(outcome.tally))
      .when(Boolean(ui.ask) && open.length > 1, (el) => el.child(chip(t, `${id}-ask-all`, `Ask to fix all (${open.length})`, (cx) => ui.ask(open, cx)))))
    .children(outcome.left.map((r, i) => line(r, i, `${id}-left`)))
    .when(handled.length > 0, (el) => el.child(section(`${id}-handled`, `Handled · ${handled.length}`, handled)))
    .when(minors.length > 0, (el) => el.child(section(`${id}-minor`, `Minor · ${minors.length}`, minors)));
}

// A run starting, as steps: done, the one going on, the ones to come, and one waiting on a question in red.
export function launchStepsView(t, id, steps) {
  return v_flex().id(id).w_full().min_w(0).gap(3).children(steps.map((s, i) => h_flex().id(`${id}-${i}`).w_full().min_w(0).gap(8).items_center()
    .child(h_flex().w(14).flex_none().justify_center().child(s.state === "done" ? icon("check", t.done, 12)
      : s.state === "run" ? svg("mods/relevo/spinner.svg").size(12).text_color(t.working).spin(900)
      : s.state === "ask" ? icon("warn", t.blocked, 12) : div().size(6).rounded_full().border_1().border_color(t.dim)))
    .child(div().w(70).flex_none().text_size(11).font_semibold().text_color(s.state === "wait" ? t.dim : s.state === "ask" ? t.blocked : t.foreground).child(s.label))
    .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).tooltip(s.note ?? "").child(s.note ?? ""))));
}
