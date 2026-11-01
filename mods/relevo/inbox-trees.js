// The Inbox's merged worktrees: scan, open, remove. Mixed into Inbox, so `this` is the Inbox.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { run } from "herdr";
import { scanWorktrees, removeWorktree } from "./worktrees.js";
import { button, sectionHeader, spinner } from "./ui.js";
import { ago } from "./lib/time.js";

export class TreeViews {
  scanTrees(cx, force = false) {
    if (this.scanningTrees) return;
    this.scanningTrees = true;
    cx.spawn(async (cx) => {
      try {
        this.worktrees = await scanWorktrees(force);
      } catch (e) {
        this.wtError.scan = String(e?.message ?? e);
      } finally {
        this.scanningTrees = false;
      }
      cx.notify();
    });
  }

  openTree(w) {
    if (w.space) run("space.select", { id: w.space });
    else run("space.new", { folder: w.path });
  }

  // Only clean, unlocked worktrees get here; one with a space closes it first, as Herdr's dialog does.

  // Only clean, unlocked worktrees get here; one with a space closes it first, as Herdr's dialog does.
  removeTree(w, cx) {
    if (this.confirm !== w.path) {
      this.confirm = w.path;
      cx.notify();
      return;
    }
    this.confirm = null;
    this.removing.add(w.path);
    delete this.wtError[w.path];
    cx.notify();
    if (w.space) run("space.close", { id: w.space, confirmed: true });
    cx.spawn(async (cx) => {
      const err = await removeWorktree(w);
      if (!err) {
        // The row folds away natively before it leaves the list.
        this.gone.add(w.path);
        cx.notify();
        await cx.sleep(240);
        this.gone.delete(w.path);
        this.worktrees = this.worktrees.filter((x) => x.path !== w.path);
      }
      this.removing.delete(w.path);
      if (err) this.wtError[w.path] = err;
      cx.notify();
    });
  }

  // One line per merged worktree: Remove asks once more before git runs.

  // One line per merged worktree: Remove asks once more before git runs.
  treeRow(t, w) {
    if (this.hiddenIds?.has(`wt-${w.path}`)) return null;
    if (this.removing.has(w.path)) return this.removingRow(t, w);
    const err = this.wtError[w.path], sure = this.confirm === w.path;
    const note = err ?? (sure && w.space ? "closes its space" : w.dirty ? "uncommitted changes" : w.locked ? "locked" : null);
    const action = (id, label, tip, onClick, danger = false) =>
      button(t, id, label, onClick, { size: "sm", tip, kind: danger ? "danger" : "outline" });
    return h_flex().id(`wt-${w.path}`).h(30).px(8).gap(6).items_center().rounded(6)
      .when(this.selected(`wt-${w.path}`), (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover)).tooltip(w.path)
      .child(div().flex_none().text_size(11.5).text_color(t.muted).child(w.repo))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).child(w.branch ?? w.name))
      .when(Boolean(note), (el) => el.child(
        div().flex_none().max_w(140).truncate().text_size(10.5).text_color(err || sure ? t.blocked : t.dim).child(note)))
      .when(Boolean(w.at), (el) => el.child(this.age(t, w)))
      .child(action(`wt-open-${w.path}`, w.space ? "Go" : "Open", w.space ? "Go to its space" : "Open a space here",
        () => this.openTree(w)))
      .when(!w.dirty && !w.locked, (el) => el.child(action(`wt-rm-${w.path}`, sure ? "Confirm" : "Remove",
        "Removes the worktree and its local branch; git refuses if anything would be lost", (cx) => this.removeTree(w, cx), sure)));
  }

  // git can take a few seconds on a big checkout; the spinner runs natively, without redraws.

  // git can take a few seconds on a big checkout; the spinner runs natively, without redraws.
  removingRow(t, w) {
    const gone = this.gone.has(w.path);
    return h_flex().id(`wt-${w.path}`).h(gone ? 0 : 30).px(8).gap(6).items_center().rounded(6).overflow_hidden()
      .opacity(gone ? 0 : 0.6)
      .transition("opacity", { duration: 200 }).transition("height", { duration: 220, easing: "ease-out" })
      .child(div().flex_none().text_size(11.5).text_color(t.muted).child(w.repo))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).child(w.branch ?? w.name))
      .child(h_flex().flex_none().gap(5).items_center().text_size(10.5).text_color(t.blocked)
        .child(spinner(t.blocked))
        .child("Removing…"));
  }

  age(t, w) {
    return div().flex_none().text_size(10.5).text_color(t.dim).child(ago(w.at).replace(" ago", ""));
  }

  // Agent time per ticket today, for the weekly time tracker.

  treeGroups(t, worktrees) {
    const merged = worktrees.filter((w) => w.merged);
    const loose = worktrees.filter((w) => !w.merged && !w.open);
    const rows = merged.length
      ? [sectionHeader(t, "MERGED WORKTREES", merged.length), v_flex().children(merged.map((w) => this.treeRow(t, w)).filter(Boolean))]
      : [];
    if (loose.length) {
      const open = this.expanded.loose;
      rows.push(div().id("older-loose").px(4).pt(6).text_size(11).text_color(t.dim).cursor_pointer()
        .hover((s) => s.text_color(t.muted))
        .on_click((_e, cx) => {
          this.expanded.loose = !open;
          cx.notify();
        })
        .child(`${open ? "▾" : "▸"} ${loose.length} worktrees without a space`));
      if (open) rows.push(...loose.filter((w) => !this.hiddenIds?.has(`loose-${w.path}`)).map((w) => h_flex().id(`loose-${w.path}`).h(26).px(8).gap(8).items_center().rounded(6)
        .when(this.selected(`loose-${w.path}`), (el) => el.bg(t.selected))
        .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(w.path)
        .on_click(() => this.openTree(w))
        .child(div().flex_none().text_size(11.5).text_color(t.muted).child(w.repo))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).child(w.branch ?? `${w.name} (detached)`))
        .when(Boolean(w.at), (el) => el.child(this.age(t, w)))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child("Open"))));
    }
    return rows;
  }
}
