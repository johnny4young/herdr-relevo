// Native GPUI preview. Every value is synthetic; there are no exec, network or agent actions here.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, shared, setShared, openOverlay, closeOverlay, props } from "herdr";
import { button, sectionHeader } from "./ui.js";
import { createDemoItems, visibleItems, evidenceCurrent, markReviewed, advanceRevision, refreshEvidence } from "./lib/decision-inbox.js";

const STATE = "relevo.preview.decisions.v1";
const FILTERS = [["all", "All"], ["blocked", "Needs decision"], ["review", "Review"], ["ready", "Ready to review"]];
const LABELS = { passed: "Passed", failed: "Failed", pending: "Pending", unknown: "Unverified", skipped: "Skipped" };
const KINDS = { blocked: "NEEDS DECISION", review: "FOR REVIEW", ready: "READY TO REVIEW" };
const get = () => shared(STATE) ?? { items: createDemoItems(), selected: createDemoItems()[0].id, filter: "all", notice: "" };
function put(patch) { setShared(STATE, { ...get(), ...patch }); }
function reset() { const items = createDemoItems(); put({ items, selected: items[0].id, filter: "all", notice: "Preview reset. Sample data only." }); }
function select(id) { put({ selected: id, notice: "" }); }
function openDetail(id) {
  select(id);
  openOverlay({ mod: "relevo", props: { role: "decision-detail", syntheticPreview: true }, kind: "dialog", width: 640, height: 0.85 });
}
function change(id, fn, notice, expectedRevision) {
  const s = get();
  const before = s.items.find((i) => i.id === id);
  if (!before || s.selected !== id || before.revision !== expectedRevision) return;
  if (fn === markReviewed && !evidenceCurrent(before)) return;
  put({ items: s.items.map((i) => i.id === id ? fn(i) : i), notice });
}
const current = () => get().items.find((i) => i.id === get().selected);
const color = (t, status) => status === "passed" ? t.ansi2 : status === "failed" ? t.blocked : status === "pending" ? t.ansi3 : t.dim;
const text = (value, size = 13, tint = null) => div().text_size(size).when(Boolean(tint), (el) => el.text_color(tint)).child(value);
const pill = (t, label, tint = t.muted) => div().px(7).py(3).rounded(5).bg(t.raised).text_size(11).text_color(tint).child(label);
const frame = (t, id) => v_flex().id(id).size_full().min_w(0).min_h(0).rounded(10).overflow_hidden().bg(t.surface ?? t.chrome).border_1().border_color(t.border).text_color(t.foreground);
const heading = (t, name, aside) => h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
  .child(text(name, 13).font_semibold()).child(div().flex_1()).child(text(aside, 11, t.dim));
const box = (t, label) => v_flex().p(12).gap(8).rounded(8).bg(t.background).border_1().border_color(t.border)
  .child(text(label, 11, t.dim).font_semibold());

export class PreviewInbox {
  init(_props, cx) { this.h = cx.focus_handle(); setShared("relevo.inbox.count", get().items.length); }
  close() { this.h.release(); }
  chooseFilter(filter) {
    const s = get(), list = visibleItems(s.items, filter);
    put({ filter, selected: list.some((i) => i.id === s.selected) ? s.selected : list[0]?.id ?? null, notice: "" });
  }
  key(e, cx) {
    if (e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt) return;
    const s = get(), list = visibleItems(s.items, s.filter), at = list.findIndex((i) => i.id === s.selected);
    if (["down", "j", "up", "k"].includes(e.key)) {
      const offset = ["down", "j"].includes(e.key) ? 1 : -1;
      select(list[Math.max(0, Math.min(list.length - 1, at < 0 ? 0 : at + offset))]?.id ?? null);
    } else if (e.key === "enter" && s.selected) openDetail(s.selected);
    else if (e.key === "escape") this.chooseFilter("all");
    else return;
    cx.stop_propagation(); cx.notify();
  }
  render() {
    const t = theme(), s = get(), list = visibleItems(s.items, s.filter);
    return frame(t, "relevo-inbox").track_focus(this.h)
      .on_mouse_down("left", () => this.h.focus()).on_key_down((e, cx) => this.key(e, cx))
      .child(heading(t, "Inbox", "PREVIEW · SYNTHETIC DATA"))
      .child(v_flex().flex_none().px(10).py(8).gap(6)
        .children([FILTERS.slice(0, 2), FILTERS.slice(2)].map((row) => h_flex().min_w(0).gap(6).children(row.map(([id, label]) =>
          button(t, `preview-filter-${id}`, `${label} ${visibleItems(s.items, id).length}`, () => this.chooseFilter(id),
            { size: "sm", kind: s.filter === id ? "solid" : "outline" }).flex_1().min_w(0))))))
      .child(v_flex().id("preview-inbox-list").min_w(0).flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(7)
        .child(sectionHeader(t, "WORK TO REVIEW", list.length))
        .children(list.map((i) => {
          const selected = i.id === s.selected, fresh = evidenceCurrent(i);
          return v_flex().id(`preview-item-${i.id}`).w_full().min_w(0).p(10).gap(7).rounded(8).border_1().border_color(selected ? t.accent : t.border)
            .bg(selected ? t.selected : t.background).cursor_pointer().hover((el) => el.bg(t.hover)).on_click(() => select(i.id))
            .child(text(i.task.title, 13).font_semibold())
            .child(h_flex().justify_between().gap(6).child(text(i.project, 11, t.dim)).child(text(i.revision, 11, t.dim)))
            .child(text(`Goal: ${i.goal.title}`, 11, t.muted))
            .child(h_flex().gap(5).child(pill(t, KINDS[i.kind], i.kind === "blocked" ? t.blocked : t.accent))
              .when(!fresh, (el) => el.child(pill(t, "STALE EVIDENCE", t.ansi3))))
            .child(text(`Owner: ${i.owner}`, 11, t.dim))
            .child(text(`Next: ${i.nextStep}`, 11, t.muted).min_w(0).truncate().tooltip(`${i.nextActor}: ${i.nextStep}`))
            .child(button(t, `preview-open-${i.id}`, "Review context", () => openDetail(i.id), { size: "sm" }))
            .when(fresh && i.reviewedRevision === i.revision, (el) => el.child(text("✓ Reviewed here · not approved", 11, t.ansi2)));
        }))
        .when(!list.length, (el) => el.child(text("No examples in this filter.", 13, t.dim))))
      .child(h_flex().h(30).flex_none().px(12).items_center().border_t(1).border_color(t.border).child(text("↑ ↓ / J K: select · Enter: review", 11, t.dim)));
  }
}

export class DecisionDetail {
  render() {
    const t = theme(), i = current(), s = get();
    if (!i) return frame(t, "preview-detail").child(heading(t, "Review", "PREVIEW")).child(text("Select an item from the inbox."));
    const fresh = evidenceCurrent(i), reviewed = fresh && i.reviewedRevision === i.revision;
    return frame(t, "preview-detail")
      .child(h_flex().flex_none().gap(8).items_center().child(heading(t, i.project, `${i.revision} · SAMPLE`).flex_1())
        .child(button(t, "preview-close", "Close", () => closeOverlay(props()?.overlay), { size: "sm" })))
      .child(v_flex().id("preview-detail-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(18).gap(14)
        .child(pill(t, "SYNTHETIC DATA · OFFLINE", t.ansi3))
        .child(text(i.task.title, 13).font_semibold())
        .child(text(`Goal: ${i.goal.title}`, 13, t.muted))
        .child(text(`Outcome owner: ${i.owner}`, 11, t.muted))
        .child(text(`Run by: ${i.sessions.map((session) => session.owner).join(", ")}`, 11, t.muted))
        .child(box(t, "DECISION NEEDED FROM YOU")
          .child(text(i.decision, 13).font_semibold())
          .children((i.decisionOptions ?? []).map((option) => text(`• ${option.label}`, 13, t.foreground)))
          .child(text(i.recommendation, 13, t.muted))
          .child(text(`Next step: ${i.nextActor} · ${i.nextStep}`, 11, t.accent))
          .child(text(`Why this appears: ${i.priorityReason}`, 11, t.dim)))
        .child(box(t, fresh ? "ACCEPTANCE CRITERIA" : `CRITERIA · VERIFY IN ${i.revision}`)
          .children(i.criteria.map((c, n) => h_flex().id(`criterion-${i.id}-${n}`).gap(9).items_start()
            .child(text(!fresh ? "○" : c.status === "passed" ? "✓" : c.status === "failed" ? "×" : "○", 13, fresh ? color(t, c.status) : t.dim))
            .child(text(c.label, 13).flex_1()).child(text(fresh ? LABELS[c.status] ?? "Unverified" : "To verify", 11, fresh ? color(t, c.status) : t.dim)))))
        .child(box(t, fresh ? `EVIDENCE · ${i.revision}` : `STALE EVIDENCE · ${i.evidence?.revision ?? "no revision"}`)
          .when(!fresh, (el) => el.child(text("The revision changed. Review new evidence before marking it as reviewed.", 13, t.ansi3)))
          .child(text(i.evidence?.summary ?? "No evidence available.", 13, t.muted))
          .children((i.evidence?.checks ?? []).map((c, n) => v_flex().id(`check-${i.id}-${n}`).gap(3)
            .child(h_flex().justify_between().gap(8).child(text(c.label, 13)).child(text(LABELS[c.status] ?? "Unverified", 11, color(t, c.status))))
            .child(text(c.detail, 11, t.dim))))
          .child(text("Sample results. These are not runs or screenshots from your projects.", 11, t.dim)))
        .child(box(t, "RELATED SESSIONS · SIMULATED")
          .children(i.sessions.map((session) => h_flex().id(`session-${session.id}`).gap(8).items_center()
            .child(div().size(6).rounded_full().bg(t.accent))
            .child(v_flex().flex_1().gap(2).child(text(session.title, 13)).child(text(`${session.id} · ${session.owner}`, 11, t.dim)))
            .child(pill(t, session.state)))))
        .when(Boolean(s.notice), (el) => el.child(text(s.notice, 13, t.accent)))
        .child(text("Reviewing does not authorize anything. This version does not send messages, approve, merge, or start agents.", 11, t.dim)))
      .child(v_flex().flex_none().p(12).gap(8).border_t(1).border_color(t.border)
        .child(h_flex().gap(7).child(button(t, "preview-reviewed", reviewed ? "✓ Reviewed (sample)" : "Mark reviewed (sample)", () => change(i.id, markReviewed, "Marked in this preview only. Nothing was approved or sent.", i.revision), { kind: "solid", disabled: !fresh || reviewed }))
          .child(button(t, "preview-new-revision", "Simulate revision", () => change(i.id, advanceRevision, "New simulated revision: the previous evidence is no longer valid.", i.revision))))
        .child(text("SAMPLE CONTROLS", 11, t.dim))
        .child(h_flex().gap(7).child(button(t, "preview-evidence", "Simulate new evidence", () => change(i.id, refreshEvidence, "Sample evidence linked to the current revision.", i.revision), { size: "sm", disabled: fresh }))
          .child(button(t, "preview-reset", "Reset", reset, { size: "sm" }))));
  }
}

export class PreviewBanner {
  render() {
    const t = theme();
    return h_flex().size_full().px(12).items_center().bg(t.chrome).text_color(t.ansi3).text_size(11)
      .child("PREVIEW · Isolated profile · Synthetic data");
  }
}

export const PREVIEW_ROLES = { "decision-detail": DecisionDetail, "preview-banner": PreviewBanner };
