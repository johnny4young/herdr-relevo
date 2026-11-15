// Maintenance's stale branches: a fold at the end of Old. Mixed into Inbox, so `this` is the Inbox.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { notify } from "herdr";
import { contextOfPath, inFocus } from "./context.js";
import { deleteBranch, scanStale } from "./branches.js";
import { staleReason } from "./lib/branches.js";
import { button, foldRow, joined, row, saveFolds, spinner } from "./ui.js";

const idOf = (b) => `br-${b.main}:${b.name}`;

export class BranchViews {
  // Only once the fold has been opened, and again on a refresh; the scan itself keeps each repo for 15 minutes.
  scanStale(cx, force = false) {
    if (this.scanningStale) return;
    this.scanningStale = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.stale = await scanStale(force);
        this.staleFailed = null;
      } catch (e) {
        this.staleFailed = String(e?.message ?? e);
      } finally {
        this.scanningStale = false;
      }
      cx.notify();
    });
  }

  // The branches read so far, in the focused context; none before the fold first opens.
  staleShown() {
    return (this.stale ?? []).filter((b) => inFocus(contextOfPath(b.main)));
  }

  staleNav() {
    return this.expanded.stale ? this.staleShown().map((b) => ({ id: idOf(b), section: "old", go: () => {} })) : [];
  }

  deleteStale(b, cx) {
    this.staleBusy ??= new Set();
    this.staleError ??= {};
    if (this.staleBusy.has(idOf(b))) return;
    this.staleBusy.add(idOf(b));
    delete this.staleError[idOf(b)];
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await deleteBranch(b);
        if (r.error) this.staleError[idOf(b)] = r.error;
        else {
          this.stale = (this.stale ?? []).filter((x) => idOf(x) !== idOf(b));
          notify({ title: `Deleted branch ${b.name}`, body: r.said || b.repo, level: "success" });
        }
      } catch (e) {
        this.staleError[idOf(b)] = String(e?.message ?? e);
      } finally {
        this.staleBusy.delete(idOf(b));
      }
      cx.notify();
    });
  }

  staleRow(t, b, now) {
    const id = idOf(b), err = this.staleError?.[id];
    if (this.hiddenIds?.has(id)) return null;
    return row(t, id, {
      turn: "old", kind: "tree", title: b.repo, reason: `${b.name} · ${staleReason(b, now)}`, tip: b.main, selected: this.selected(id),
      onSelect: this.pick ? (cx) => this.pick(id, cx) : null,
      action: button(t, `br-del-${b.main}:${b.name}`, "Delete branch", (cx) => this.deleteStale(b, cx), {
        size: "sm", disabled: this.staleBusy?.has(id), tip: "Runs git branch -d, which keeps a branch whose commits are not merged",
      }),
      below: err ? err.split("\n").map((l) => div().min_w(0).text_size(11).text_color(t.blocked).child(l)) : null,
    });
  }

  // `under` says an Old header sits above; with none read yet the fold names no count.
  staleGroup(t, under = false) {
    const list = this.staleShown(), open = Boolean(this.expanded.stale), read = Array.isArray(this.stale);
    if (read && !list.length && !this.staleFailed) return [];
    const label = read ? `${list.length} ${list.length === 1 ? "branch" : "branches"} nobody touched in 30 days` : "Branches nobody touched in 30 days";
    const toggle = (cx) => {
      this.expanded.stale = !open;
      saveFolds(this.expanded);
      if (!open) this.scanStale(cx);
      cx.notify();
    };
    const fold = foldRow(this, t, "stale-branches", "stale", label, {
      gap: !under, onOpen: (cx) => this.scanStale(cx),
      after: h_flex().flex_1().gap(6).justify_end().items_center()
        .when(Boolean(this.scanningStale), (el) => el.child(spinner(t.dim, 10)))
        .child(button(t, "stale-show", open ? "Hide" : "Show", toggle, { size: "sm" })),
    });
    if (!open) return [fold];
    const now = Date.now() / 1000;
    return [fold,
      this.staleFailed ? div().id("stale-error").pl(24).pr(8).text_size(11).text_color(t.blocked).child(this.staleFailed) : null,
      ...joined(t, list.map((b) => this.staleRow(t, b, now)))].filter(Boolean);
  }
}
