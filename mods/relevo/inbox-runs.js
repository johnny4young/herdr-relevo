import { div } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea } from "gpui-base";
import { exec, notify, shared, setShared } from "herdr";
import { button, foldRow, legHeader, legend, joined, keyBar, keycap, meTint, plusMinus, row, onSubmitChord } from "./ui.js";
import { openReview } from "./review.js";
import { RUN_LAUNCH, answerTrust } from "./run-launch.js";
import { GOAL_MODE, GOAL_SCOPE, workflowCommand } from "./inbox-goals.js";
import { openGoal } from "./goals-editor.js";
import { openWorkflow, RUN_FOLLOW_UP } from "./workflow-window.js";
import { goalState } from "./lib/goals.js";
import { ago } from "./lib/time.js";
import { reviewableWork, linkedDecision, runProgress } from "./lib/goal-workflow.js";
import { acceptanceEffect, decideGuard, decidePayload, armAccept, acceptArmed, draftOnAccept } from "./lib/workflow-navigation.js";
import * as config from "./config.js";
import { deepReviewNotice, fixFindings, postDraftReview } from "./deep-review.js";
import { deepReviewView } from "./deep-review-view.js";
import { deepReviewDone, mergedFindings } from "./lib/deep-review.js";
import { RUN_GROUPS, TASK_GROUPS, bucketTasks, emptyBucket, changesPlan, runRow, runShipped, runSummary, taskTurn, taskReason, taskAt, stuckFindings, followUpAvailable, taskLegs,
  taskSummary, taskCaveats, isMerged } from "./lib/run-panel.js";
import { canCompare, diffFiles, tookWords } from "./lib/run-compare.js";

// Linked PR URLs known to have merged, kept after the landing list lets them go.
export const MERGED = "relevo.runs.merged";
const REST = "more-run-rest";
const WHY_LINES = 4, NOTE_LINES = 4, FILE_LINES = 8;
const LAUNCH_SHOWN_MS = 300000;
const LEGEND = ["me", "flight", "ready"];
// What a step of a task is, as the lane glyph of its row.
const LEG_TURN = { ok: "ready", bad: "stuck", run: "flight", you: "me" };
const line = (s, t, attention = false) => div().px(8).text_size(11).text_color(attention ? t.blocked : t.muted).child(s);
const labelled = (t, id, label, body, width = 56) => h_flex().id(id).gap(8).items_start().min_w(0)
  .child(div().w(width).flex_none().pt(1).text_size(11).text_color(t.dim).child(label)).child(body);

// Runs in the panel: the list of runs, one run's tasks, and one task with its decision. Mixed into Inbox.
export class RunViews {
  startRuns() {
    this.runChange = TextareaState.new({ value: "", placeholder: "What should change?" });
    this.runChange.on("change", (_e, cx) => cx.notify());
    onSubmitChord(this.runChange, (cx) => this.sendRunChanges(cx));
    this.runPicked = [];
  }

  // URLs known to have merged: the remembered ones and what the landing list shows now.
  mergedUrls() {
    const merged = { ...shared(MERGED) };
    for (const [url, entry] of Object.entries(this.landing())) if (isMerged(entry)) merged[url] = true;
    return merged;
  }

  rememberMerged() {
    const linked = new Set([...(this.goalDoc?.goals ?? []).flatMap((goal) => goal.sources.filter((key) => key.startsWith("pr:")).map((key) => key.slice(3))),
      ...(this.workflowTasks ?? []).map((task) => task.worktree?.pr).filter(Boolean)]);
    const merged = this.mergedUrls(), now = Object.fromEntries([...linked].filter((url) => merged[url]).sort().map((url) => [url, true]));
    if (JSON.stringify(now) !== JSON.stringify(shared(MERGED) ?? {})) setShared(MERGED, now);
  }

  // A run's tasks by turn, grouped once per task list; an unreadable state shows none.
  runBucket(goal, stale = false) {
    if (!this.buckets || this.bucketsOf !== this.workflowTasks) {
      this.bucketsOf = this.workflowTasks;
      this.buckets = bucketTasks(this.workflowTasks ?? []);
    }
    return (this.workflowError && !stale ? null : this.buckets.get(goal.id)) ?? emptyBucket();
  }

  orderedTasks(goal, rest = Boolean(this.expanded[REST])) {
    const bucket = this.runBucket(goal);
    return [...TASK_GROUPS, ...(rest ? ["open", "done"] : [])].flatMap((turn) => bucket[turn]);
  }

  shownTask() {
    return this.runTask ? (this.workflowTasks ?? []).find((task) => task.id === this.runTask) ?? null : null;
  }

  runEntries() {
    const merged = this.mergedUrls();
    return this.goalProjection.groups.map(({ goal, items }) => {
      const bucket = this.runBucket(goal);
      const decision = Boolean(goal.decision?.trim()) && linkedDecision(goal, bucket.all, this.workflowError).state === "separate";
      return { goal, items, closed: goalState(goal) === "completed", shipped: runShipped(goal, this.runBucket(goal, true), items, merged),
        ...runRow(goal, bucket, { engine: this.workflowEngine, error: this.workflowError, decision, reviewCount: reviewableWork(items, this.clones).length, launch: this.liveLaunch() }) };
    });
  }

  // A launch the run window left behind (Herdr quit mid-start) stops showing once its wait would have timed out.
  liveLaunch() {
    const launch = shared(RUN_LAUNCH);
    return launch && Date.now() - (launch.at ?? 0) < LAUNCH_SHOWN_MS ? launch : null;
  }

  // The open run and task follow the data: one that is gone, or unreadable, closes its view. Returns the runs to draw.
  syncRun(cx) {
    const scope = this.goalProjection.scope, all = scope ? this.runBucket(scope).all : [];
    const task = all.find((item) => item.id === this.runTask);
    if (!task) this.runTask = null;
    const compared = all.find((item) => item.id === this.runCompare);
    if (this.runCompare && !(compared && canCompare(compared))) this.closeCompare();
    if (this.runPicked.length) this.runPicked = this.runPicked.filter((id) => all.some((item) => item.id === id && item.state === "needs_you"));
    if (scope) this.loadRunUsage(cx);
    if (task) this.loadTaskDiff(task, cx);
    if (this.runChangeFor && this.runChangeFor !== this.runTask) this.runChangeFor = null;
    if (this.acceptIntent && (task?.state !== "needs_you" || !acceptArmed(this.acceptIntent, task))) this.acceptIntent = null;
    // A notice or an error belongs to the run and task it was said on, however the view moved on.
    if (this.runPlace() !== this.runAt) { this.runNotice = null; this.runError = null; this.runAt = this.runPlace(); }
    return this.runEntries();
  }

  runPlace() { return `${shared(GOAL_SCOPE) ?? ""}\0${this.runTask ?? ""}`; }

  // What every level change clears; `task` is the one to show, if any.
  resetRun(task = null) {
    this.runTask = task; this.runChangeFor = null; this.acceptIntent = null;
    this.runPicked = []; this.closeCompare();
  }

  // The words sent as a follow-up stay typed until the run window has taken them.
  followUpTaken(cx) {
    if (!this.runFollowUp || shared(RUN_FOLLOW_UP) === this.runFollowUp) return;
    this.runFollowUp = null;
    cx.spawn(async (cx) => {
      this.runChange.set_value(""); this.runChangeFor = null; this.runNotice = "The follow-up is ready in the run window.";
      cx.notify();
    });
  }

  runNav(runs) {
    const scope = this.goalProjection.scope;
    if (this.runTask || this.runCompare) return [];
    if (scope) return this.orderedTasks(scope).map((task) => ({ id: `task-${task.id}`, section: "goals", go: () => this.resetRun(task.id) }));
    const closed = this.expanded["runs-closed"] ? runs.filter((entry) => entry.closed) : [];
    return [...this.openRuns(runs), ...closed].map((entry) => ({ id: `goal-${entry.goal.id}`, section: "goals", go: () => this.enterRun(entry.goal) }));
  }

  // The runs still open, in the order their groups are drawn.
  openRuns(runs) {
    return RUN_GROUPS.flatMap(([group]) => runs.filter((entry) => !entry.closed && entry.group === group));
  }

  // A run opens in the panel; its first task, or the one asked for, is selected.
  enterRun(goal, taskId = null) {
    setShared(GOAL_SCOPE, goal.id);
    this.resetRun();
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
    this.resetRun();
    this.sel = id ? `goal-${id}` : null;
  }

  // From Reviews: the result opens as its task in Runs.
  showResult(task) {
    setShared(GOAL_MODE, true); setShared(GOAL_SCOPE, task.goalId);
    this.resetRun(task.id); this.sel = null;
    this.h.focus();
  }

  leaveTask() {
    this.sel = this.runTask ? `task-${this.runTask}` : null;
    this.resetRun();
  }

  // A command's answer carries the new state; keep it so the panel doesn't wait for the next read.
  takeDoc(response) {
    if (!Array.isArray(response.doc?.tasks)) return;
    this.workflowTasks = response.doc.tasks;
    this.workflowEngine = response.doc.engine ?? this.workflowEngine;
  }

  // The run window's guard and command: only the revision on screen, only while it still waits.
  decideRun(task, outcome, cx, text = "") {
    if (this.runBusy || this.workflowError || !decideGuard(task, this.workflowTasks)) return;
    if (outcome === "changes" && !text.trim()) return;
    this.acceptIntent = null; this.runBusy = true; this.runError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const response = await workflowCommand(decidePayload(task, outcome, text, { draft: config.RUN_DRAFT_PR !== false }));
        this.takeDoc(response);
        this.runChange.set_value(""); this.runChangeFor = null;
        const kept = outcome === "accept" && Boolean(task.worktree);
        this.runNotice = outcome !== "accept" ? "Feedback saved. The next result will return for your review."
          : !kept ? "Acceptance saved."
          : task.worktree.prHead ? `Accepted and committed. Push to ${task.worktree.prHead} adds it to the pull request.`
          : response.result?.pr ? `Accepted, and the draft pull request is open: ${response.result.pr}`
          : response.result?.prError ? `Accepted and committed; the draft pull request didn't open: ${response.result.prError}` : "Accepted and committed to its run branch.";
        if (!kept && this.runTask === task.id) {
          this.runTask = null; this.runAt = this.runPlace();
          const next = this.orderedTasks({ id: task.goalId }, false).find((item) => item.id !== task.id);
          this.sel = next ? `task-${next.id}` : null;
        }
      } catch (e) { this.runError = `Action needs attention: ${e.message ?? e}`; }
      this.runBusy = false;
      this.loadGoals(cx);
      this.h.focus(); cx.notify();
    });
  }

  // The accepted commit onto the pull request the run fixes; refused, not forced, when that branch moved.
  pushRun(task, cx) {
    if (this.runBusy) return;
    this.runBusy = true; this.runError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.takeDoc(await workflowCommand({ action: "worktree-push", taskId: task.id }));
        this.runNotice = `Pushed to ${task.worktree.prHead}. The pull request's checks run again on GitHub.`;
      } catch (e) { this.runError = `Not pushed: ${e.message ?? e}`; }
      this.runBusy = false; cx.notify();
    });
  }

  // A, or a click, arms the acceptance of the revision on screen; only Enter, or a second click, confirms it.
  acceptStep(task, cx, confirm = true) {
    if (this.runBusy || task.state !== "needs_you") return;
    if (confirm && acceptArmed(this.acceptIntent, task)) return this.decideRun(task, "accept", cx);
    this.acceptIntent = armAccept(task);
    cx.notify();
  }

  askRunChanges(task, cx) {
    if (task.pr) return;
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
    if (changesPlan(task).spent) {
      this.runFollowUp = openWorkflow(task.goalId, task.id, { followUp: "changes", text });
      setShared(RUN_FOLLOW_UP, this.runFollowUp);
      this.runNotice = "Sent to the run window."; this.runError = null;
      cx.notify();
    } else this.decideRun(task, "changes", cx, text);
  }

  // The files a worktree run changed, read once per change it keeps: the accepted commit, the reviewed tree or a snapshot.
  loadTaskDiff(task, cx) {
    const wt = task.worktree, kept = wt && (wt.commit ?? wt.reviewedTree ?? [...task.attempts].reverse().find((a) => a.snapshot?.commit)?.snapshot.commit);
    const key = kept ? `${task.id}:${kept}` : null;
    if (!key || this.taskDiff?.key === key) return;
    this.taskDiff = { key, taskId: task.id, loading: true };
    cx.spawn(async (cx) => {
      let next;
      try { next = { key, taskId: task.id, result: (await workflowCommand({ action: "task-diff", taskId: task.id })).result }; }
      catch (e) { next = { key, taskId: task.id, error: String(e.message ?? e) }; }
      if (this.taskDiff?.key === key) this.taskDiff = next;
      cx.notify();
    });
  }

  // The run's change in the review pane beside the panel, on `file` when given; a run without one opens its window.
  seeDiff(task, file = null) {
    const d = this.taskDiff?.taskId === task.id ? this.taskDiff.result : null;
    if (!d) return openWorkflow(task.goalId, task.id, { tab: "Changes" });
    openReview(d.root, null, null, null, { from: d.fromCommit, to: d.toCommit, label: `${task.title} · ${task.state === "accepted" ? "as accepted" : "as reviewed"}`, ...(file ? { file } : {}) });
  }

  // The change itself, each file with its lines; a click opens that file in the diff.
  taskFiles(t, task) {
    const d = this.taskDiff?.taskId === task.id ? this.taskDiff : null;
    if (!d) return [];
    if (d.loading) return [line("Reading the change…", t)];
    if (d.error) return [line(d.error, t)];
    const files = diffFiles(d.result), shown = files.list.slice(0, FILE_LINES), more = files.more + files.list.length - shown.length;
    return [v_flex().id("task-files").px(8).pt(6).gap(2)
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.muted).child(div().child(files.head)).children(plusMinus(t, files.added, files.removed)))
      .children(shown.map((file, i) => h_flex().id(`task-file-${i}`).gap(6).items_center().cursor_pointer().rounded(4).hover((s) => s.bg(t.hover))
        .on_click(() => this.seeDiff(task, file.path))
        .child(div().flex_1().min_w(0).truncate().text_size(13).tooltip(file.path).child(file.path))
        .children(file.binary ? [div().flex_none().text_size(11).text_color(t.dim).child("binary")] : plusMinus(t, file.added, file.removed))))
      .when(more > 0, (el) => el.child(div().id("task-files-more").text_size(11).text_color(t.dim).child(`+${more} more in the diff`)))];
  }

  // Keys of the open run or task; true when the key was theirs.
  runKey(e, cx) {
    const scope = this.goalProjection?.scope, task = this.shownTask();
    if (this.runCompare) {
      if (e.key === "?") return false;
      if (e.key === "escape") this.leaveCompare();
      return e.key !== "tab";
    }
    if (task) {
      if (e.key === "?") return false;
      const waiting = task.state === "needs_you" && !this.runBusy;
      if (e.key === "escape") {
        if (this.acceptIntent) this.acceptIntent = null;
        else this.leaveTask();
      } else if (waiting && e.key === "a") this.acceptStep(task, cx, false);
      else if (waiting && e.key === "enter" && this.acceptIntent) this.acceptStep(task, cx);
      else {
        const armed = this.acceptIntent;
        this.acceptIntent = null;
        if (waiting && e.key === "r") this.askRunChanges(task, cx);
        else if (e.key === "d") this.seeDiff(task);
        else if (e.key === "c" && canCompare(task)) this.openCompare(task);
        else {
          // Other keys, Tab among them, keep their default once Accept is disarmed.
          if (armed) cx.notify();
          return false;
        }
      }
      return true;
    }
    if (e.key === "n") { openGoal(); return true; }
    if (!scope) return false;
    const at = this.runBucket(scope).all.find((item) => `task-${item.id}` === this.sel), waits = at?.state === "needs_you";
    if (this.runPicked.length && e.key === "enter") this.acceptPicked(scope, cx);
    else if (this.runPicked.length && e.key === "escape") this.runPicked = [];
    else if (e.key === "X" || (e.key === "x" && e.modifiers?.shift)) this.pickRepository(scope, waits ? at : this.runBucket(scope).me[0]);
    else if (e.key === "x") { if (waits) this.togglePick(at); }
    else if (e.key === "c" && at && canCompare(at)) this.openCompare(at);
    else if (e.key === "escape" || e.key === "f") this.leaveRun();
    else if (e.key === "w") openWorkflow(scope.id);
    else if (e.key === "e") openGoal(scope.id);
    else return false;
    return true;
  }

  runAction(t, entry, id) {
    const { goal, action } = entry;
    const act = { review: (cx) => this.openRun(goal, cx), why: (cx) => this.openRun(goal, cx, action.taskId), open: (cx) => this.openRun(goal, cx),
      decide: () => openGoal(goal.id, null, "decision"), changes: () => this.showRunReviews(goal), plan: () => openWorkflow(goal.id),
      trust: (cx) => cx.spawn(async () => { await answerTrust(action.address); }) }[action.kind];
    return button(t, id, action.label, act, { kind: ["review", "why", "decide", "trust"].includes(action.kind) ? "go" : "outline",
      ...(action.kind === "trust" ? { tip: "Answers yes in the agent's tab: it may then read, edit and run files in the run's worktree" } : {}) });
  }

  followUpButton(t, goal, task, id) {
    return button(t, id, "Prepare a follow-up", () => openWorkflow(goal.id, task.id, { followUp: "blocked" }),
      { tip: "Opens a new task with the findings in the run window; nothing is sent until you start it" });
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
    const compared = scope && this.runCompare ? this.runBucket(scope).all.find((item) => item.id === this.runCompare) : null;
    if (compared) return [[back("compare-back", task ? "Task" : "Tasks", () => this.leaveCompare()), title("compare-title", compared.title),
      div().id("compare-attempts").flex_none().text_size(11).text_color(t.muted).child(tookWords(compared))], []];
    if (task) return [[back("task-back", "Tasks", () => this.leaveTask()), title("task-title", task.title)], []];
    if (scope) return [[back("runs-back", "Runs", () => this.leaveRun()), title("run-title", scope.title)], this.runTools(t, scope)];
    return [[div().id("runs-title").pl(8).flex_none().text_size(13).font_semibold().child("Runs"),
      div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(this.narrowInbox ? "" : "a run is a goal you gave your agents")],
    [button(t, "goal-new", [keycap(t, "n"), "New run"], () => openGoal(), { size: "sm", tip: "Write a prompt, choose agents, then start when ready" })]];
  }

  runsLegend(t, runs) {
    const open = runs.filter((entry) => !entry.closed);
    return legend(t, "runs-legend", LEGEND.map((turn) => ({ turn, n: open.filter((entry) => entry.group === turn).length })));
  }

  runsKeys(t) {
    const help = [["?"], "keys"], task = this.shownTask(), scope = this.goalProjection.scope;
    const compare = (item) => (item && canCompare(item) ? [[["c"], "compare"]] : []);
    if (this.runCompare) return keyBar(t, "list-keys", [[["esc"], "back"]], help);
    if (task) return keyBar(t, "list-keys", [...(task.state === "needs_you" ? [[["a", "enter"], task.pr ? "done" : "accept"], ...(task.pr ? [] : [[["r"], "changes"]])] : []), [["d"], "diff"], ...compare(task), [["esc"], "tasks"]], help);
    if (scope && this.runPicked.length) return this.batchBar(t, scope);
    if (scope) return keyBar(t, "list-keys", [[["j", "k"], "move"], [["enter"], "open the task"],
      ...compare(this.runBucket(scope).all.find((item) => `task-${item.id}` === this.sel)), [["esc"], "runs"]], help);
    return this.listKeys(t, "runs");
  }

  runsBody(t, runs) {
    const scope = this.goalProjection.scope, entry = scope && runs.find((item) => item.goal.id === scope.id), task = this.shownTask();
    const errors = [this.goalsError ? line(this.goalsError, t, true) : null, this.runCloseError ? line(this.runCloseError, t, true) : null,
      this.runError ? line(this.runError, t, true).id("run-error").role("alert") : null,
      this.runNotice ? line(this.runNotice, t).id("run-notice").role("status") : null].filter(Boolean);
    const compared = entry && this.runCompare ? this.runBucket(entry.goal).all.find((item) => item.id === this.runCompare) : null;
    if (compared) return [...errors, ...this.compareView(t, compared)];
    if (entry && task) return [...errors, ...this.taskDetail(t, entry.goal, task)];
    if (entry) return [...errors, ...this.runView(t, entry)];
    return [...errors, ...this.runsGlance(t, runs)];
  }

  runsGlance(t, runs) {
    const open = this.openRuns(runs), closed = runs.filter((entry) => entry.closed);
    const seen = (entry) => !this.hiddenIds.has(`goal-${entry.goal.id}`), draw = (entry) => this.runCard(t, entry);
    const target = runs.find((entry) => `goal-${entry.goal.id}` === this.sel) ?? open[0];
    return [
      ...RUN_GROUPS.flatMap(([group, label]) => {
        const list = open.filter((entry) => entry.group === group), shown = list.filter(seen);
        return shown.length ? [legHeader(t, `runs-leg-${group}`, label, list.length, { me: group === "me" }), ...joined(t, shown.map(draw))] : [];
      }),
      ...(!runs.length ? [line("No runs yet", t)] : []),
      ...(closed.length ? [foldRow(this, t, "runs-closed-fold", "runs-closed", `${closed.length} older finished ${closed.length === 1 ? "run" : "runs"}`, { gap: true })] : []),
      ...(this.expanded["runs-closed"] ? joined(t, closed.filter(seen).map(draw)) : []),
      ...this.setupsFold(t, target),
    ];
  }

  // A run answers three questions: what it is, what it does or wants now, and what it shipped.
  runCard(t, entry) {
    const { goal, shipped, hot } = entry, id = `goal-${goal.id}`, sel = this.selected(id);
    const answer = (key, label, value, tone) => labelled(t, `${key}-${goal.id}`, label,
      div().flex_1().min_w(0).truncate().text_size(13).text_color(tone).tooltip(value).child(value));
    return row(t, id, {
      turn: entry.turn, title: goal.title, selected: sel, onSelect: (cx) => this.openRun(goal, cx),
      lines: [answer("goal-now", "Now", entry.now, hot ? t.blocked : t.foreground), answer("goal-shipped", "Shipped", shipped.text, shipped.any ? t.foreground : t.muted)],
      action: entry.group !== "flight" || sel ? this.runAction(t, entry, `goal-action-${goal.id}`) : null,
      below: sel ? [h_flex().gap(5).children(this.runTools(t, goal)), this.confirmClose === goal.id ? this.closeConfirm(t, goal) : null].filter(Boolean) : null,
    });
  }

  runView(t, entry) {
    const { goal } = entry, bucket = this.runBucket(goal), tasks = bucket.all, summary = runSummary(bucket), outside = this.goalProjection.outsideBlockers;
    const progress = runProgress(goal.id, tasks, this.workflowEngine, this.workflowError);
    const rest = [...bucket.open, ...bucket.done];
    const rows = (list) => joined(t, list.map((task) => this.taskRow(t, goal, task)));
    const group = (turn, label) => {
      const shown = rows(bucket[turn]);
      return shown.length ? [legHeader(t, `run-leg-${turn}`, label, bucket[turn].length, { me: turn !== "flight", after: turn === "me" ? this.pickHint(t, goal) : [] }), ...shown] : [];
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
      ...(tasks.length ? [this.runCost(t, entry)] : []),
      ...(this.workflowError ? [line(this.workflowError, t, true)] : []),
      ...(progress && tasks.length ? [line(progress, t).id(`goal-progress-${goal.id}`)] : []),
      ...group("me", "Needs me"), ...group("stuck", "Stuck"), ...group("flight", "In flight"),
      ...(rest.length ? [foldRow(this, t, "run-rest-fold", REST, `${bucket.open.length} not started · ${bucket.done.length} done`, { gap: true })] : []),
      ...(this.expanded[REST] ? rows(rest) : []),
    ];
  }

  taskRow(t, goal, task) {
    const turn = taskTurn(task), id = `task-${task.id}`, at = taskAt(task);
    const open = (cx) => { this.resetRun(task.id); this.h.focus(); cx.notify(); };
    const picking = turn === "me" && this.runPicked.length > 0;
    const main = picking ? { el: this.pickBox(t, task) } : turn === "me" ? { id: `task-review-${task.id}`, label: "Review", run: open, kind: "go" }
      : turn === "stuck" ? { id: `task-why-${task.id}`, label: "See why", run: (cx) => { this.sel = id; this.clicked = true; this.h.focus(); cx.notify(); } } : null;
    return this.item(t, id, {
      turn: turn === "done" ? (task.state === "accepted" ? "ready" : "old") : turn, kind: "relay", title: task.title, reason: picking ? this.thenReason(task, goal) : taskReason(task),
      age: at ? ago(at, true) : null, tip: task.title, main,
      lines: () => [...this.attemptLines(t, task), ...(turn === "stuck" ? this.stuckLines(t, goal, task) : [])],
      actions: [turn === "me" ? null : { id: `task-open-${task.id}`, label: "Open", run: open, tip: "Who did what on this task" },
        canCompare(task) ? { el: this.compareButton(t, task, `task-compare-${task.id}`) } : null].filter(Boolean),
    });
  }

  compareButton(t, task, id) {
    return button(t, id, [keycap(t, "c"), "Compare attempts"], (cx) => { this.openCompare(task); this.h.focus(); cx.notify(); }, { kind: "ghost" });
  }

  // Why a task is stuck, in the reviewer's words, and the one way on.
  stuckLines(t, goal, task) {
    const findings = stuckFindings(task), more = findings.length - WHY_LINES;
    const next = followUpAvailable(task) ? this.followUpButton(t, goal, task, `task-follow-up-${task.id}`)
      : button(t, `task-retry-${task.id}`, "Retry in the run window", () => openWorkflow(goal.id, task.id), { tip: "It still has attempts left" });
    return [
      labelled(t, `task-why-text-${task.id}`, "Why", v_flex().flex_1().min_w(0).gap(2)
        .children(findings.slice(0, WHY_LINES).map((words) => div().min_w(0).text_size(13).child(words)))
        .when(more > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(`+${more} more in the run window`))), 40),
      labelled(t, `task-next-${task.id}`, "Next", h_flex().gap(5).child(next), 40),
    ];
  }

  legRow(t, leg) {
    const at = Date.parse(leg.at ?? "");
    const turn = LEG_TURN[leg.state] ?? "open";
    // In a task, the one leg that is your turn stands out.
    return row(t, `task-leg-${leg.id}`, { turn, title: leg.who, reason: leg.what, tip: leg.what,
      age: leg.now ? "now" : Number.isFinite(at) ? ago(at / 1000, true) : null }).when(turn === "me", (el) => el.bg(meTint(t)));
  }

  // A task: the writer's summary, who did what, then the decision.
  // Expand and fold inside a deep review, and its findings' files opened at the PR's change.
  deepUi(reviews) {
    this.deepOpen ??= new Set();
    return { open: this.deepOpen,
      toggle: (key, cx) => { if (!this.deepOpen.delete(key)) this.deepOpen.add(key); cx.notify(); },
      openFile: (where) => { const r = reviews[0]; openReview(r.root, null, null, null, { from: r.reviewBase, to: "HEAD", file: where.replace(/:\d+(-\d+)?$/, "") }); } };
  }

  taskDetail(t, goal, task) {
    const tasks = this.runBucket(goal).all, waiting = task.state === "needs_you", summary = taskSummary(task);
    if (task.pr) {
      const reviews = tasks.filter((x) => x.pr?.url === task.pr.url);
      return [div().px(8).pb(6).child(deepReviewView(t, `deep-${goal.id}`, reviews, this.deepUi(reviews))), this.taskDecision(t, goal, task, tasks)];
    }
    const notes = waiting ? taskCaveats(task) : [], linked = linkedDecision(goal, tasks).task?.id === task.id;
    return [
      ...(summary ? [div().id("task-summary").px(8).pb(4).text_size(13).child(summary)] : []),
      v_flex().id("task-legs").children(joined(t, taskLegs(task).map((leg) => this.legRow(t, leg)))),
      ...this.taskFiles(t, task),
      ...(notes.length ? [v_flex().id("task-notes").px(8).pt(6).gap(2)
        .child(div().text_size(11).text_color(t.dim).child("Before you accept"))
        .children(notes.slice(0, NOTE_LINES).map((note) => div().min_w(0).text_size(11).text_color(t.muted).child(note)))
        .when(notes.length > NOTE_LINES, (el) => el.child(div().text_size(11).text_color(t.dim).child(`+${notes.length - NOTE_LINES} more in More`)))] : []),
      ...(linked ? [line(`Also resolves: ${goal.decision}`, t)] : []),
      ...(canCompare(task) ? [v_flex().id("task-attempts").px(8).pt(6).gap(2).children(this.attemptLines(t, task))] : []),
      this.taskDecision(t, goal, task, tasks),
    ];
  }

  // A deep review of a PR has no writer to send changes to: its findings go to GitHub as a draft review, or to a fix run.
  prReviewDecision(t, goal, task, tasks, keyed, confirming, diff, more) {
    const reviews = tasks.filter((x) => x.pr?.url === task.pr.url), done = deepReviewDone(reviews), found = mergedFindings(reviews);
    const must = found.filter((f) => f.level !== "minor").length, busy = Boolean(this.runBusy) || this.posting === goal.id;
    const say = !done ? "The other reviewer is still at work; posting now leaves its findings out."
      : found.length ? `${found.length} ${found.length === 1 ? "finding" : "findings"}, ${must} to fix, from ${reviews.length} ${reviews.length === 1 ? "reviewer" : "reviewers"}. Nothing reaches GitHub until you post it.`
      : "No findings. Done closes the review.";
    return v_flex().id("task-decision").px(8).pt(8).gap(6)
      .child(h_flex().flex_wrap().gap(6).items_center()
        .child(button(t, "task-post-review", this.posting === goal.id ? "Posting…" : "Post as draft review", (cx) => this.postReview(goal, reviews, cx),
          { kind: "accent", disabled: busy || !found.length, tip: "A pending review on the PR, with a comment on each line found; you edit and send it on GitHub" }))
        .child(button(t, "task-fix-findings", "Fix with a run", () => fixFindings(reviews).catch((e) => deepReviewNotice("Could not prepare the run", e)),
          { disabled: busy || !must, tip: "A run on a copy of the PR's branch, asked to fix every blocker and major" }))
        .child(button(t, "task-accept", confirming ? keyed("enter", "Confirm done") : keyed("a", "Done"), (cx) => this.acceptStep(task, cx),
          { disabled: busy, tip: "Closes this reviewer's part; nothing is merged or posted" }))
        .child(diff).child(div().flex_1()).child(more))
      .child(div().id("task-effect").min_w(0).text_size(11).text_color(t.muted).child(say));
  }

  postReview(goal, reviews, cx) {
    if (this.posting) return;
    this.posting = goal.id; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const url = await postDraftReview(reviews);
        notify({ title: `Draft review on #${reviews[0].pr.number}`, body: "Pending on GitHub until you send it", level: "success" });
        exec("open", [url]);
      } catch (error) { deepReviewNotice("Draft review not posted", error); }
      this.posting = null; cx.notify();
    });
  }

  taskDecision(t, goal, task, tasks) {
    const waiting = task.state === "needs_you", editing = waiting && this.runChangeFor === task.id, plan = changesPlan(task);
    const confirming = acceptArmed(this.acceptIntent, task);
    const keyed = (cap, label) => [keycap(t, cap), label];
    const more = button(t, "task-more", "More", () => openWorkflow(goal.id, task.id), { kind: "ghost", tip: "Full report, evidence and activity in the run window" });
    const diff = button(t, "task-diff", keyed("d", "See the diff"), () => this.seeDiff(task),
      { kind: waiting ? "solid" : "ghost", tip: task.worktree ? "Opens the change in the review pane beside the panel" : "Opens the run window on this task's result and diff" });
    if (editing) return v_flex().id("task-decision").px(8).pt(8).gap(6)
      .child(Textarea.new(this.runChange).id("task-changes-field").w_full().min_w(0).accessibility_label("What should change?")
        .h(64).px(7).rounded(5).border(1).border_color(t.border).bg(t.background))
      .child(div().text_size(11).text_color(t.muted).child(plan.hint))
      .child(h_flex().gap(6)
        .child(button(t, "task-send-changes", plan.send, (cx) => this.sendRunChanges(cx),
          { kind: "solid", disabled: Boolean(this.runBusy) || !this.runChange.value().trim(), tip: "⌘Enter" }))
        .child(button(t, "task-changes-cancel", "Cancel", (cx) => { this.cancelRunChanges(); cx.notify(); }, { kind: "ghost", disabled: Boolean(this.runBusy) })));
    if (task.pr && waiting) return this.prReviewDecision(t, goal, task, tasks, keyed, confirming, diff, more);
    const effect = `${task.worktree?.prHead ? `Accepting commits to the run branch; then Push to ${task.worktree.prHead} adds it to the pull request. `
      : draftOnAccept(task, config.RUN_DRAFT_PR !== false) ? "Accepting commits to the run branch, pushes it and opens a draft pull request on GitHub. "
      : task.worktree ? "Accepting keeps the worktree and commits to its run branch. " : ""}${acceptanceEffect(task, tasks, this.workflowEngine)}`;
    const push = task.state === "accepted" && task.worktree?.prHead && !task.worktree.pushed && !task.worktree.removed;
    return v_flex().id("task-decision").px(8).pt(8).gap(6)
      .child(h_flex().flex_wrap().gap(6).items_center()
        .when(waiting, (bar) => bar
          .child(button(t, "task-accept", confirming ? keyed("enter", "Confirm accept") : keyed("a", draftOnAccept(task, config.RUN_DRAFT_PR !== false) ? "Accept and open draft PR" : "Accept"), (cx) => this.acceptStep(task, cx),
            { kind: "accent", disabled: Boolean(this.runBusy), tip: "A, then Enter" }))
          .child(button(t, "task-changes", keyed("r", "Ask for changes"), (cx) => this.askRunChanges(task, cx), { disabled: Boolean(this.runBusy) }))
          .child(diff))
        .when(followUpAvailable(task), (bar) => bar.child(this.followUpButton(t, goal, task, "task-follow-up")))
        .when(Boolean(push), (bar) => bar.child(button(t, "task-push", `Push to ${task.worktree?.prHead}`, (cx) => this.pushRun(task, cx),
          { kind: "go", disabled: Boolean(this.runBusy), tip: "Adds the accepted commit to the pull request's branch on GitHub; never forced" })))
        .when(["accepted", "cancelled"].includes(task.state), (bar) => bar.child(button(t, "task-rerun", "Re-run with changes…",
          () => openWorkflow(goal.id, task.id, { followUp: "rerun" }), { tip: "Opens a new task with this one's prompt in the run window; nothing is sent until you start it" })))
        .when(canCompare(task), (bar) => bar.child(this.compareButton(t, task, "task-compare")))
        .when(!waiting, (bar) => bar.child(diff)).child(div().flex_1()).child(more))
      .when(waiting, (el) => el.child(div().id("task-effect").min_w(0).text_size(11).text_color(t.muted).child(effect)));
  }
}
