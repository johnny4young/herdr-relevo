import { div } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea } from "gpui-base";
import { shared, setShared } from "herdr";
import { button, foldRow, legHeader, legend, joined, keyBar, keycap, laneGlyph, LANE, meTint, icon, spinner, chevron, onSubmitChord } from "./ui.js";
import { GOAL_MODE, GOAL_SCOPE, workflowCommand } from "./inbox-goals.js";
import { LANDING } from "./inbox-land.js";
import { openGoal } from "./goals-editor.js";
import { openWorkflow } from "./workflow-window.js";
import { savedSetups } from "./workflow-setups.js";
import { goalState } from "./lib/goals.js";
import { ago } from "./lib/time.js";
import { reviewableWork, linkedDecision, runProgress } from "./lib/goal-workflow.js";
import { acceptanceEffect } from "./lib/workflow-navigation.js";
import { attemptLabel } from "./lib/run-words.js";
import { RUN_GROUPS, TASK_GROUPS, runRow, runShipped, runSummary, taskTurn, taskReason, taskAt, stuckFindings, followUpAvailable, taskLegs,
  taskSummary, taskCaveats, isMerged } from "./lib/run-panel.js";

// Linked PR URLs known to have merged, kept after the landing list lets them go.
export const MERGED = "relevo.runs.merged";
const REST = "more-run-rest";
const WHY_LINES = 4, NOTE_LINES = 4;
const LEGEND = ["me", "flight", "ready"];
const line = (s, t, attention = false) => div().px(8).text_size(11).text_color(attention ? t.blocked : t.muted).child(s);
const labelled = (t, id, label, body, width = 56) => h_flex().id(id).gap(8).items_start().min_w(0)
  .child(div().w(width).flex_none().pt(1).text_size(11).text_color(t.dim).child(label)).child(body);

// Runs in the panel: the list of runs, one run's tasks, and one task with its decision. Mixed into Inbox.
export class RunViews {
  startRuns() {
    this.runChange = TextareaState.new({ value: "", placeholder: "What should change?" });
    this.runChange.on("change", (_e, cx) => cx.notify());
    onSubmitChord(this.runChange, (cx) => this.sendRunChanges(cx));
  }

  rememberMerged() {
    const linked = new Set([...(this.goalDoc?.goals ?? []).flatMap((goal) => goal.sources.filter((key) => key.startsWith("pr:")).map((key) => key.slice(3))),
      ...(this.workflowTasks ?? []).map((task) => task.worktree?.pr).filter(Boolean)]);
    const was = shared(MERGED) ?? {}, landing = shared(LANDING) ?? {};
    const now = Object.fromEntries([...linked].filter((url) => was[url] || isMerged(landing[url])).sort().map((url) => [url, true]));
    if (JSON.stringify(now) !== JSON.stringify(was)) setShared(MERGED, now);
  }

  runTasks(goal) {
    return this.workflowError ? [] : (this.workflowTasks ?? []).filter((task) => task.goalId === goal.id);
  }

  orderedTasks(goal, rest = Boolean(this.expanded[REST])) {
    const tasks = this.runTasks(goal);
    return [...TASK_GROUPS, ...(rest ? ["open", "done"] : [])].flatMap((turn) => tasks.filter((task) => taskTurn(task) === turn));
  }

  shownTask() {
    return this.runTask ? (this.workflowTasks ?? []).find((task) => task.id === this.runTask) ?? null : null;
  }

  runEntries() {
    const tasks = this.workflowTasks ?? [], merged = { ...shared(MERGED) };
    for (const [url, entry] of Object.entries(this.landing())) if (isMerged(entry)) merged[url] = true;
    return this.goalProjection.groups.map(({ goal, items }) => {
      const decision = Boolean(goal.decision?.trim()) && linkedDecision(goal, tasks, this.workflowError).state === "separate";
      return { goal, items, closed: goalState(goal) === "completed", shipped: runShipped(goal, tasks, items, merged),
        ...runRow(goal, tasks, { engine: this.workflowEngine, error: this.workflowError, decision, reviewCount: reviewableWork(items, this.clones).length }) };
    });
  }

  // The open run and task follow the data: one that is gone, or unreadable, closes its view.
  syncRun() {
    const scope = this.goalProjection.scope;
    this.runList = this.runEntries();
    const task = scope && !this.workflowError ? (this.workflowTasks ?? []).find((item) => item.id === this.runTask && item.goalId === scope.id) : null;
    if (!task) this.runTask = null;
    if (this.runChangeFor && this.runChangeFor !== this.runTask) this.runChangeFor = null;
    if (this.acceptIntent && (this.acceptIntent.id !== task?.id || this.acceptIntent.revision !== task.revision || task.state !== "needs_you")) this.acceptIntent = null;
  }

  runNav() {
    const scope = this.goalProjection.scope;
    if (this.runTask) return [];
    if (scope) return this.orderedTasks(scope).map((task) => ({ id: `task-${task.id}`, section: "goals", go: () => this.showTask(task.id) }));
    const closed = this.expanded["runs-closed"] ? this.runList.filter((entry) => entry.closed) : [];
    return [...this.openRuns(), ...closed].map((entry) => ({ id: `goal-${entry.goal.id}`, section: "goals", go: () => this.enterRun(entry.goal) }));
  }

  // The runs still open, in the order their groups are drawn.
  openRuns() {
    const open = this.runList.filter((entry) => !entry.closed);
    return RUN_GROUPS.flatMap(([group]) => open.filter((entry) => entry.group === group));
  }

  // A run opens in the panel; its first task, or the one asked for, is selected.
  enterRun(goal, taskId = null) {
    setShared(GOAL_SCOPE, goal.id);
    this.runTask = null; this.runNotice = null; this.runError = null;
    const first = taskId ?? this.orderedTasks(goal, false)[0]?.id;
    this.sel = first ? `task-${first}` : null;
  }

  openRun(goal, cx, taskId = null) {
    this.enterRun(goal, taskId);
    this.h.focus(); cx.notify();
  }

  leaveRun() {
    const id = shared(GOAL_SCOPE);
    setShared(GOAL_SCOPE, null);
    this.runTask = null; this.runNotice = null; this.runError = null;
    this.sel = id ? `goal-${id}` : null;
  }

  showTask(id) {
    this.runTask = id; this.acceptIntent = null; this.runError = null; this.runNotice = null;
  }

  // From Reviews: the result opens as its task in Runs.
  showResult(task) {
    setShared(GOAL_MODE, true); setShared(GOAL_SCOPE, task.goalId);
    this.showTask(task.id); this.sel = null;
    this.h.focus();
  }

  leaveTask() {
    this.sel = this.runTask ? `task-${this.runTask}` : null;
    this.runTask = null; this.runChangeFor = null; this.acceptIntent = null;
  }

  // Same guard and command as the run window: only the revision on screen, only while it still waits.
  decideRun(task, outcome, cx, text = "") {
    const current = (this.workflowTasks ?? []).find((item) => item.id === task.id);
    if (this.runBusy || this.workflowError || !current || current.revision !== task.revision || current.state !== "needs_you") return;
    if (outcome === "changes" && !text.trim()) return;
    this.acceptIntent = null; this.runBusy = true; this.runError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const response = await workflowCommand({ action: "decide", taskId: task.id, outcome, text, revision: task.revision ?? "" });
        if (Array.isArray(response.doc?.tasks)) { this.workflowTasks = response.doc.tasks; this.workflowEngine = response.doc.engine ?? this.workflowEngine; }
        this.runChange.set_value(""); this.runChangeFor = null;
        const kept = outcome === "accept" && Boolean(task.worktree);
        this.runNotice = outcome !== "accept" ? "Feedback saved. The next result will return for your review."
          : kept ? "Accepted and committed to its run branch. More offers the draft pull request." : "Acceptance saved.";
        if (!kept && this.runTask === task.id) {
          this.runTask = null;
          const next = this.orderedTasks({ id: task.goalId }, false).find((item) => item.id !== task.id);
          this.sel = next ? `task-${next.id}` : null;
        }
      } catch (e) { this.runError = `Action needs attention: ${e.message ?? e}`; }
      this.runBusy = false;
      this.loadGoals(cx);
      this.h.focus(); cx.notify();
    });
  }

  // A, or a click, arms the acceptance of the revision on screen; only Enter, or a second click, confirms it.
  acceptStep(task, cx, confirm = true) {
    if (this.runBusy || task.state !== "needs_you") return;
    const armed = this.acceptIntent?.id === task.id && this.acceptIntent.revision === task.revision;
    if (armed && confirm) return this.decideRun(task, "accept", cx);
    this.acceptIntent = { id: task.id, revision: task.revision };
    cx.notify();
  }

  askRunChanges(task, cx) {
    this.runChangeFor = task.id; this.acceptIntent = null;
    cx.notify();
    cx.timer.after(30, () => { if (this.runChangeFor === task.id) this.runChange.focus(); });
  }

  cancelRunChanges() {
    this.runChangeFor = null;
    this.h.focus();
  }

  // With no attempts left the words go to a new task, prepared in the run window for the person to start.
  sendRunChanges(cx) {
    const task = this.shownTask(), text = this.runChange.value().trim();
    if (!task || task.id !== this.runChangeFor || task.state !== "needs_you" || this.runBusy || !text) return;
    if (task.round >= task.maxRounds) {
      openWorkflow(task.goalId, task.id, { followUp: "changes", text });
      this.runChange.set_value(""); this.runChangeFor = null;
      cx.notify();
    } else this.decideRun(task, "changes", cx, text);
  }

  seeDiff(task) { openWorkflow(task.goalId, task.id, { tab: "Changes" }); }

  // Keys of the open run or task; true when the key was theirs.
  runKey(e, cx) {
    const scope = this.goalProjection?.scope, task = this.shownTask();
    if (task) {
      if (e.key === "?") return false;
      const waiting = task.state === "needs_you" && !this.runBusy;
      if (e.key === "escape") {
        if (this.acceptIntent) this.acceptIntent = null;
        else this.leaveTask();
      } else if (waiting && e.key === "a") this.acceptStep(task, cx, false);
      else if (waiting && e.key === "enter" && this.acceptIntent) this.acceptStep(task, cx);
      else {
        this.acceptIntent = null;
        if (waiting && e.key === "r") this.askRunChanges(task, cx);
        else if (e.key === "d") this.seeDiff(task);
      }
      return true;
    }
    if (e.key === "n") { openGoal(); return true; }
    if (!scope) return false;
    if (e.key === "escape" || e.key === "f") this.leaveRun();
    else if (e.key === "w") openWorkflow(scope.id);
    else if (e.key === "e") openGoal(scope.id);
    else return ["g", "r", "s"].includes(e.key);
    return true;
  }

  runAction(t, entry, id) {
    const { goal, action } = entry;
    const act = { review: (cx) => this.openRun(goal, cx), why: (cx) => this.openRun(goal, cx, action.taskId), open: (cx) => this.openRun(goal, cx),
      decide: () => openGoal(goal.id, null, "decision"), changes: () => this.showRunReviews(goal), plan: () => openWorkflow(goal.id) }[action.kind];
    return button(t, id, action.label, act, { kind: ["review", "why", "decide"].includes(action.kind) ? "go" : "outline" });
  }

  runTools(t, goal) {
    return [
      button(t, `goal-edit-${goal.id}`, "Edit", () => openGoal(goal.id), { kind: "ghost", size: "sm", tip: "E" }),
      ...(goalState(goal) !== "completed" ? [button(t, `goal-close-${goal.id}`, "Close", (cx) => { this.confirmClose = goal.id; cx.notify(); },
        { kind: "ghost", size: "sm", disabled: Boolean(this.closingRun), tip: "Cancel open tasks and close this run" })] : []),
      button(t, `goal-window-${goal.id}`, "Plan", () => openWorkflow(goal.id), { kind: "ghost", size: "sm", tip: "W · plan or add tasks in the run window" }),
    ];
  }

  // What the header shows for the list, a run or a task: [left, right].
  runsHeader(t) {
    const scope = this.goalProjection.scope, task = this.shownTask();
    const title = (id, words) => div().id(id).flex_1().min_w(0).truncate().text_size(13).font_semibold().tooltip(words).child(words);
    const back = (id, label, leave) => button(t, id, `‹ ${label}`, (cx) => { leave(); this.h.focus(); cx.notify(); }, { kind: "ghost", size: "sm", tip: "Esc" });
    if (task) return [[back("task-back", "Tasks", () => this.leaveTask()), title("task-title", task.title)], []];
    if (scope) return [[back("runs-back", "Runs", () => this.leaveRun()), title("run-title", scope.title)], this.runTools(t, scope)];
    return [[div().id("runs-title").pl(8).flex_none().text_size(13).font_semibold().child("Runs"),
      div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(this.narrowInbox ? "" : "a run is a goal you gave your agents")],
    [button(t, "goal-new", [keycap(t, "n"), "New run"], () => openGoal(), { size: "sm", tip: "Write a prompt, choose agents, then start when ready" })]];
  }

  runsLegend(t) {
    const open = this.runList.filter((entry) => !entry.closed);
    return legend(t, "runs-legend", LEGEND.map((turn) => ({ turn, n: open.filter((entry) => entry.group === turn).length })));
  }

  runsKeys(t) {
    const help = [["?"], "all keys"], task = this.shownTask();
    if (task) return keyBar(t, "runs-keys", [...(task.state === "needs_you" ? [[["a", "enter"], "accept"], [["r"], "ask for changes"]] : []), [["d"], "diff"], [["esc"], "tasks"]], help);
    if (this.goalProjection.scope) return keyBar(t, "runs-keys", [[["j", "k"], "move"], [["enter"], "open the task"], [["esc"], "runs"]], help);
    return keyBar(t, "runs-keys", [[["j", "k"], "move"], [["enter"], "open the run"], [["n"], "new run"]], help);
  }

  runsBody(t) {
    const scope = this.goalProjection.scope, entry = scope && this.runList.find((item) => item.goal.id === scope.id), task = this.shownTask();
    const errors = [this.goalsError ? line(this.goalsError, t, true) : null, this.runCloseError ? line(this.runCloseError, t, true) : null,
      this.runError ? line(this.runError, t, true).id("run-error").role("alert") : null,
      this.runNotice ? line(this.runNotice, t).id("run-notice").role("status") : null].filter(Boolean);
    if (entry && task) return [...errors, ...this.taskDetail(t, entry.goal, task)];
    if (entry) return [...errors, ...this.runView(t, entry)];
    return [...errors, ...this.runsGlance(t)];
  }

  runsGlance(t) {
    const open = this.openRuns(), closed = this.runList.filter((entry) => entry.closed), setups = savedSetups().length;
    const seen = (entry) => !this.hiddenIds.has(`goal-${entry.goal.id}`), draw = (entry) => this.runCard(t, entry);
    const target = this.runList.find((entry) => `goal-${entry.goal.id}` === this.sel) ?? open[0];
    return [
      ...RUN_GROUPS.flatMap(([group, label]) => {
        const list = open.filter((entry) => entry.group === group), shown = list.filter(seen);
        return shown.length ? [legHeader(t, `runs-leg-${group}`, label, list.length, { me: group === "me" }), ...joined(t, shown.map(draw))] : [];
      }),
      ...(!this.runList.length ? [line("No runs yet", t)] : []),
      ...(closed.length ? [foldRow(this, t, "runs-closed-fold", "runs-closed", `${closed.length} older finished ${closed.length === 1 ? "run" : "runs"}`, { gap: true })] : []),
      ...(this.expanded["runs-closed"] ? joined(t, closed.filter(seen).map(draw)) : []),
      ...(setups ? [h_flex().id("runs-setups").min_h(28).pl(LANE).pr(8).gap(5).items_center().text_size(11).text_color(t.dim)
        .child(chevron(false)).child(div().flex_1().child(`Saved setups · ${setups}`))
        .child(button(t, "runs-setups-show", "Show", () => (target ? openWorkflow(target.goal.id, null, { setups: true }) : openGoal()),
          { size: "sm", tip: "Opens the saved setups in the run window; nothing starts" }))] : []),
    ];
  }

  // A run answers three questions: what it is, what it does or wants now, and what it shipped.
  runCard(t, entry) {
    const { goal, shipped, hot } = entry, id = `goal-${goal.id}`, sel = this.selected(id);
    const answer = (key, label, value, tone) => labelled(t, `${key}-${goal.id}`, label,
      div().flex_1().min_w(0).truncate().text_size(13).text_color(tone).tooltip(value).child(value));
    return v_flex().id(id).flex_none().rounded(6).border_1().border_color(sel ? t.accent : `${t.accent}00`)
      .when(sel, (el) => el.bg(t.selected)).when(!sel && Boolean(hot), (el) => el.bg(meTint(t)))
      .cursor_pointer().on_click((_e, cx) => this.openRun(goal, cx))
      .child(h_flex().py(6).pr(8).gap(8).items_center()
        .child(h_flex().w(LANE).flex_none().justify_center().child(laneGlyph(t, entry.turn)))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().min_w(0).truncate().text_size(13).font_semibold().tooltip(goal.title).child(goal.title))
          .child(answer("goal-now", "Now", entry.now, hot ? t.blocked : t.foreground))
          .child(answer("goal-shipped", "Shipped", shipped.text, shipped.any ? t.foreground : t.muted)))
        .when(entry.group !== "flight" || sel, (el) => el.child(this.runAction(t, entry, `goal-action-${goal.id}`))))
      .when(sel, (el) => el.child(v_flex().pl(LANE + 8).pr(8).pb(8).gap(5)
        .child(h_flex().gap(5).children(this.runTools(t, goal)))
        .when(this.confirmClose === goal.id, (below) => below.child(this.closeConfirm(t, goal)))));
  }

  runView(t, entry) {
    const { goal } = entry, tasks = this.runTasks(goal), summary = runSummary(tasks), outside = this.goalProjection.outsideBlockers;
    const progress = runProgress(goal.id, tasks, this.workflowEngine, this.workflowError);
    const rest = this.orderedTasks(goal, true).filter((task) => !TASK_GROUPS.includes(taskTurn(task)));
    const notStarted = rest.filter((task) => taskTurn(task) === "open").length;
    const rows = (list) => joined(t, list.map((task) => this.taskRow(t, goal, task)));
    const group = (turn, label) => {
      const list = tasks.filter((task) => taskTurn(task) === turn), shown = rows(list);
      return shown.length ? [legHeader(t, `run-leg-${turn}`, label, list.length, { me: turn !== "flight" }), ...shown] : [];
    };
    return [
      ...(this.confirmClose === goal.id ? [div().px(8).child(this.closeConfirm(t, goal))] : []),
      ...(outside > 0 ? [line(`${outside} need attention elsewhere`, t, true)] : []),
      tasks.length ? h_flex().id("run-summary").flex_wrap().px(8).pb(4).gap(5).text_size(11).text_color(t.muted)
        .child(div().child(summary.head))
        .children(summary.parts.map((part, i) => div().when(part.hot, (el) => el.font_semibold().text_color(t.blocked)).child(i ? `· ${part.text}` : part.text)))
        : h_flex().id("run-summary").px(8).pb(4).gap(8).items_center()
          .child(div().flex_1().min_w(0).text_size(13).text_color(entry.hot ? t.blocked : t.muted).child(entry.now))
          .when(entry.action.kind !== "open", (el) => el.child(this.runAction(t, entry, `run-action-${goal.id}`))),
      ...(this.workflowError ? [line(this.workflowError, t, true)] : []),
      ...(progress && tasks.length ? [line(progress, t).id(`goal-progress-${goal.id}`)] : []),
      ...group("me", "Needs me"), ...group("stuck", "Stuck"), ...group("flight", "In flight"),
      ...(rest.length ? [foldRow(this, t, "run-rest-fold", REST, `${notStarted} not started · ${rest.length - notStarted} done`, { gap: true })] : []),
      ...(this.expanded[REST] ? rows(rest) : []),
    ];
  }

  taskRow(t, goal, task) {
    const turn = taskTurn(task), id = `task-${task.id}`, at = taskAt(task);
    const open = (cx) => { this.showTask(task.id); this.h.focus(); cx.notify(); };
    const main = turn === "me" ? button(t, `task-review-${task.id}`, "Review", open, { kind: "go" })
      : turn === "stuck" ? button(t, `task-why-${task.id}`, "See why", (cx) => { this.sel = id; this.clicked = true; this.h.focus(); cx.notify(); }) : null;
    return this.item(t, id, {
      turn: turn === "done" ? (task.state === "accepted" ? "ready" : "old") : turn, kind: "relay", title: task.title, reason: taskReason(task),
      age: at ? ago(at, true) : null, tip: task.title, main,
      lines: turn === "stuck" ? () => this.stuckLines(t, goal, task) : [],
      actions: turn === "me" ? [] : [button(t, `task-open-${task.id}`, "Open", open, { tip: "Who did what on this task" })],
    });
  }

  // Why a task is stuck, in the reviewer's words, and the one way on.
  stuckLines(t, goal, task) {
    const findings = stuckFindings(task), more = findings.length - WHY_LINES;
    const next = followUpAvailable(task)
      ? button(t, `task-follow-up-${task.id}`, "Prepare a follow-up", () => openWorkflow(goal.id, task.id, { followUp: "blocked" }),
        { tip: "Opens a new task with the findings in the run window; nothing is sent until you start it" })
      : button(t, `task-retry-${task.id}`, "Retry in the run window", () => openWorkflow(goal.id, task.id), { tip: "It still has attempts left" });
    return [
      labelled(t, `task-why-text-${task.id}`, "Why", v_flex().flex_1().min_w(0).gap(2)
        .children(findings.slice(0, WHY_LINES).map((words) => div().min_w(0).text_size(13).child(words)))
        .when(more > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(`+${more} more in the run window`))), 40),
      labelled(t, `task-next-${task.id}`, "Next", h_flex().gap(5).child(next), 40),
    ];
  }

  legRow(t, leg) {
    const mine = leg.state === "you", at = Date.parse(leg.at ?? "");
    const glyph = leg.state === "ok" ? icon("check", t.done) : leg.state === "bad" ? icon("x", t.blocked) : leg.state === "run" ? spinner(t.working, 12)
      : mine ? laneGlyph(t, "me") : div().size(8).flex_none().rounded_full().border_1().border_color(t.dim);
    const when = leg.now ? "now" : Number.isFinite(at) ? ago(at / 1000, true) : null;
    return h_flex().id(`task-leg-${leg.id}`).min_h(28).pr(8).gap(8).items_center().rounded(6).when(mine, (el) => el.bg(meTint(t)))
      .child(h_flex().w(LANE).flex_none().justify_center().child(glyph))
      .child(div().w(110).flex_none().truncate().text_size(13).font_semibold().when(mine, (el) => el.text_color(t.blocked)).child(leg.who))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.muted).tooltip(leg.what).child(leg.what))
      .when(Boolean(when), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(when)));
  }

  // A task: the writer's summary, who did what, then the decision.
  taskDetail(t, goal, task) {
    const tasks = this.runTasks(goal), waiting = task.state === "needs_you", summary = taskSummary(task);
    const notes = waiting ? taskCaveats(task) : [], linked = linkedDecision(goal, tasks).task?.id === task.id;
    return [
      ...(summary ? [div().id("task-summary").px(8).pb(4).text_size(13).child(summary)] : []),
      v_flex().id("task-legs").children(joined(t, taskLegs(task).map((leg) => this.legRow(t, leg)))),
      ...(notes.length ? [v_flex().id("task-notes").px(8).pt(6).gap(2)
        .child(div().text_size(11).text_color(t.dim).child("Before you accept"))
        .children(notes.slice(0, NOTE_LINES).map((note) => div().min_w(0).text_size(11).text_color(t.muted).child(note)))
        .when(notes.length > NOTE_LINES, (el) => el.child(div().text_size(11).text_color(t.dim).child(`+${notes.length - NOTE_LINES} more in More`)))] : []),
      ...(linked ? [line(`Also resolves: ${goal.decision}`, t)] : []),
      this.taskDecision(t, goal, task, tasks),
    ];
  }

  taskDecision(t, goal, task, tasks) {
    const waiting = task.state === "needs_you", editing = waiting && this.runChangeFor === task.id, spent = task.round >= task.maxRounds;
    const confirming = this.acceptIntent?.id === task.id && this.acceptIntent.revision === task.revision;
    const keyed = (cap, label) => [keycap(t, cap), label];
    const more = button(t, "task-more", "More", () => openWorkflow(goal.id, task.id), { kind: "ghost", tip: "Full report, evidence and activity in the run window" });
    const diff = button(t, "task-diff", keyed("d", "See the diff"), () => this.seeDiff(task), { kind: "ghost", tip: "Opens the run window on this task's result and diff" });
    if (editing) return v_flex().id("task-decision").px(8).pt(8).gap(6)
      .child(Textarea.new(this.runChange).id("task-changes-field").w_full().min_w(0).accessibility_label("What should change?")
        .h(64).px(7).rounded(5).border(1).border_color(t.border).bg(t.background))
      .child(div().text_size(11).text_color(t.muted).child(spent ? "No attempts left: this prepares a follow-up task for you to start."
        : `Starts ${attemptLabel((task.round ?? 0) + 1, task.maxRounds)}: write, then review.`))
      .child(h_flex().gap(6)
        .child(button(t, "task-send-changes", spent ? "Prepare follow-up" : "Send feedback", (cx) => this.sendRunChanges(cx),
          { kind: "solid", disabled: Boolean(this.runBusy) || !this.runChange.value().trim(), tip: "⌘Enter" }))
        .child(button(t, "task-changes-cancel", "Cancel", (cx) => { this.cancelRunChanges(); cx.notify(); }, { kind: "ghost", disabled: Boolean(this.runBusy) })));
    const effect = `${task.worktree ? "Accepting keeps the worktree and commits to its run branch; More offers the draft pull request. " : ""}${acceptanceEffect(task, tasks, this.workflowEngine)}`;
    return v_flex().id("task-decision").px(8).pt(8).gap(6)
      .child(h_flex().flex_wrap().gap(6).items_center()
        .when(waiting, (bar) => bar
          .child(button(t, "task-accept", confirming ? keyed("enter", "Confirm accept") : keyed("a", "Accept"), (cx) => this.acceptStep(task, cx),
            { kind: "accent", disabled: Boolean(this.runBusy), tip: "A, then Enter" }))
          .child(button(t, "task-changes", keyed("r", "Ask for changes"), (cx) => this.askRunChanges(task, cx), { disabled: Boolean(this.runBusy) })))
        .when(followUpAvailable(task), (bar) => bar.child(button(t, "task-follow-up", "Prepare a follow-up",
          () => openWorkflow(goal.id, task.id, { followUp: "blocked" }), { tip: "Opens a new task with the findings in the run window" })))
        .child(diff).child(div().flex_1()).child(more))
      .when(waiting, (el) => el.child(div().id("task-effect").min_w(0).text_size(11).text_color(t.muted).child(effect)));
  }
}
