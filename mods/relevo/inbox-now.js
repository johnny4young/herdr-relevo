import { div } from "gpui-kit";
import { exec, run, shared, setShared, theme } from "herdr";
import { openReview } from "./review.js";
import { openDesktop } from "./desktop.js";
import { recent } from "./lib/github.js";
import { prTurn } from "./lib/lanes.js";
import { foldRow, joined, legend, legHeader, saveFolds, TURN_LABEL } from "./ui.js";

// Reviews has two views: Now, by whose turn it is, and Maintenance, for what can wait.
export const REVIEW_VIEW = "relevo.inbox.view";
export const NOW_SECTIONS = ["away", "me", "flight", "ready", "open"];
export const MAINTENANCE_SECTIONS = ["safe", "look", "old", "quiet", "done", "today"];
const GROUPS = ["me", "flight", "ready"];

// Mixed into Inbox, so `this` is the Inbox.
export class NowViews {
  reviewView() {
    return shared(REVIEW_VIEW) === "maintenance" ? "maintenance" : "now";
  }

  // Maintenance reads the loose worktrees the first time it opens; a selection does not outlive the view.
  setReviewView(view, cx) {
    if (this.reviewView() !== view) setShared(REVIEW_VIEW, view);
    this.sel = null;
    this.clearMarks();
    if (view === "maintenance" && !this.expanded.loose) {
      this.expanded.loose = true;
      saveFolds(this.expanded);
      this.loadTreeStates(cx);
    }
    cx.notify();
  }

  // Selects a row wherever it lives: the view it is in, with its fold opened.
  reveal(id) {
    const v = this.shown(), t = theme(), entry = this.nowEntries(t, v).find((e) => e.id === id);
    // Selected first: a folded merged worktree is in sight only once selected.
    this.sel = id;
    this.clicked = false;
    if (entry) {
      if (this.reviewView() !== "now") setShared(REVIEW_VIEW, "now");
      if (entry.turn === "open") this.expanded["now-open"] = true;
    } else {
      if (this.reviewView() !== "maintenance") setShared(REVIEW_VIEW, "maintenance");
      const m = this.maintenanceModel(v);
      if (m.lanes.quiet.some((w) => `wt-${w.path}` === id)) this.expanded["loose-recent"] = true;
      this.expanded["maintenance-done"] = this.expanded["maintenance-done"] || !this.maintenanceNav(v, m).some((n) => n.id === id);
    }
    saveFolds(this.expanded);
  }

  // Everything in Now, in the order to work through it: each entry has its turn, how it draws, and what Enter
  // and the number keys do.
  nowEntries(t, v) {
    const out = [], add = (entry) => out.push(entry);
    const ready = new Set((v.ready ?? []).map((p) => p.url));
    const prTurnOf = (pr, requested) => prTurn(pr, { requested, seen: this.seen(pr), busy: Boolean(this.launchedMap()[pr.url]) && this.prBusy(pr), ready: ready.has(pr.url) });
    for (const i of v.local.filter((x) => x.kind === "blocked")) {
      const drawn = i.prompt;
      add({ id: `in-${i.agent.address}`, turn: "me", draw: () => this.localCard(t, i), go: () => run("agent.focus", { terminal: i.agent.address }),
        choose: (n, cx) => {
          const option = drawn?.options.find((o) => o.n === n);
          if (option) this.answer(i.agent, option, cx, drawn);
        } });
    }
    for (const s of v.desktop) add({ id: `dk-${s.id}`, turn: s.state === "blocked" ? "me" : "ready", draw: () => this.desktopCard(t, s), go: () => openDesktop(s.id) });
    for (const [url, e] of Object.entries(this.landing()).filter(([, e]) => e.phase !== "landed")) {
      add({ id: `land-${url}`, turn: e.phase === "failed" ? "me" : "flight", draw: () => this.landCard(t, url, e), go: () => exec("open", [e.failed?.url ?? url]) });
    }
    for (const entry of this.openReviews()) add({ id: entry.id, turn: "me", draw: () => this.reviewRow(t, entry), go: entry.go });
    const prs = [...v.requested.filter(recent).map((pr) => [pr, true]), ...[...v.mine, ...(v.ready ?? [])].filter(recent).map((pr) => [pr, false])];
    for (const [pr, requested] of prs) {
      add({ id: `pr-${pr.url}`, turn: prTurnOf(pr, requested), draw: () => this.prCard(t, pr, requested, false, ready.has(pr.url)), go: () => this.runPR(pr) });
    }
    for (const i of v.local.filter((x) => x.kind === "diff")) {
      add({ id: `in-${i.agent.address}`, turn: "me", draw: () => this.localCard(t, i), go: () => openReview(i.top, i.agent.address) });
    }
    for (const source of this.linkedReviews(v).filter((s) => !s.addressed)) {
      add({ id: `pr-${source.pr.url}`, turn: source.draft ? "open" : prTurnOf(source.pr, false),
        draw: () => (source.draft ? this.draftCard(t, source.pr) : this.prCard(t, source.pr, false)),
        go: () => (source.draft ? exec("open", [source.pr.url]) : this.runPR(source.pr)) });
    }
    for (const pr of this.drafts ?? []) add({ id: `pr-${pr.url}`, turn: "open", draw: () => this.draftCard(t, pr), go: () => exec("open", [pr.url]) });
    const seen = new Set();
    return out.filter((e) => !seen.has(e.id) && seen.add(e.id))
      .map((e) => ({ ...e, turn: GROUPS.includes(e.turn) ? e.turn : "open", section: GROUPS.includes(e.turn) ? e.turn : "open" }));
  }

  // The selectable rows in screen order: what you were away for, then each group; "open" only once unfolded.
  nowNav(entries) {
    const away = this.awayItems().map((r) => ({ id: r.id, section: "away", go: r.go }));
    const order = [...GROUPS, ...(this.expanded["now-open"] ? ["open"] : [])];
    return [...away, ...order.flatMap((turn) => entries.filter((e) => e.turn === turn))];
  }

  nowCounts(entries) {
    return Object.fromEntries([...GROUPS, "open"].map((turn) => [turn, entries.filter((e) => e.turn === turn).length]));
  }

  nowLegend(t, counts) {
    return legend(t, "now-legend", GROUPS.map((turn) => ({ turn, n: counts[turn] })));
  }

  nowGroups(t, entries, part) {
    const counts = this.nowCounts(entries), els = [];
    for (const turn of GROUPS) {
      const list = entries.filter((e) => e.turn === turn);
      if (!list.length) continue;
      els.push(...part(turn, [legHeader(t, `leg-${turn}`, TURN_LABEL[turn], list.length, { me: turn === "me" }), ...joined(t, list.map((e) => e.draw()))]));
    }
    if (counts.open) {
      els.push(foldRow(this, t, "now-open", "now-open", `${counts.open} waiting on others`, { gap: true }));
      if (this.expanded["now-open"]) els.push(...joined(t, entries.filter((e) => e.turn === "open").map((e) => e.draw())));
    }
    return els;
  }

  // What can wait: PRs past 45 days, worktrees, what you marked addressed, landed PRs and agent time.
  // [pr, requested] for every PR past 45 days, yours ready to merge included.
  oldPRs(v) {
    return [...v.requested.filter((p) => !recent(p)).map((p) => [p, true]),
      ...[...v.mine, ...(v.ready ?? [])].filter((p) => !recent(p)).map((p) => [p, false])];
  }

  // What Maintenance shows, read once per draw: the worktree lanes, the old PRs and the stale branches read so
  // far. The legend, the tab's count, the groups and the keyboard all take it from here.
  maintenanceModel(v) {
    const lanes = this.treeLanes(v.worktrees), old = this.oldPRs(v), oldCount = old.length + this.staleShown().length;
    return { lanes, old, oldCount, count: lanes.safe.length + lanes.look.length + oldCount };
  }

  maintenanceLegend(t, m) {
    return legend(t, "maintenance-legend", [
      { turn: "ready", label: "Safe to remove", n: m.lanes.safe.length }, { turn: "open", label: "Needs a look", n: m.lanes.look.length },
      { turn: "old", n: m.oldCount },
    ], { narrow: Boolean(this.tightInbox) });
  }

  maintenanceGroups(t, v, part, m) {
    const { old, oldCount } = m, trees = this.treeSections(t, m.lanes);
    const landed = Object.entries(this.landing()).filter(([, e]) => e.phase === "landed");
    const doneCount = v.localDone.length + v.mineDone.length + v.requestedDone.length + v.desktopDone.length + this.doneReviews().length + landed.length;
    return [
      ...part("safe", trees.safe),
      ...part("look", trees.look),
      ...part("old", [oldCount ? legHeader(t, "leg-old", TURN_LABEL.old, oldCount) : null,
        ...joined(t, old.map(([p, requested]) => this.prCard(t, p, requested))), ...this.staleGroup(t, oldCount > 0)]),
      ...part("quiet", trees.quiet),
      ...part("done", doneCount ? [
        foldRow(this, t, "maintenance-done", "maintenance-done", `${doneCount} marked addressed or landed`, { gap: true }),
        ...(this.expanded["maintenance-done"] ? [
          ...v.localDone.map((i) => this.localCard(t, i, true)),
          ...v.requestedDone.map((p) => this.prCard(t, p, true, true)),
          ...v.mineDone.map((p) => this.prCard(t, p, false, true)),
          ...v.desktopDone.map((s) => this.desktopCard(t, s, true)),
          ...this.doneReviews().map((entry) => this.reviewRow(t, entry, true)),
          ...landed.map(([url, e]) => this.landCard(t, url, e)),
        ] : []),
      ] : []),
      ...part("today", this.todayGroup(t, v.today)),
    ].filter(Boolean);
  }

  maintenanceNav(v, m = this.maintenanceModel(v)) {
    const old = m.old.map(([pr]) => ({ id: `pr-${pr.url}`, section: "old", go: () => this.runPR(pr) })), lanes = m.lanes;
    const trees = (key) => (key === "quiet" && !this.expanded["loose-recent"] ? [] : lanes[key])
      .map((w) => ({ id: `wt-${w.path}`, section: key, go: () => this.openTree(w) }));
    // Unfolded, what you marked addressed is selectable too, so its Undo can be reached.
    const done = !this.expanded["maintenance-done"] ? [] : [
      ...v.localDone.map((i) => ({ id: `in-${i.agent.address}`, go: () => openReview(i.top, i.agent.address) })),
      ...[...v.requestedDone, ...v.mineDone].map((pr) => ({ id: `pr-${pr.url}`, go: () => this.runPR(pr) })),
      ...v.desktopDone.map((d) => ({ id: `dk-${d.id}`, go: () => openDesktop(d.id) })),
      ...this.doneReviews().map((entry) => ({ id: entry.id, go: entry.go })),
      ...Object.entries(this.landing()).filter(([, e]) => e.phase === "landed").map(([url]) => ({ id: `land-${url}`, go: () => exec("open", [url]) })),
    ].map((item) => ({ ...item, section: "done" }));
    return [...trees("safe"), ...trees("look"), ...old, ...this.staleNav(), ...trees("quiet"), ...done];
  }

  emptyNow(t) {
    return div().id("now-empty").p(12).text_size(13).text_color(t.dim).child("Nothing needs you");
  }
}
