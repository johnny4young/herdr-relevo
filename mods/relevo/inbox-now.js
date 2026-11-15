import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, exec, panes, run, shared, setShared, terminals, theme } from "herdr";
import { openReview } from "./review.js";
import { REVIEW_VIEW } from "./toolbar.js";
import { openDesktop } from "./desktop.js";
import { endTerminal, openTerminal, restartTerminal } from "./terminals.js";
import { terminalRow, tidyRows } from "./lib/terminals.js";
import { ago } from "./lib/time.js";
import { openGoal } from "./goals-editor.js";
import { recent } from "./lib/github.js";
import { prTurn } from "./lib/lanes.js";
import { button, foldRow, icon, joined, keycap, keysOf, LANE, laneGlyph, legend, legHeader, saveFolds, TURN_LABEL } from "./ui.js";

// Reviews has two views: Now, by whose turn it is, and Maintenance, for what can wait.
export { REVIEW_VIEW };
export const NOW_SECTIONS = ["errors", "away", "me", "flight", "ready", "open"];
export const MAINTENANCE_SECTIONS = ["safe", "look", "old", "terms", "quiet", "done", "today"];
const GROUPS = ["me", "flight", "ready"];
const SHORT = { me: "Me", flight: "Flight", ready: "Ready" };
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const said = (n) => (n < WORDS.length ? WORDS[n] : String(n));
const capital = (s) => s[0].toUpperCase() + s.slice(1);

// How old the last good read is, for a source that could not be read again.
export function staleFor(at, now = Date.now() / 1000) {
  const m = Math.max(1, Math.round((now - at) / 60));
  return m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`;
}

export function inFlightLine(n) {
  if (!n) return null;
  return `${capital(said(n))} ${n === 1 ? "thing is" : "things are"} still in flight.`;
}

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
      if (!this.filterNow([entry]).length) this.filterField.set_value("");
      if (this.reviewView() !== "now") setShared(REVIEW_VIEW, "now");
      if (entry.turn === "open") this.expanded["now-open"] = true;
    } else {
      if (this.reviewView() !== "maintenance") setShared(REVIEW_VIEW, "maintenance");
      // As setReviewView does: the next scan reads the loose worktrees, or they stay "checking".
      this.expanded.loose = true;
      const m = this.maintenanceModel(v);
      if (m.lanes.quiet.some((w) => `wt-${w.path}` === id)) this.expanded["loose-recent"] = true;
      this.expanded["maintenance-done"] = this.expanded["maintenance-done"] || !this.maintenanceNav(v, m).some((n) => n.id === id);
    }
    saveFolds(this.expanded);
  }

  // ✓ hides a row until something new happens, and u takes the last one back; Undo brings it back. `key` names both.
  markAction(key, addressed, set, tip, { on = "addressed", off = "undo" } = {}) {
    if (addressed) return { id: `${off}-${key}`, label: "Undo", run: (cx) => set(false, cx), tip: "Back to the list" };
    return { id: `${on}-${key}`, key: "a", label: [icon("check")], tip, run: (cx) => {
      set(true, cx);
      this.lastMark = (c) => set(false, c);
    } };
  }

  // Everything in Now, in the order to work through it: each entry has its turn, how it draws, and what Enter,
  // the number keys and the row's keys do; `keys` reads the row's action table only when a key asks.
  nowEntries(t, v) {
    const out = [], add = (entry) => out.push(entry);
    const ready = new Set((v.ready ?? []).map((p) => p.url));
    const prTurnOf = (pr, requested) => prTurn(pr, { requested, seen: this.seen(pr), busy: Boolean(this.launchedMap()[pr.url]) && this.prBusy(pr), ready: ready.has(pr.url) });
    for (const i of v.local.filter((x) => x.kind === "blocked")) {
      const drawn = i.prompt;
      add({ id: `in-${i.agent.address}`, turn: "me", text: `${i.repo} ${i.branch ?? ""} ${drawn?.question ?? ""}`, draw: () => this.localCard(t, i), go: () => run("agent.focus", { terminal: i.agent.address }),
        keys: () => keysOf(this.localActions(i)),
        choose: (n, cx) => {
          const option = drawn?.options.find((o) => o.n === n);
          if (option) this.answer(i.agent, option, cx, drawn);
        } });
    }
    for (const s of v.desktop) add({ id: `dk-${s.id}`, turn: s.state === "blocked" ? "me" : "ready", text: `${s.project} ${s.title ?? ""} ${s.needs ?? ""}`,
      draw: () => this.desktopCard(t, s), go: () => openDesktop(s.id), keys: () => keysOf(this.desktopActions(s)) });
    for (const [url, e] of Object.entries(this.landing()).filter(([, e]) => e.phase !== "landed")) {
      add({ id: `land-${url}`, turn: e.phase === "failed" ? "me" : "flight", text: `${e.repo} ${e.number} ${e.title}`,
        draw: () => this.landCard(t, url, e), go: () => exec("open", [e.failed?.url ?? url]), keys: () => keysOf(this.landActions(url, e)) });
    }
    for (const entry of this.openReviews()) add({ id: entry.id, turn: "me", text: `${entry.title} ${entry.detail ?? ""}`, draw: () => this.reviewRow(t, entry), go: entry.go,
      keys: () => keysOf(this.reviewActions(entry)) });
    const prs = [...v.requested.filter(recent).map((pr) => [pr, true]), ...[...v.mine, ...(v.ready ?? [])].filter(recent).map((pr) => [pr, false])];
    for (const [pr, requested] of prs) {
      add({ id: `pr-${pr.url}`, repo: pr.repo, turn: prTurnOf(pr, requested), text: `${pr.repo} ${pr.number} ${pr.title} ${pr.author?.login ?? ""}`,
        draw: () => this.prCard(t, pr, requested, false, ready.has(pr.url)), go: () => this.runPR(pr), keys: () => keysOf(this.prActions(t, pr, requested)) });
    }
    for (const i of v.local.filter((x) => x.kind === "diff")) {
      add({ id: `in-${i.agent.address}`, turn: "me", text: `${i.repo} ${i.branch ?? ""}`, draw: () => this.localCard(t, i), go: () => openReview(i.top, i.agent.address),
        keys: () => keysOf(this.localActions(i)) });
    }
    for (const source of this.linkedReviews(v).filter((s) => !s.addressed)) {
      const pr = source.pr;
      add({ id: `pr-${pr.url}`, repo: pr.repo, turn: source.draft ? "open" : prTurnOf(pr, false), text: `${pr.repo} ${pr.number} ${pr.title}`,
        keys: () => keysOf(source.draft ? this.draftActions(pr) : this.prActions(t, pr, false)),
        draw: () => (source.draft ? this.draftCard(t, pr) : this.prCard(t, pr, false)),
        go: () => (source.draft ? exec("open", [pr.url]) : this.runPR(pr)) });
    }
    for (const pr of this.drafts ?? []) add({ id: `pr-${pr.url}`, repo: pr.repo, turn: "open", text: `${pr.repo} ${pr.number} ${pr.title}`, draw: () => this.draftCard(t, pr), go: () => exec("open", [pr.url]),
      keys: () => keysOf(this.draftActions(pr)) });
    const seen = new Set();
    return out.filter((e) => !seen.has(e.id) && seen.add(e.id))
      .map((e) => ({ ...e, turn: GROUPS.includes(e.turn) ? e.turn : "open", section: GROUPS.includes(e.turn) ? e.turn : "open" }));
  }

  // A filter typed after / keeps the rows whose words contain it; only the list and its keys see it, never the badge.
  filterNow(entries) {
    const query = (this.filterField?.value() ?? "").trim().toLowerCase();
    return query ? entries.filter((e) => (e.text ?? "").toLowerCase().includes(query)) : entries;
  }

  // The selectable rows in screen order: what could not be read, what you were away for, then each group; "open" only once unfolded.
  nowNav(entries) {
    const errors = this.readErrors().map((e) => ({ id: e.id, section: "errors", go: e.retry, keys: () => keysOf({ main: this.retryAction(e) }) }));
    const away = this.awayItems().map((r) => ({ id: r.id, section: "away", go: r.go, keys: () => keysOf({ main: this.awayAction(r) }) }));
    const order = [...GROUPS, ...(this.expanded["now-open"] ? ["open"] : [])];
    return [...errors, ...away, ...order.flatMap((turn) => entries.filter((e) => e.turn === turn))];
  }

  nowCounts(entries) {
    return Object.fromEntries([...GROUPS, "open"].map((turn) => [turn, entries.filter((e) => e.turn === turn).length]));
  }

  nowLegend(t, counts) {
    const tight = Boolean(this.tightInbox);
    return legend(t, "now-legend", GROUPS.map((turn) => ({ turn, n: counts[turn], label: tight ? SHORT[turn] : undefined })), { dots: tight });
  }

  // Each source whose last read failed, with how old what is on screen is and how to read it again.
  readErrors() {
    const asOf = (noun, at) => (at ? `${noun} are ${staleFor(at)} old` : "never read");
    return [
      this.error && { id: "error-prs", kind: "pr", title: `GitHub PRs${this.prLogin ? ` · ${this.prLogin}` : ""}`, reason: asOf("PRs", this.prsAt),
        error: this.error, retry: (cx) => this.scanPRs(cx) },
      this.localError && { id: "error-local", kind: "agent", title: "Local agents", reason: asOf("Agents", this.localOkAt),
        error: this.localError, retry: (cx) => this.scanLocal(cx) },
      this.workflowError && { id: "error-workflow", kind: "run", title: "Runs", reason: asOf("Runs", this.workflowAt),
        error: this.workflowError, retry: (cx) => this.loadGoals(cx) },
    ].filter(Boolean);
  }

  retryAction(e) {
    return { id: `retry-${e.id}`, key: "r", label: "Retry", run: (cx) => { e.retry(cx); cx.notify(); }, tip: `Read ${e.title} again` };
  }

  errorGroup(t, errors) {
    if (!errors.length) return [];
    return [legHeader(t, "leg-errors", "Could not read", errors.length, { me: true }),
      ...joined(t, errors.map((e) => this.item(t, e.id, {
        turn: "stuck", kind: e.kind, title: e.title, reason: e.reason, tip: e.error, main: this.retryAction(e),
        lines: [div().text_size(11).text_color(t.muted).child(e.error)],
      })))];
  }

  // Shown in place of Needs me when nothing needs you; what is in flight still lists below it.
  calmBlock(t, { flight, upkeep }) {
    const line = inFlightLine(flight);
    return h_flex().id("now-empty").pt(10).pb(8).pr(8).items_start()
      .child(h_flex().w(LANE).h(18).flex_none().justify_center().child(laneGlyph(t, "ready")))
      .child(v_flex().flex_1().min_w(0).gap(6)
        .child(div().text_size(13).font_semibold().child("Nothing needs you"))
        .when(Boolean(line), (el) => el.child(div().text_size(13).text_color(t.muted).child(line)))
        .child(h_flex().flex_wrap().gap(6).pt(2)
          .child(button(t, "now-empty-maintenance", [keycap(t, "m"), div().child(`Maintenance · ${upkeep}`)], (cx) => this.setReviewView("maintenance", cx), { size: "sm" }))
          .child(button(t, "now-empty-run", [keycap(t, "n"), div().child("New run")], () => openGoal(), { size: "sm" }))));
  }

  // Before the first PR read: where pull requests will be, as grey bars.
  prSkeleton(t) {
    const bars = [[120, 72], [96, 110], [140, 60]];
    return [legHeader(t, "leg-prs-loading", "Pull requests", "…"), ...joined(t, bars.map(([a, b], i) => h_flex().id(`pr-skeleton-${i}`).min_h(38).py(4).pr(8).items_center()
      .child(div().w(LANE).flex_none())
      .child(v_flex().pl(8).gap(6)
        .child(div().w(a).h(8).rounded(4).bg(t.border))
        .child(div().w(b).h(8).rounded(4).bg(t.hover)))))];
  }

  nowGroups(t, entries, part) {
    const counts = this.nowCounts(entries), els = [];
    if (this.calm) els.push(...part("me", [this.calmBlock(t, this.calm)]));
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
    const lanes = this.treeLanes(v.worktrees), old = this.oldPRs(v), oldCount = old.length + this.staleShown().length, tidy = this.tidyTerminals();
    return { lanes, old, oldCount, tidy, count: lanes.safe.length + lanes.look.length + oldCount + tidy.count };
  }

  tidyTerminals() {
    const mine = new Set(agents().map((a) => a.address)), list = panes(), now = Date.now();
    return tidyRows(terminals().map((k) => terminalRow(k, { agents: mine, panes: list, now })).filter(Boolean), now);
  }

  // A terminal to tidy: its one action, and d twice to close it, as d removes a worktree here.
  tidyActions(r) {
    const armed = this.termArmed === r.address;
    const close = { id: `term-close-${r.address}`, key: "d", label: armed ? "Close it" : "Close", kind: armed ? "go" : "outline",
      tip: r.live ? "End it and what runs in it" : "Remove it", run: (cx) => this.closeTidy(r, cx) };
    const main = r.state === "failed" && r.canRestart ? { id: `term-restart-${r.address}`, key: "r", label: "Restart", run: () => restartTerminal(r), tip: "Run its command again" }
      : r.state === "old" ? close
        : { id: `term-open-${r.address}`, key: "o", label: r.background ? "Show" : "Open", run: () => openTerminal(r), tip: r.background ? "Give it a pane" : "Go to it" };
    return { main, actions: main === close ? [] : [close] };
  }

  closeTidy(r, cx) {
    if (this.termArmed !== r.address) this.termArmed = r.address;
    else {
      this.termArmed = null;
      endTerminal(r);
    }
    cx.notify();
  }

  closeFinishedTerminals(rows) {
    for (const r of rows) exec("hc", ["rm", r.address]);
  }

  tidyGroup(t, tidy) {
    if (!tidy.count) return [];
    const where = (r) => (r.space && r.space !== r.title ? `${r.title} · ${r.space}` : r.title);
    const one = (r, turn, reason) => this.item(t, `term-${r.address}`, { turn, title: where(r), reason, age: ago(r.at / 1000, true), tip: r.cwd, ...this.tidyActions(r) });
    const doneAll = { id: "term-close-finished", key: "d", label: `Close ${tidy.done.length}`, run: () => this.closeFinishedTerminals(tidy.done), tip: "Remove every finished terminal" };
    return [legHeader(t, "leg-terms", "Terminals to tidy", tidy.count), ...joined(t, [
      ...tidy.failed.map((r) => one(r, "stuck", `exited ${r.exit}`)),
      tidy.done.length ? this.item(t, "term-finished", { turn: "ready", title: `${tidy.done.length} finished`,
        reason: [...new Set(tidy.done.map((r) => r.title))].slice(0, 3).join(", "), main: doneAll }) : null,
      ...tidy.background.map((r) => one(r, "flight", "no pane")),
      ...tidy.old.map((r) => one(r, "old", "idle over a day")),
    ])];
  }

  tidyNav(tidy) {
    const nav = (r) => ({ id: `term-${r.address}`, section: "terms", go: (cx) => this.tidyActions(r).main.run(cx), keys: () => keysOf(this.tidyActions(r)) });
    const done = tidy.done.length ? [{ id: "term-finished", section: "terms", go: () => this.closeFinishedTerminals(tidy.done),
      keys: () => ({ d: () => this.closeFinishedTerminals(tidy.done) }) }] : [];
    return [...tidy.failed.map(nav), ...done, ...tidy.background.map(nav), ...tidy.old.map(nav)];
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
      ...part("terms", this.tidyGroup(t, m.tidy)),
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

  // Rows drawn by item() answer their table's keys here too, so a keycap never shows a key that does nothing.
  maintenanceNav(v, m = this.maintenanceModel(v)) {
    const t = theme(), prKeys = (pr, requested, done = false) => () => keysOf(this.prActions(t, pr, requested, done));
    const old = m.old.map(([pr, requested]) => ({ id: `pr-${pr.url}`, section: "old", go: () => this.runPR(pr), keys: prKeys(pr, requested) })), lanes = m.lanes;
    const trees = (key) => (key === "quiet" && !this.expanded["loose-recent"] ? [] : lanes[key])
      .map((w) => ({ id: `wt-${w.path}`, section: key, go: () => this.openTree(w) }));
    // Unfolded, what you marked addressed is selectable too, so its Undo can be reached.
    const done = !this.expanded["maintenance-done"] ? [] : [
      ...v.localDone.map((i) => ({ id: `in-${i.agent.address}`, go: () => openReview(i.top, i.agent.address), keys: () => keysOf(this.localActions(i, true)) })),
      ...v.requestedDone.map((pr) => ({ id: `pr-${pr.url}`, go: () => this.runPR(pr), keys: prKeys(pr, true, true) })),
      ...v.mineDone.map((pr) => ({ id: `pr-${pr.url}`, go: () => this.runPR(pr), keys: prKeys(pr, false, true) })),
      ...v.desktopDone.map((d) => ({ id: `dk-${d.id}`, go: () => openDesktop(d.id), keys: () => keysOf(this.desktopActions(d, true)) })),
      ...this.doneReviews().map((entry) => ({ id: entry.id, go: entry.go, keys: () => keysOf(this.reviewActions(entry, true)) })),
      ...Object.entries(this.landing()).filter(([, e]) => e.phase === "landed").map(([url, e]) => ({ id: `land-${url}`, go: () => exec("open", [url]), keys: () => keysOf(this.landActions(url, e)) })),
    ].map((item) => ({ ...item, section: "done" }));
    return [...trees("safe"), ...trees("look"), ...old, ...this.staleNav(), ...this.tidyNav(m.tidy), ...trees("quiet"), ...done];
  }
}
