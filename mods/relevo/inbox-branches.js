// Maintenance's stale branches: a fold at the end of Old. Mixed into Inbox, so `this` is the Inbox.
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { notify } from "herdr";
import { contextOfPath, inFocus } from "./context.js";
import { deleteBranch, scanStale, staleOf } from "./branches.js";
import { staleReason } from "./lib/branches.js";
import { button, foldRow, joined, row, spinner, toggleFold, LANE } from "./ui.js";

const idOf = (b) => `br-${b.main}:${b.name}`;

export class BranchViews {
  // Only once the fold has been opened, and again on a refresh; the scan itself keeps each repo for 15 minutes.
  scanStale(cx, force = false) {
    if (this.scanningStale) return;
    this.scanningStale = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const read = await scanStale(force);
        this.stale = read.branches;
        this.staleMissed = read.failed;
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

  // Repos whose branches could not be read: said, never shown as "no stale branches".
  missedShown() {
    return (this.staleMissed ?? []).filter((main) => inFocus(contextOfPath(main)));
  }

  retryStale(main, cx) {
    this.staleRetrying ??= new Set();
    if (this.staleRetrying.has(main)) return;
    this.staleRetrying.add(main);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const read = await staleOf(main);
        if (!read.failed) {
          this.stale = [...(this.stale ?? []).filter((b) => b.main !== main), ...read.list];
          this.staleMissed = (this.staleMissed ?? []).filter((m) => m !== main);
        }
      } finally {
        this.staleRetrying.delete(main);
      }
      cx.notify();
    });
  }

  missedRow(t, main) {
    const busy = Boolean(this.staleRetrying?.has(main));
    return h_flex().id(`stale-miss-${main}`).min_h(30).pl(LANE).pr(8).gap(6).items_center().text_size(11).text_color(t.muted).tooltip(main)
      .child(div().flex_1().min_w(0).truncate().child(`Couldn't read branches in ${main.split("/").pop()}`))
      .when(busy, (el) => el.child(spinner(t.dim, 10)))
      .child(button(t, `stale-retry-${main}`, "Retry", (cx) => this.retryStale(main, cx), { size: "sm", disabled: busy }));
  }

  staleNav() {
    return this.expanded.stale ? this.staleShown().map((b) => ({ id: idOf(b), section: "old", go: () => {} })) : [];
  }

  deleteStale(b, cx) {
    this.staleBusy ??= new Set();
    this.staleError ??= {};
    if (this.staleBusy.has(idOf(b))) return;
    this.staleAsk ??= {};
    const asked = this.staleAsk[idOf(b)];
    this.staleBusy.add(idOf(b));
    delete this.staleError[idOf(b)];
    delete this.staleAsk[idOf(b)];
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await deleteBranch(asked ? { ...b, ask: asked.ask } : b, asked?.tip ?? null);
        if (r.error) this.staleError[idOf(b)] = r.error;
        else if (r.ask) this.staleAsk[idOf(b)] = r;
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
    const id = idOf(b), err = this.staleError?.[id], ask = this.staleAsk?.[id]?.ask;
    if (this.hiddenIds?.has(id)) return null;
    const note = err ?? ask ?? null;
    return row(t, id, {
      turn: "old", kind: "tree", title: b.repo, reason: `${b.name} · ${staleReason(b, now)}`, tip: b.main, selected: this.selected(id),
      onSelect: this.pick ? (cx) => this.pick(id, cx) : null,
      action: button(t, `br-del-${b.main}:${b.name}`, ask ? "Confirm" : "Delete branch", (cx) => this.deleteStale(b, cx), {
        size: "sm", disabled: this.staleBusy?.has(id), kind: ask ? "danger" : "outline",
        tip: ask ? "Runs git branch -D; its commit goes to deletions.log" : "Runs git branch -d, which keeps a branch whose commits are not merged",
      }),
      below: note ? [div().id(`br-note-${b.main}:${b.name}`).min_w(0).text_size(11).text_color(t.blocked).child(note)] : null,
    });
  }

  // `under` says an Old header sits above; with none read yet the fold names no count.
  staleGroup(t, under = false) {
    const list = this.staleShown(), missed = this.missedShown(), open = Boolean(this.expanded.stale), read = Array.isArray(this.stale);
    if (read && !list.length && !missed.length && !this.staleFailed) return [];
    const label = read ? `${list.length} ${list.length === 1 ? "branch" : "branches"} nobody touched in 30 days` : "Branches nobody touched in 30 days";
    const scan = (cx) => this.scanStale(cx);
    const fold = foldRow(this, t, "stale-branches", "stale", label, {
      gap: !under, onOpen: scan,
      after: h_flex().flex_1().gap(6).justify_end().items_center()
        .when(Boolean(this.scanningStale), (el) => el.child(spinner(t.dim, 10)))
        .child(button(t, "stale-show", open ? "Hide" : "Show", (cx) => toggleFold(this, "stale", cx, scan), { size: "sm" })),
    });
    if (!open) return [fold];
    const now = Date.now() / 1000;
    return [fold,
      this.staleFailed ? div().id("stale-error").pl(24).pr(8).text_size(11).text_color(t.blocked).child(this.staleFailed) : null,
      ...joined(t, list.map((b) => this.staleRow(t, b, now))), ...missed.map((main) => this.missedRow(t, main))].filter(Boolean);
  }
}
