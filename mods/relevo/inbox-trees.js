// The Inbox's worktrees in Maintenance: scan, sort by what removing one would lose, open, save, remove.
// Mixed into Inbox, so `this` is the Inbox.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, notify, run, settings } from "herdr";
import { scanWorktrees, removeWorktree, removalCheck, treeState, treeSize } from "./worktrees.js";
import { actionsOf, bulkPlan, groupOf, justUsed, laneOf, loseOf, plural, reasonOf, sizeOf, totalKb, whyOf } from "./lib/trees.js";
import { backupsRoot, backupsSize, deleteCheck, deleteWorktree, headOf, logRemoval, pushBackup, pushPlan, savedState, saveCommits, savePatch } from "./worktree-actions.js";
import { button, checkbox, foldRow, joined, keycap, legHeader, row, spinner, LANE } from "./ui.js";

const deletes = (files) => `deletes ${files.slice(0, 2).join(", ")}${files.length > 2 ? ` +${files.length - 2}` : ""}`;
const TURN = { safe: "ready", look: "open", quiet: "old" };
const TIPS = {
  remove: "Removes the worktree and its local branch. Files git ignores go with it",
  pushed: "Removes the worktree and its local branch. The branch stays on GitHub",
  forever: "Deletes the worktree and everything in it. Says what would be lost first",
  patch: "Saves uncommitted changes outside the repo",
  commits: "Saves commits not on GitHub outside the repo",
  push: "Pushes its commits to a backup branch",
};

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
      if (this.expanded.loose || this.worktrees.some((w) => w.merged)) this.loadTreeStates(cx, force);
      if (this.expanded.stale) this.scanStale?.(cx, force);
      if (this.backupsKb === undefined || force) this.backupsKb = await backupsSize();
      cx.notify();
    });
  }

  // Slow on many worktrees, so loose ones wait until Maintenance was opened, and each is read again only once used since.
  loadTreeStates(cx, force = false) {
    this.treeStates ??= new Map();
    this.treeSizes ??= new Map();
    // A load started earlier can't see a section opened since, so this one runs right after it.
    if (this.loadingStates) {
      this.loadAgain = { force: force || this.loadAgain?.force };
      return;
    }
    this.loadingStates = true;
    const list = this.worktrees.filter((w) => (w.merged ? w.dirty : this.expanded.loose && !w.open));
    const sized = this.worktrees.filter((w) => w.merged || (this.expanded.loose && !w.open));
    cx.spawn(async (cx) => {
      try {
        const stale = list.filter((w) => force || this.treeStates.get(w.path)?.at !== w.at);
        for (const w of stale) {
          const state = await treeState(w);
          if (!state.unreadable) Object.assign(state, await savedState(w, state));
          this.treeStates.set(w.path, { at: w.at, state });
          cx.notify();
        }
        for (const w of sized.filter((x) => force || this.treeSizes.get(x.path)?.at !== x.at)) {
          this.treeSizes.set(w.path, { at: w.at, kb: await treeSize(w) });
          cx.notify();
        }
      } finally {
        this.loadingStates = false;
        const again = this.loadAgain;
        this.loadAgain = null;
        if (again) this.loadTreeStates(cx, again.force);
      }
    });
  }

  applyState(w, now) {
    const known = this.treeStates?.get(w.path), s = known?.state;
    w.kb = this.treeSizes?.get(w.path)?.kb;
    if (w.merged && !known) return;
    w.group = known ? groupOf(s, w.at, now) : undefined;
    w.why = whyOf(s);
    w.actions = actionsOf(s, w.at, now);
    w.ignored = s?.ignored ?? w.ignored;
    w.dirty = (s?.files ?? 0) > 0;
    w.unreadable = Boolean(s?.unreadable);
    w.work = Boolean(s) && (s.files > 0 || s.unpushed > 0);
    w.unsaved = Boolean(s) && ((s.files > 0 && !s.patchSaved) || (s.unpushed > 0 && !s.commitsSaved));
  }

  // The worktrees Maintenance lists, by what removing one would lose, each stamped with its lane. Read once per
  // draw and handed to the legend, the groups, the keyboard and the rows.
  treeLanes(worktrees) {
    const now = Date.now() / 1000, lanes = { safe: [], look: [], quiet: [] };
    for (const w of worktrees.filter((x) => x.merged || !x.open)) {
      this.applyState(w, now);
      w.lane = laneOf(w, now);
      lanes[w.lane].push(w);
    }
    return lanes;
  }

  openTree(w) {
    if (w.space) run("space.select", { id: w.space });
    else run("space.new", { folder: w.path });
  }

  // The look-again before any removal. `same` holds only when the space and the ignored files the question
  // named are the ones that would go now.
  async checkStillMatches(w, shownSpace, shownIgnored) {
    const check = await removalCheck(w);
    if (check.error) return { error: check.error };
    return { ...check, same: JSON.stringify([check.ignored, check.space]) === JSON.stringify([shownIgnored ?? [], shownSpace ?? null]) };
  }

  // Only clean, unlocked worktrees get here; one with a space closes it first, as Herdr's dialog does.
  removeTree(w, cx) {
    this.checking ??= new Set();
    if (this.checking.has(w.path)) return;
    this.checking.add(w.path);
    const asked = this.confirm === w.path;
    cx.spawn(async (cx) => {
      try {
        const check = await this.checkStillMatches(w, w.space, w.ignored);
        if (check.error) {
          this.confirm = null;
          this.wtError[w.path] = check.error;
          return cx.notify();
        }
        delete this.wtError[w.path];
        w.space = check.space;
        w.ignored = check.ignored;
        if (!asked || !check.same) {
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
        this.treeSizes?.delete(w.path);
        this.loadTreeStates(cx);
        this.backupsKb = await backupsSize();
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
      let said = null;
      try {
        const check = await deleteCheck(w);
        if (check.error) {
          this.deleteAsk = null;
          this.wtError[w.path] = check.error;
        } else if (asked !== check.sign) this.deleteAsk = { path: w.path, ...check };
        else said = check.text;
      } finally {
        this.treeBusy.delete(w.path);
      }
      if (said) {
        this.deleteAsk = null;
        await this.removeOne(w, cx, deleteWorktree, said);
      }
      cx.notify();
    });
  }

  async removeOne(w, cx, remove = removeWorktree, said = w.ignored?.length ? `Remove, ${deletes(w.ignored)}` : "Remove") {
    this.removing.add(w.path);
    delete this.wtError[w.path];
    cx.notify();
    if (w.space) run("space.close", { id: w.space, confirmed: true });
    const head = await headOf(w);
    const err = await remove(w);
    if (!err) {
      if (!await logRemoval(w, head, said)) notify({ title: "Removed, but not written to deletions.log", body: w.path, level: "warning" });
      this.backupsKb = await backupsSize();
      // The row folds away natively before it leaves the list.
      this.gone.add(w.path);
      cx.notify();
      await cx.sleep(240);
      this.gone.delete(w.path);
      this.worktrees = this.worktrees.filter((x) => x.path !== w.path);
      this.marked?.delete(w.path);
    }
    this.removing.delete(w.path);
    if (err) this.wtError[w.path] = err;
    cx.notify();
  }

  // Merged, clean, unlocked and not open anywhere: safe to remove together. One with a space stays for its own
  // Remove, because closing several spaces at once is easy to regret.
  removable(merged) {
    return merged.filter((w) => !w.dirty && !w.locked && !w.space && !w.open && !w.ignored?.length && !this.removing.has(w.path)
      && !(w.merged && justUsed(w.at, Date.now() / 1000)));
  }

  // One row of a batch: the same look-again as its own Remove. The question named no ignored files and
  // `space`, so anything else keeps the row, with the reason.
  async removeChecked(w, space, cx) {
    const check = await this.checkStillMatches(w, space, []);
    const err = check.error ?? (check.same ? null : check.ignored.length ? deletes(check.ignored) : check.space ? "has a space" : "changed, look again");
    if (err) {
      this.wtError[w.path] = err;
      w.ignored = check.ignored ?? w.ignored;
      cx.notify();
      return err;
    }
    w.space = check.space;
    await this.removeOne(w, cx);
    return this.wtError[w.path] ?? null;
  }

  inView() {
    return this.shown ? this.shown().worktrees : this.worktrees;
  }

  markedRows(worktrees = this.inView()) {
    return this.marked?.size ? worktrees.filter((w) => this.marked.has(w.path)) : [];
  }

  toggleMark(w, cx) {
    this.marked ??= new Set();
    if (!this.marked.delete(w.path)) this.marked.add(w.path);
    this.bulkAsk = null;
    cx.notify();
  }

  // Every row of Safe to remove (merged ones only) that has no space: closing several at once is easy to regret.
  markAllSafe(cx) {
    this.marked = new Set(this.removable(this.treeLanes(this.inView()).safe).map((w) => w.path));
    this.bulkAsk = null;
    cx.notify();
  }

  clearMarks(cx = null) {
    this.marked?.clear();
    this.bulkAsk = null;
    cx?.notify();
  }

  // Asks once for the marked rows, or for `list`; a row that is not safe stops it, and the bar says which.
  // The selection is `marked`; bulkAsk only holds the space each row had when the question was drawn.
  askBulk(cx, list = null) {
    if (this.bulkBusy) return;
    if (list) this.marked = new Set(list.map((w) => w.path));
    const rows = this.markedRows();
    this.bulkAsk = bulkPlan(rows, Date.now() / 1000).ok ? Object.fromEntries(rows.map((w) => [w.path, w.space ?? null])) : null;
    cx.notify();
  }

  // Each row goes through removeChecked on its own; one that fails stays selected with its reason.
  confirmBulk(cx) {
    const spaces = this.bulkAsk, rows = this.markedRows();
    if (!spaces || this.bulkBusy) return;
    this.bulkAsk = null;
    if (!bulkPlan(rows, Date.now() / 1000).ok) return cx.notify();
    this.bulkBusy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      let kept = 0;
      try {
        for (const w of rows) {
          if (await this.removeChecked(w, spaces[w.path], cx)) kept += 1;
          else this.marked.delete(w.path);
        }
      } finally {
        this.bulkBusy = false;
      }
      const gone = rows.length - kept;
      notify(kept
        ? { title: `Removed ${gone} of ${rows.length}`, body: `${plural(kept, "worktree")} kept: each row says why`, level: "warning" }
        : { title: `Removed ${plural(gone, "worktree")}`, body: [...new Set(rows.map((w) => w.repo))].join(", "), level: "success" });
      cx.notify();
    });
  }

  // "N selected" at the foot of the list, or the one question once Remove N was asked.
  bulkBar(t, worktrees) {
    const rows = this.markedRows(worktrees), n = rows.length;
    if (!n) return null;
    const plan = bulkPlan(rows, Date.now() / 1000);
    if (this.bulkAsk && plan.ok) return this.bulkSheet(t, plan);
    return v_flex().id("bulk-bar").flex_none().pl(16).pr(8).py(5).gap(3).border_t(1).border_color(t.border).bg(t.raised)
      .when(!plan.ok, (el) => el.child(div().id("bulk-why").min_w(0).text_size(11).text_color(t.blocked).child(plan.why)))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_none().font_semibold().text_size(13).child(`${n} selected`))
        .when(Boolean(plan.kb) && !this.tightInbox, (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child(sizeOf(plan.kb))))
        .child(div().flex_1())
        .child(button(t, "bulk-cancel", [keycap(t, "esc"), "Cancel"], (cx) => this.clearMarks(cx), { size: "sm", kind: "ghost" }))
        .child(button(t, "bulk-remove", [keycap(t, "d"), `Remove ${n}`], (cx) => this.askBulk(cx), {
          size: "sm", disabled: !plan.ok || Boolean(this.bulkBusy), tip: plan.ok ? "Asks once, then checks and removes each" : plan.why,
        })));
  }

  bulkSheet(t, plan) {
    const cancel = (cx) => {
      this.bulkAsk = null;
      cx.notify();
    };
    return div().flex_none().p(6).border_t(1).border_color(t.border)
      .child(v_flex().id("bulk-sheet").p(10).gap(6).rounded(8).border_1().border_color(t.border).bg(t.raised)
        .child(div().font_semibold().text_size(13).child(plan.title))
        .child(div().min_w(0).text_size(11).text_color(t.muted).child(plan.body))
        .child(h_flex().pt(2).gap(6).justify_end()
          .child(button(t, "bulk-sheet-cancel", [keycap(t, "esc"), "Cancel"], cancel, { size: "sm" }))
          .child(button(t, "bulk-confirm", [keycap(t, "enter", { tone: t.blocked }), `Remove ${plan.n}`], (cx) => this.confirmBulk(cx), { size: "sm", kind: "danger" }))));
  }

  // x, X, d and Esc for the selection and its question; s, o and d for the selected worktree. True when the key was taken.
  maintenanceKey(e, cx) {
    const key = e.key, w = this.inView().find((x) => `wt-${x.path}` === this.sel);
    const asked = w && (this.confirm === w.path || this.deleteAsk?.path === w.path || this.pushAsk?.path === w.path);
    if (this.bulkAsk && (key === "enter" || key === "escape")) {
      if (key === "enter") this.confirmBulk(cx);
      else this.bulkAsk = null;
    } else if (key === "X" || (key === "x" && e.modifiers?.shift)) this.markAllSafe(cx);
    else if (key === "x" && w) this.toggleMark(w, cx);
    else if (key === "d" && this.marked?.size) this.askBulk(cx);
    else if (key === "escape" && this.marked?.size) this.clearMarks();
    else if (key === "escape" && asked) {
      if (this.confirm === w.path) this.confirm = null;
      if (this.deleteAsk?.path === w.path) this.deleteAsk = null;
      if (this.pushAsk?.path === w.path) this.pushAsk = null;
    } else if (key === "enter" && w && this.confirm === w.path) this.removeTree(w, cx);
    else if (key === "enter" && w && this.deleteAsk?.path === w.path) this.askDelete(w, cx);
    else if (w && ["s", "o", "d"].includes(key)) {
      const moves = this.rowMoves(w, Date.now() / 1000);
      // d only asks; the answer is Enter or the button, so a held key can't delete.
      if (key === "d" && !asked) moves.remove?.(cx);
      else if (key === "s") (moves.patch ?? moves.commits)?.(cx);
      else if (key === "o") moves.folder();
    } else return false;
    return true;
  }

  offersRemove(w, now) {
    const inUse = w.merged && !w.landed && justUsed(w.at, now);
    return !w.dirty && !w.locked && !inUse && (w.merged || w.group === "safe" || w.group === "pushed");
  }

  // What a row can do, for its buttons and its keys alike. Save, push and Delete only where there is work;
  // `direct` says Remove loses nothing here, so it can be the row's one action.
  rowMoves(w, now) {
    const acts = w.group === "work" ? w.actions ?? [] : [], saved = (r) => ({ title: "Saved", body: r.file });
    const forever = acts.includes("delete"), offers = !forever && this.offersRemove(w, now);
    return {
      patch: acts.includes("patch") ? (cx) => this.treeAction(w, cx, () => savePatch(w), saved) : null,
      commits: acts.includes("commits") ? (cx) => this.treeAction(w, cx, () => saveCommits(w), saved) : null,
      push: acts.includes("push") ? (cx) => this.askPush(w, cx) : null,
      folder: () => exec("open", [w.path]),
      forever, offers,
      direct: offers && !w.ignored?.length && !w.unreadable && w.group !== "work" && (w.merged || w.group === "safe"),
      remove: forever ? (cx) => this.askDelete(w, cx) : offers ? (cx) => this.removeTree(w, cx) : null,
    };
  }

  // Remove, or its Confirm once asked. `keyed` is the selected row's: with its key, and named for what it costs.
  removeButton(t, w, { sure = false, keyed = false } = {}) {
    const lost = w.ignored?.length > 0, words = keyed ? [keycap(t, "d"), lost ? "Delete forever" : "Remove"] : "Remove";
    return button(t, `wt-rm-${w.path}`, sure ? "Confirm" : words, (cx) => this.removeTree(w, cx), {
      size: "sm", tip: w.group === "pushed" ? TIPS.pushed : TIPS.remove, kind: sure || (keyed && lost) ? "danger" : "outline", disabled: this.treeBusy?.has(w.path),
    });
  }

  openButton(t, w) {
    return button(t, `wt-open-${w.path}`, w.space ? "Go" : "Open", () => this.openTree(w), { size: "sm", tip: w.space ? "Go to its space" : "Open a space here" });
  }

  // Under a selected row: the question before a push or a delete, else every action with its key.
  actionsLine(t, w, moves, { open = true, remove = true } = {}) {
    const id = (name) => `wt-${name}-${w.path}`, busy = this.treeBusy?.has(w.path);
    const line = (children) => h_flex().pt(2).gap(5).flex_wrap().items_center().children(children.filter(Boolean));
    const cancel = (key) => button(t, id("cancel"), "Cancel", (cx) => {
      this[key] = null;
      cx.notify();
    }, { size: "sm" });
    const say = (text) => div().min_w(0).text_size(11).text_color(t.blocked).child(text);
    if (this.deleteAsk?.path === w.path) {
      return line([say(this.deleteAsk.text), button(t, id("delete-go"), [keycap(t, "enter", { tone: t.blocked }), "Delete forever"], (cx) => this.askDelete(w, cx), {
        size: "sm", kind: "danger", disabled: busy,
        tip: this.deleteAsk.ignored?.length ? `Ignored: ${this.deleteAsk.ignored.slice(0, 8).join(", ")}` : null,
      }), cancel("deleteAsk")]);
    }
    if (this.pushAsk?.path === w.path) {
      return line([say(this.pushAsk.text), button(t, id("push-go"), this.pushAsk.label, (cx) => this.askPush(w, cx), {
        size: "sm", kind: "danger", disabled: busy,
      }), cancel("pushAsk")]);
    }
    const act = (name, label, onClick, kind = "outline") => onClick && button(t, id(name), label, onClick, { size: "sm", tip: TIPS[name] ?? w.path, kind, disabled: busy });
    return line([
      act("patch", [keycap(t, "s"), "Save patch"], moves.patch),
      act("commits", moves.patch ? "Save commits" : [keycap(t, "s"), "Save commits"], moves.commits),
      act("push", "Push backup", moves.push),
      open && this.openButton(t, w),
      act("folder", [keycap(t, "o"), "Open folder"], moves.folder),
      remove && moves.forever && button(t, id("delete"), [keycap(t, "d"), "Delete forever"], moves.remove, { size: "sm", tip: TIPS.forever, kind: "danger", disabled: busy }),
      remove && moves.offers && this.removeButton(t, w, { keyed: true }),
    ]);
  }

  // The selected row's facts and, in a block, the files git never saw that would go with the folder.
  loseLines(t, w) {
    const lose = loseOf(w);
    return [
      ...lose.says.map((l) => div().min_w(0).text_size(11).text_color(t.muted).child(l)),
      lose.files.length ? v_flex().id(`wt-lose-${w.path}`).min_w(0).px(8).py(5).rounded(6).bg(t.raised)
        .font_family(settings().font_family ?? "JetBrains Mono").text_size(11).text_color(t.foreground)
        .children(lose.files.map((f) => div().min_w(0).truncate().child(f)))
        .when(lose.more > 0, (el) => el.child(div().text_color(t.dim).child(`+${lose.more} more`))) : null,
    ].filter(Boolean);
  }

  look(id, cx) {
    this.sel = id;
    this.clicked = true;
    this.h?.focus();
    cx.notify();
  }

  // One row per worktree: whose turn, repo, branch and reason, its size and one action. Remove asks once more
  // before git runs; selected, the row says what would be lost and offers the rest.
  treeRow(t, w) {
    const id = `wt-${w.path}`, now = Date.now() / 1000;
    if (this.hiddenIds?.has(id)) return null;
    if (this.removing.has(w.path)) return this.removingRow(t, w);
    const lane = w.lane ?? laneOf(w, now), sel = this.selected(id), err = this.wtError[w.path], sure = this.confirm === w.path;
    const warn = sure ? [w.space && "closes its space", w.ignored?.length && deletes(w.ignored)].filter(Boolean).join(", ") : "";
    const asking = this.deleteAsk?.path === w.path || this.pushAsk?.path === w.path, moves = this.rowMoves(w, now);
    const edge = this.marked?.size ? this.markBox(t, w)
      : sure || moves.direct ? this.removeButton(t, w, { sure })
        : lane === "quiet" ? this.openButton(t, w)
          : sel || asking ? null
            : w.group === "pushed" ? this.openButton(t, w)
              : button(t, `wt-look-${w.path}`, "Look", (cx) => this.look(id, cx), { size: "sm", tip: "What removing it would lose" });
    const below = [
      err || warn ? div().id(`wt-note-${w.path}`).min_w(0).text_size(11).text_color(t.blocked).child(err ?? warn) : null,
      ...(sel || asking ? [...this.loseLines(t, w), this.actionsLine(t, w, moves, { open: lane !== "quiet", remove: !sure && !moves.direct })] : []),
    ].filter(Boolean);
    return row(t, id, {
      turn: !w.merged && !w.group ? "flight" : TURN[lane], kind: "tree", title: w.repo,
      reason: `${w.branch ?? `${w.name} (detached)`} · ${reasonOf(w, now)}`,
      age: w.kb && !this.tightInbox ? sizeOf(w.kb) : null, action: edge, selected: sel, tip: w.path,
      onSelect: this.pick ? (cx) => this.pick(id, cx) : null, below: below.length ? below : null,
    });
  }

  markBox(t, w) {
    const on = this.marked.has(w.path);
    return div().id(`wt-mark-${w.path}`).p(5).flex_none().cursor_pointer()
      .accessibility_label(`${on ? "Unselect" : "Select"} ${w.repo} ${w.branch ?? w.name}`)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.toggleMark(w, cx);
      })
      .child(checkbox(t, on));
  }

  // git can take a few seconds on a big checkout; the spinner runs natively, without redraws.
  removingRow(t, w) {
    const gone = this.gone.has(w.path);
    return h_flex().id(`wt-${w.path}`).h(gone ? 0 : 38).pl(LANE).pr(8).gap(7).items_center().rounded(6).overflow_hidden()
      .opacity(gone ? 0 : 0.6)
      .transition("opacity", { duration: 200 }).transition("height", { duration: 220, easing: "ease-out" })
      .child(div().flex_none().font_semibold().text_size(13).child(w.repo))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.muted).child(w.branch ?? w.name))
      .child(h_flex().flex_none().gap(5).items_center().text_size(11).text_color(t.blocked)
        .child(spinner(t.blocked))
        .child("Removing…"));
  }

  backupsRow(t) {
    return h_flex().id("wt-backups").h(30).mt(6).pl(LANE).pr(8).gap(6).items_center().text_size(11).text_color(t.muted).tooltip(backupsRoot())
      .child(div().flex_1().child("Backups"))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(sizeOf(this.backupsKb)))
      .child(button(t, "wt-backups-open", "Open", () => exec("open", [backupsRoot()]), { size: "sm" }));
  }

  // Maintenance's worktree groups: Safe to remove with its total and Remove N, Needs a look, and one quiet fold
  // for what was used lately or is still being read.
  treeSections(t, lanes) {
    const rows = (list) => joined(t, list.map((w) => this.treeRow(t, w)));
    const clean = this.removable(lanes.safe), kb = totalKb(lanes.safe);
    const safe = lanes.safe.length ? [legHeader(t, "leg-safe", "Safe to remove", lanes.safe.length, { after: [
      kb && !this.tightInbox ? div().id("safe-size").flex_none().text_color(t.muted).child(sizeOf(kb)) : null,
      clean.length > 1 ? button(t, "wt-rm-all", `Remove ${clean.length}`, (cx) => this.askBulk(cx, clean), {
        size: "sm", tip: "Selects every one that has no space and asks once",
      }) : null,
    ] }), ...rows(lanes.safe)] : [];
    const look = lanes.look.length ? [legHeader(t, "leg-look", "Needs a look", lanes.look.length), ...rows(lanes.look)] : [];
    const checking = lanes.quiet.filter((w) => !w.merged && !w.group).length, recent = lanes.quiet.length - checking;
    const label = [recent ? `${recent} recent` : null, checking ? `${recent ? "checking" : "Checking"} ${checking}` : null].filter(Boolean).join(" · ");
    const quiet = lanes.quiet.length ? [
      foldRow(this, t, "loose-recent", "loose-recent", label, { gap: true, after: checking ? spinner(t.dim, 10) : null }),
      ...(this.expanded["loose-recent"] ? rows(lanes.quiet) : []),
    ] : [];
    if (this.backupsKb) quiet.push(this.backupsRow(t));
    return { safe, look, quiet };
  }

}
