// The Inbox's merged worktrees: scan, open, remove. Mixed into Inbox, so `this` is the Inbox.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { notify, run } from "herdr";
import { scanWorktrees, removeWorktree, removalCheck, treeState, treeSize } from "./worktrees.js";
import { actionsOf, groupOf, whyOf, sizeOf } from "./lib/trees.js";
import { deleteCheck, deleteWorktree, pushBackup, pushPlan, savedState, saveCommits, savePatch } from "./worktree-actions.js";
import { button, spinner } from "./ui.js";
import { ago } from "./lib/time.js";

const GROUPS = [["safe", "Nothing to lose"], ["pushed", "Pushed, not merged"], ["work", "With work"], ["checking", "Checking"], ["recent", "Recent"]];

const deletes = (files) => `deletes ${files.slice(0, 2).join(", ")}${files.length > 2 ? ` +${files.length - 2}` : ""}`;

export class TreeViews {
  scanTrees(cx, force = false) {
    if (this.scanningTrees) return;
    this.scanningTrees = true;
    this.treesAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        this.worktrees = await scanWorktrees(force);
      } catch (e) {
        this.wtError.scan = String(e?.message ?? e);
      } finally {
        this.scanningTrees = false;
      }
      if (this.expanded.loose || this.worktrees.some((w) => w.merged && w.dirty)) this.loadTreeStates(cx, force);
      cx.notify();
    });
  }

  // Slow on many worktrees, so only while the section is open, and again only for one used since.
  loadTreeStates(cx, force = false) {
    this.treeStates ??= new Map();
    if (this.loadingStates) return;
    this.loadingStates = true;
    const list = this.worktrees.filter((w) => (w.merged ? w.dirty : this.expanded.loose && !w.open));
    cx.spawn(async (cx) => {
      try {
        const stale = list.filter((w) => force || this.treeStates.get(w.path)?.at !== w.at);
        for (const w of stale) {
          const state = await treeState(w);
          if (!state.unreadable) Object.assign(state, await savedState(w, state));
          this.treeStates.set(w.path, { at: w.at, state });
          cx.notify();
        }
        for (const w of stale) {
          const known = this.treeStates.get(w.path);
          if (known) known.kb = await treeSize(w);
          cx.notify();
        }
      } finally {
        this.loadingStates = false;
      }
    });
  }

  applyState(w, now) {
    const known = this.treeStates?.get(w.path);
    if (w.merged && !known) return;
    w.group = known ? groupOf(known.state, w.at, now) : undefined;
    w.why = whyOf(known?.state);
    w.kb = known?.kb;
    w.actions = actionsOf(known?.state, w.at, now);
    w.ignored = known?.state?.ignored ?? w.ignored;
    w.dirty = (known?.state?.files ?? 0) > 0;
  }

  // The rows without a space by group, in screen order; a row can't offer more than its state allows.
  looseGroups(worktrees) {
    const now = Date.now() / 1000, groups = new Map(GROUPS.map(([key]) => [key, []]));
    for (const w of worktrees.filter((x) => !x.merged && !x.open)) {
      this.applyState(w, now);
      groups.get(w.group ?? "checking").push(w);
    }
    return groups;
  }

  // Keyboard order: what's drawn, so nothing in a folded group.
  looseRows(worktrees) {
    const groups = this.looseGroups(worktrees);
    return GROUPS.flatMap(([key]) => (key === "recent" && !this.expanded["loose-recent"] ? [] : groups.get(key)));
  }

  looseViews(t, worktrees) {
    const groups = this.looseGroups(worktrees), rows = [];
    for (const [key, label] of GROUPS) {
      const list = groups.get(key);
      if (!list.length) continue;
      if (key === "recent") {
        const open = this.expanded["loose-recent"];
        rows.push(div().id("loose-recent").px(4).pt(6).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((s) => s.text_color(t.muted))
          .on_click((_e, cx) => {
            this.expanded["loose-recent"] = !open;
            cx.notify();
          })
          .child(`${open ? "▾" : "▸"} ${list.length} recent`));
        if (!open) continue;
      } else {
        const clean = key === "safe" ? this.removable(list) : [], sure = this.confirm === "all-safe";
        rows.push(h_flex().pt(6).px(4).gap(6).items_center().text_size(10.5).text_color(t.dim)
          .when(key === "checking", (el) => el.child(spinner(t.dim, 10)))
          .child(div().flex_1().child(label))
          .child(String(list.length))
          .when(clean.length > 1, (el) => el.child(button(t, "wt-rm-all-safe", sure ? `Confirm ${clean.length}` : `Remove ${clean.length}`,
            (cx) => this.removeAll(clean, cx, "all-safe"), {
              size: "sm", kind: sure ? "danger" : "outline",
              tip: "Removes the ones with no ignored files to keep",
            }))));
      }
      rows.push(...list.map((w) => this.treeRow(t, w)).filter(Boolean));
    }
    return rows;
  }

  openTree(w) {
    if (w.space) run("space.select", { id: w.space });
    else run("space.new", { folder: w.path });
  }

  // Only clean, unlocked worktrees get here; one with a space closes it first, as Herdr's dialog does.
  removeTree(w, cx) {
    this.checking ??= new Set();
    if (this.checking.has(w.path)) return;
    this.checking.add(w.path);
    const asked = this.confirm === w.path, shown = JSON.stringify([w.ignored ?? [], w.space ?? null]);
    cx.spawn(async (cx) => {
      try {
        const check = await removalCheck(w);
        if (check.error) {
          this.confirm = null;
          this.wtError[w.path] = check.error;
          return cx.notify();
        }
        delete this.wtError[w.path];
        w.space = check.space;
        w.ignored = check.ignored;
        // What the confirmation names must be what goes.
        if (!asked || JSON.stringify([check.ignored, check.space]) !== shown) {
          this.confirm = w.path;
          return cx.notify();
        }
        this.confirm = null;
        await this.removeOne(w, cx);
      } finally {
        this.checking.delete(w.path);
      }
    });
  }

  // Saves and pushes, one at a time per row; a row's state is read again after.
  treeAction(w, cx, act, done) {
    this.treeBusy ??= new Set();
    if (this.treeBusy.has(w.path)) return;
    this.treeBusy.add(w.path);
    delete this.wtError[w.path];
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await act();
        if (r.error) this.wtError[w.path] = r.error;
        else if (done) notify({ ...done(r), level: "success" });
      } catch (e) {
        this.wtError[w.path] = String(e?.message ?? e);
      } finally {
        this.treeBusy.delete(w.path);
        this.treeStates?.delete(w.path);
        this.loadTreeStates(cx);
        cx.notify();
      }
    });
  }

  // First click says where it goes, since a push can't be taken back; the second goes only if that still holds.
  askPush(w, cx) {
    this.treeBusy ??= new Set();
    if (this.treeBusy.has(w.path)) return;
    this.treeBusy.add(w.path);
    delete this.wtError[w.path];
    const asked = this.pushAsk?.path === w.path ? this.pushAsk.sign : null;
    cx.notify();
    cx.spawn(async (cx) => {
      let plan = null;
      try {
        const state = await treeState(w);
        if (state.unreadable || !state.unpushed) {
          this.pushAsk = null;
          this.wtError[w.path] = state.unreadable ? "could not check its files" : "nothing left to push";
          return;
        }
        const now = await pushPlan(w, state);
        if (now.error) {
          this.pushAsk = null;
          this.wtError[w.path] = now.error;
        } else if (asked === now.sign) plan = now;
        else this.pushAsk = { path: w.path, ...now };
      } catch (e) {
        this.wtError[w.path] = String(e?.message ?? e);
      } finally {
        this.treeBusy.delete(w.path);
        if (plan) {
          this.pushAsk = null;
          this.treeAction(w, cx, () => pushBackup(w, plan.head), (r) => ({ title: `Pushed ${r.ref}`, body: w.repo }));
        }
        cx.notify();
      }
    });
  }

  // The first click reads what would go and says it; the second goes only if that still holds.
  askDelete(w, cx) {
    this.treeBusy ??= new Set();
    if (this.treeBusy.has(w.path)) return;
    this.treeBusy.add(w.path);
    delete this.wtError[w.path];
    const asked = this.deleteAsk?.path === w.path ? this.deleteAsk.sign : null;
    cx.notify();
    cx.spawn(async (cx) => {
      let go = false;
      try {
        const check = await deleteCheck(w);
        if (check.error) {
          this.deleteAsk = null;
          this.wtError[w.path] = check.error;
        } else if (asked !== check.sign) this.deleteAsk = { path: w.path, ...check };
        else go = true;
      } finally {
        this.treeBusy.delete(w.path);
      }
      if (go) {
        this.deleteAsk = null;
        this.treeMenu = null;
        await this.removeOne(w, cx, deleteWorktree);
      }
      cx.notify();
    });
  }

  // A second line under a row: what it can do, or the question before a push or a delete.
  actionsLine(t, w) {
    const id = (name) => `wt-${name}-${w.path}`, busy = this.treeBusy?.has(w.path);
    const line = (children) => h_flex().pl(8).pb(5).gap(5).flex_wrap().items_center().children(children);
    const cancel = (key) => button(t, id("cancel"), "Cancel", (cx) => {
      this[key] = null;
      cx.notify();
    }, { size: "sm" });
    const say = (text) => div().text_size(10.5).text_color(t.blocked).child(text);
    if (this.deleteAsk?.path === w.path) {
      return line([say(this.deleteAsk.text), button(t, id("delete-go"), "Delete forever", (cx) => this.askDelete(w, cx), {
        size: "sm", kind: "danger", disabled: busy,
        tip: this.deleteAsk.ignored?.length ? `Ignored: ${this.deleteAsk.ignored.slice(0, 8).join(", ")}` : null,
      }), cancel("deleteAsk")]);
    }
    if (this.pushAsk?.path === w.path) {
      return line([say(this.pushAsk.text), button(t, id("push-go"), this.pushAsk.label, (cx) => this.askPush(w, cx), {
        size: "sm", kind: "danger", disabled: busy,
      }), cancel("pushAsk")]);
    }
    const saved = (r) => ({ title: "Saved", body: r.file });
    const labels = {
      patch: ["Save patch", (cx) => this.treeAction(w, cx, () => savePatch(w), saved), "Saves uncommitted changes outside the repo"],
      commits: ["Save commits", (cx) => this.treeAction(w, cx, () => saveCommits(w), saved), "Saves commits not on GitHub outside the repo"],
      push: ["Push backup", (cx) => this.askPush(w, cx), "Pushes its commits to a backup branch"],
      delete: ["Delete", (cx) => this.askDelete(w, cx), "Deletes the worktree and everything in it"],
    };
    return line((w.actions ?? []).map((name) => button(t, id(name), labels[name][0], labels[name][1], {
      size: "sm", tip: labels[name][2], disabled: busy,
    })));
  }

  async removeOne(w, cx, remove = removeWorktree) {
    this.removing.add(w.path);
    delete this.wtError[w.path];
    cx.notify();
    if (w.space) run("space.close", { id: w.space, confirmed: true });
    const err = await remove(w);
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
  }

  // Merged, clean, unlocked and not open anywhere: safe to remove together. One with a space stays for its own
  // Remove, because closing several spaces at once is easy to regret.
  removable(merged) {
    return merged.filter((w) => !w.dirty && !w.locked && !w.space && !w.open && !w.ignored?.length && !this.removing.has(w.path));
  }

  removeAll(list, cx, key = "all") {
    if (this.confirm !== key) {
      this.confirm = key;
      cx.notify();
      return;
    }
    this.confirm = null;
    cx.spawn(async (cx) => {
      for (const w of list) {
        const check = await removalCheck(w);
        if (check.error || check.space || check.ignored.length) {
          this.wtError[w.path] = check.error ?? (check.space ? "has a space" : deletes(check.ignored));
          w.ignored = check.ignored ?? w.ignored;
          cx.notify();
          continue;
        }
        await this.removeOne(w, cx);
      }
    });
  }

  // One line per merged worktree: Remove asks once more before git runs.
  treeRow(t, w) {
    if (this.hiddenIds?.has(`wt-${w.path}`)) return null;
    if (this.removing.has(w.path)) return this.removingRow(t, w);
    const err = this.wtError[w.path], sure = this.confirm === w.path;
    const warn = sure ? [w.space && "closes its space", w.ignored?.length && deletes(w.ignored)].filter(Boolean).join(", ") : "";
    const note = err ?? (warn || w.why || (w.dirty ? "uncommitted changes" : w.locked ? "locked" : null));
    const offersRemove = !w.dirty && !w.locked && (w.merged || w.group === "safe" || w.group === "pushed");
    const action = (id, label, tip, onClick, danger = false) =>
      button(t, id, label, onClick, { size: "sm", tip, kind: danger ? "danger" : "outline" });
    const open = this.treeMenu === w.path || this.deleteAsk?.path === w.path || this.pushAsk?.path === w.path;
    const row = h_flex().h(30).px(8).gap(6).items_center().rounded(6)
      .hover((s) => s.bg(t.hover)).tooltip(note ? `${note}\n${w.path}` : w.path)
      .child(div().flex_none().text_size(11.5).text_color(t.muted).child(w.repo))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).child(w.branch ?? `${w.name} (detached)`))
      .when(Boolean(note), (el) => el.child(
        div().flex_none().max_w(140).truncate().text_size(10.5).text_color(err || sure ? t.blocked : t.dim).child(note)))
      .when(Boolean(w.kb), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(sizeOf(w.kb))))
      .when(Boolean(w.at), (el) => el.child(this.age(t, w)))
      .child(action(`wt-open-${w.path}`, w.space ? "Go" : "Open", w.space ? "Go to its space" : "Open a space here",
        () => this.openTree(w)))
      .when(offersRemove, (el) => el.child(action(`wt-rm-${w.path}`, sure ? "Confirm" : "Remove",
        w.group === "pushed" ? "Removes the worktree and its local branch. The branch stays on GitHub" : "Removes the worktree and its local branch. Files git ignores go with it",
        (cx) => this.removeTree(w, cx), sure)))
      .when(Boolean(w.actions?.length) && w.group === "work", (el) => el.child(action(`wt-more-${w.path}`, "⋯", "Save, back up or delete", (cx) => {
        this.treeMenu = open ? null : w.path;
        this.deleteAsk = null;
        this.pushAsk = null;
        cx.notify();
      })));
    return v_flex().id(`wt-${w.path}`).rounded(6)
      .when(this.selected(`wt-${w.path}`), (el) => el.bg(t.selected))
      .child(row)
      .when(open, (el) => el.child(this.actionsLine(t, w)));
  }

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

  treeGroups(t, worktrees) {
    const merged = worktrees.filter((w) => w.merged);
    for (const w of merged) if (this.treeStates?.has(w.path)) this.applyState(w, Date.now() / 1000);
    const loose = worktrees.filter((w) => !w.merged && !w.open);
    const clean = this.removable(merged), sure = this.confirm === "all";
    const header = h_flex().pt(6).px(2).gap(6).items_center().text_size(10.5).text_color(t.dim)
      .child(div().flex_1().child("MERGED WORKTREES"))
      .child(String(merged.length))
      .when(clean.length > 1, (el) => el.child(button(t, "wt-rm-all", sure ? `Confirm ${clean.length}` : `Remove ${clean.length}`,
        (cx) => this.removeAll(clean, cx), {
          size: "sm", kind: sure ? "danger" : "outline",
          tip: "Removes every merged worktree that is clean, unlocked, has no space and no ignored files to keep, with its local branch",
        })));
    const rows = merged.length
      ? [header, v_flex().children(merged.map((w) => this.treeRow(t, w)).filter(Boolean))]
      : [];
    if (loose.length) {
      const open = this.expanded.loose;
      rows.push(div().id("older-loose").px(4).pt(6).text_size(11).text_color(t.dim).cursor_pointer()
        .hover((s) => s.text_color(t.muted))
        .on_click((_e, cx) => {
          this.expanded.loose = !open;
          if (!open) this.loadTreeStates(cx);
          cx.notify();
        })
        .child(`${open ? "▾" : "▸"} ${loose.length} worktrees without a space`));
      if (open) rows.push(...this.looseViews(t, worktrees));
    }
    return rows;
  }
}
