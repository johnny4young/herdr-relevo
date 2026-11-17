// A deep review as one page, in Runs and in the run window: each reviewer's verdict, the findings by level with
// where they are and what to do, and what nobody checked, folded.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { mergedFindings, unchecked, verdicts } from "./lib/deep-review.js";
import { icon } from "./ui.js";

const LONG = 220;
const toneOf = (t, level) => (level === "blocker" ? t.blocked : level === "major" ? t.ansi3 : t.muted);
const mark = { approve: ["check", "done"], changes: ["warn", "blocked"], unsure: ["warn", "muted"], working: ["dot", "dim"] };

// `ui`: { open: Set of expanded keys, toggle(key, cx), openFile(where) }.
export function deepReviewView(t, id, reviews, ui) {
  const findings = mergedFindings(reviews), nobody = unchecked(reviews), foldKey = `${id}-unchecked`;
  const card = (f, i) => {
    const key = `${id}-f-${i}`, open = ui.open.has(key), long = f.issue.length > LONG || Boolean(f.proof);
    return v_flex().id(key).w_full().min_w(0).gap(4).px(10).py(8).rounded(8).bg(t.raised)
      .child(h_flex().w_full().min_w(0).gap(6).items_center()
        .child(div().flex_none().px(6).h(18).flex().items_center().rounded(4).bg(`${toneOf(t, f.level)}26`).text_size(11).font_semibold()
          .text_color(toneOf(t, f.level)).child(f.level))
        .when(Boolean(f.where), (el) => el.child(div().id(`${key}-where`).min_w(0).truncate().text_size(11).font_family("JetBrains Mono")
          .text_color(t.accent).cursor_pointer().hover((s) => s.underline()).tooltip("Open in the review pane")
          .on_click((_e, cx) => { cx.stop_propagation(); ui.openFile(f.where, cx); }).child(f.where)))
        .child(div().flex_1())
        .when(f.by.length > 1, (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(4).bg(t.selected).text_size(11).child("Both")))
        .when(f.by.length === 1, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(f.by[0]))))
      .child(div().w_full().min_w(0).text_size(13).text_color(t.foreground).child(long && !open ? `${f.issue.slice(0, LONG).trimEnd()}…` : f.issue))
      .when(open && Boolean(f.proof), (el) => el.child(div().w_full().min_w(0).text_size(11).text_color(t.muted).child(f.proof)))
      .when(Boolean(f.fix), (el) => el.child(h_flex().w_full().min_w(0).gap(6).items_start()
        .child(div().flex_none().text_size(11).font_semibold().text_color(t.done).child("Fix"))
        .child(div().flex_1().min_w(0).text_size(11).text_color(t.muted).child(f.fix))))
      .when(long, (el) => el.child(div().id(`${key}-more`).self_start().text_size(11).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => ui.toggle(key, cx)).child(open ? "Less" : "More")));
  };
  const folded = !ui.open.has(foldKey);
  return v_flex().id(id).w_full().min_w(0).gap(10)
    .child(v_flex().id(`${id}-verdicts`).w_full().min_w(0).gap(4).children(verdicts(reviews).map((v) => {
      const [glyph, tone] = mark[v.state];
      return h_flex().id(`${id}-v-${v.id}`).w_full().min_w(0).gap(8).items_center().tooltip(v.summary || v.line)
        .child(v.state === "working" ? div().size(6).flex_none().rounded_full().bg(t.working) : icon(glyph, t[tone], 13))
        .child(div().flex_none().text_size(13).font_semibold().child(v.label))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t[tone]).child(v.line));
    })))
    .when(!findings.length && reviews.every((r) => r.attempts?.some((a) => a.report)), (el) => el.child(div().text_size(13).text_color(t.done).child("No findings.")))
    .children(findings.map(card))
    .when(nobody.length > 0, (el) => el.child(v_flex().id(foldKey).w_full().min_w(0).gap(3)
      .child(h_flex().id(`${foldKey}-head`).gap(6).items_center().cursor_pointer().on_click((_e, cx) => ui.toggle(foldKey, cx))
        .child(icon(folded ? "chevron-right" : "chevron-down", t.dim, 10))
        .child(div().text_size(11).text_color(t.dim).child(`What nobody checked · ${nobody.length}`)))
      .when(!folded, (inner) => inner.children(nobody.map((n) => div().pl(16).text_size(11).text_color(t.muted).child(n))))));
}
