// Findings and notes laid out for a person: a card per finding (its level, its file, the problem and the fix), what
// nobody checked folded under a count, a deep review's verdicts, and a fix run's verdict on each finding.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { mergedFindings, unchecked, verdicts } from "./lib/deep-review.js";
import { LEVELS } from "./lib/run-report.js";
import { icon } from "./ui.js";

const LONG = 220;
const toneOf = (t, level) => (level === "blocker" ? t.blocked : level === "major" ? t.ansi3 : t.muted);
const mark = { approve: ["check", "done"], changes: ["warn", "blocked"], unsure: ["warn", "muted"], working: ["dot", "dim"] };
// "Sources/App/Settings/View.swift:12" reads as "View.swift:12"; the whole path is the tooltip.
const shortWhere = (where) => String(where).split("/").pop();

// `ui`: { open: Set of expanded keys, toggle(key, cx), openFile?(where, cx) }. `f.by` names who found it, when known.
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
      .when(f.by?.length > 1, (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(4).bg(t.selected).text_size(11).child("Both")))
      .when(f.by?.length === 1, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(f.by[0]))))
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
    .when(findings.length > 0, (el) => el.child(div().text_size(11).font_semibold().text_color(t.muted).child("The reviewer found")))
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
    .children(findings.map((f, i) => findingCard(t, `${id}-f-${i}`, f, ui)))
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
