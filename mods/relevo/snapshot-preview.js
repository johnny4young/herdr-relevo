// This view consumes a local snapshot already imported into the isolated app.
// No filesystem reads, process execution, live session control or network calls.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, shared, setShared, openOverlay, closeOverlay, props } from "herdr";
import { button, sectionHeader } from "./ui.js";
import { snapshotCards, filterSnapshot, snapshotTime, SNAPSHOT_LABELS } from "./lib/snapshot-inbox.js";

const SOURCE = "relevo.snapshot", SELECTED = "relevo.snapshot.selection";
const FILTERS = [["all", "All"], ["blocked", "Attention"], ["working", "In progress"], ["resting", "Waiting / done"]];
const text = (value, size = 13, color = null) => div().text_size(size).when(Boolean(color), (el) => el.text_color(color)).child(value);
const frame = (t, id) => v_flex().id(id).size_full().min_w(0).min_h(0).rounded(10).overflow_hidden().bg(t.surface ?? t.chrome).border_1().border_color(t.border).text_color(t.foreground);
const box = (t, title) => v_flex().p(12).gap(7).rounded(8).bg(t.background).border_1().border_color(t.border).child(text(title, 11, t.dim).font_semibold());
const tint = (t, status) => status === "blocked" ? t.blocked : status === "working" ? t.accent : t.muted;

export class SnapshotInbox {
  init(_props, cx) { this.h = cx.focus_handle(); this.filter = "all"; this.selected = null; }
  close() { this.h.release(); }
  list() { return filterSnapshot(snapshotCards(shared(SOURCE)) ?? [], this.filter); }
  choose(filter) { this.filter = filter; this.selected = this.list()[0]?.id ?? null; }
  open(id) {
    if (!this.list().some((item) => item.id === id)) return;
    this.selected = id;
    setShared(SELECTED, id);
    openOverlay({ mod: "relevo", props: { role: "snapshot-detail", syntheticPreview: true, snapshotPreview: true }, kind: "dialog", width: 640, height: 0.85 });
  }
  key(e, cx) {
    if (e.modifiers?.platform || e.modifiers?.control || e.modifiers?.alt) return;
    const list = this.list(), at = list.findIndex((item) => item.id === this.selected);
    if (["down", "j", "up", "k"].includes(e.key)) {
      const offset = ["down", "j"].includes(e.key) ? 1 : -1;
      this.selected = list[Math.max(0, Math.min(list.length - 1, at < 0 ? 0 : at + offset))]?.id ?? null;
    } else if (e.key === "enter" && this.selected) this.open(this.selected);
    else if (e.key === "escape") this.choose("all");
    else return;
    cx.stop_propagation(); cx.notify();
  }
  render() {
    const t = theme(), source = shared(SOURCE), all = snapshotCards(source), list = this.list();
    return frame(t, "snapshot-inbox").track_focus(this.h)
      .on_mouse_down("left", () => this.h.focus()).on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(text("Inbox", 13).font_semibold()).child(div().flex_1()).child(text("REAL SNAPSHOT · READ ONLY", 11, t.ansi3)))
      .child(v_flex().flex_none().px(10).py(8).gap(6)
        .child(text(`Captured: ${snapshotTime(source?.capturedAt)}`, 11, t.dim))
        .child(text("Saved state; no live updates.", 11, t.muted))
        .children([FILTERS.slice(0, 2), FILTERS.slice(2)].map((row) => h_flex().min_w(0).gap(6).children(row.map(([id, label]) =>
          button(t, `snapshot-filter-${id}`, `${label} ${filterSnapshot(all ?? [], id).length}`, () => this.choose(id),
            { size: "sm", kind: this.filter === id ? "solid" : "outline" }).flex_1().min_w(0))))))
      .child(v_flex().id("snapshot-inbox-list").min_w(0).flex_1().min_h(0).overflow_y_scrollbar().p(8).gap(7)
        .child(sectionHeader(t, "REAL TABS AND SESSIONS", list.length))
        .when(all === null, (el) => el.child(text("No valid snapshot. No sample data is shown instead.", 13, t.ansi3)))
        .when(all !== null && !list.length, (el) => el.child(text("No sessions match this filter.", 13, t.dim)))
        .children(list.map((item) => v_flex().id(`snapshot-item-${item.id}`).w_full().min_w(0).p(10).gap(7).rounded(8).border_1()
          .border_color(this.selected === item.id ? t.accent : t.border).bg(this.selected === item.id ? t.selected : t.background)
          .cursor_pointer().on_click(() => { this.selected = item.id; })
          .child(text(item.title, 13).font_semibold().min_w(0).w_full().truncate().tooltip(item.title))
          .child(text(item.project === item.repo ? item.project : `${item.project} · ${item.repo}`, 11, t.dim).min_w(0).truncate())
          .child(text(SNAPSHOT_LABELS[item.status], 11, tint(t, item.status)))
          .child(text(`${item.sessions.length} session(s) · Goal: Not set`, 11, t.muted))
          .child(text("Owner: Not set", 11, t.dim))
          .child(button(t, `snapshot-open-${item.id}`, "View saved context", () => this.open(item.id), { size: "sm" })))))
      .child(v_flex().flex_none().px(10).py(8).gap(4).border_t(1).border_color(t.border)
        .child(text("Does not send messages or take actions on your sessions.", 11, t.dim))
        .child(text("↑ ↓ / J K: select · Enter: view context", 11, t.dim)));
  }
}

export class SnapshotDetail {
  render() {
    const t = theme(), source = shared(SOURCE), item = snapshotCards(source)?.find((card) => card.id === shared(SELECTED));
    return frame(t, "snapshot-detail")
      .child(h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(text("Saved context", 13).font_semibold()).child(div().flex_1())
        .child(button(t, "snapshot-close", "Close", () => closeOverlay(props()?.overlay), { size: "sm" })))
      .child(v_flex().id("snapshot-detail-scroll").flex_1().min_h(0).overflow_y_scrollbar().p(16).gap(12)
        .child(text("LOCAL SNAPSHOT · REAL DATA · OFFLINE", 11, t.ansi3))
        .child(text(`Captured: ${snapshotTime(source?.capturedAt)}`, 11, t.dim))
        .when(!item, (el) => el.child(text("The session is not available in this snapshot.", 13)))
        .when(Boolean(item), (el) => el
          .child(text(item.title, 13).font_semibold())
          .child(text(`Workspace: ${item.project} · Folder: ${item.repo}`, 11, t.muted))
          .child(box(t, "HOW THIS RELATES TO YOUR WORK")
            .child(text("Goal: Not set", 13)).child(text("Outcome owner: Not set", 13))
            .child(text("The tab name does not establish a goal, task, or owner.", 11, t.dim)))
          .child(box(t, "WHAT IS KNOWN AND WHAT IS MISSING")
            .child(text(`Saved status: ${SNAPSHOT_LABELS[item.status]}`, 13, tint(t, item.status)))
            .child(text(item.status === "blocked" ? "The agent reported a blocker. Its cause was not imported, so we do not know whether it needs your decision." : "This status is historical. It does not show that the work is still in progress, finished, or approved.", 13, t.muted))
            .child(text("Next step: review the original session in your usual Herdr app. This snapshot does not control it.", 13))
            .child(text("Criteria, tests, Git review, and results: No evidence imported.", 11, t.dim)))
          .child(box(t, "SESSIONS INCLUDED IN THE SNAPSHOT")
            .children(item.sessions.map((session, n) => v_flex().id(`snapshot-session-${n}`).gap(5).py(5)
              .child(text(session.title, 13).font_semibold())
              .child(text(`${session.id} · ${session.agentApp}`, 11, t.dim))
              .child(text(SNAPSHOT_LABELS[session.status], 11, tint(t, session.status)))
              .child(text(`Saved status date: ${snapshotTime(session.statusAt)}`, 11, t.dim)))))
          .child(box(t, "SOURCE AND LIMITS")
            .child(text("Persisted Herdr metadata: workspaces, tabs, and terminals. Does not include screens, conversations, credentials, or original commands.", 11, t.muted))
            .child(text(`Workspace file: ${snapshotTime(source?.sourceMtimes?.docs)}`, 11, t.dim))
            .child(text(`Terminal file: ${snapshotTime(source?.sourceMtimes?.terminals)}`, 11, t.dim))
            .child(text("The capture date does not make saved statuses current. This view contains no approvals or operational actions.", 11, t.ansi3)))));
  }
}

export class SnapshotBanner {
  render() { const t = theme(); return h_flex().size_full().px(12).items_center().child(text("REAL SNAPSHOT · Read only · Offline", 11, t.ansi3)); }
}
