import { div } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea } from "gpui-base";
import { agents, exec, notify, panes, run, shared, setShared } from "herdr";
import { LANE, alertLine, button, foldRow, icon, legHeader, legend, joined, keyBar, keycap, meTint, plusMinus, row, onSubmitChord } from "./ui.js";
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
import { deepReviewNotice, dropReviewTrees, fixFindings, postDraftReview } from "./deep-review.js";
import { openReviewer } from "./run-launcher.js";
import { deepReviewView, fixChecklistView, fixGlanceView, launchStepsView, notesView } from "./deep-review-view.js";
import { caption } from "./workflow-labels.js";
import { counted, findingKey, fixChecklist, fixOutcome, fixRequest, mergedFindings, reviewAdvice, reviewLead, reviewTitle, verdicts } from "./lib/deep-review.js";
import { RUN_GROUPS, TASK_GROUPS, bucketTasks, emptyBucket, changesPlan, runRow, runShipped, runSummary, taskTurn, taskReason, taskAt, stuckFindings, followUpAvailable, canTryAgain, taskLegs,
  taskSummary, taskNotes, isMerged, finishedAgents, statusWords, finishedAt, finishedWords, parentRun } from "./lib/run-panel.js";
import { canCompare, diffFiles, tookWords } from "./lib/run-compare.js";

// Linked PR URLs known to have merged, kept after the landing list lets them go.
// A deep review is one row, whatever its reviewers are doing: the reviewer most in need of you stands for it.
const leads = (tasks, task) => !task.pr || reviewLead(tasks.filter((x) => x.pr?.url === task.pr.url))?.id === task.id;

export const MERGED = "relevo.runs.merged";
const REST = "more-run-rest";
const WHY_LINES = 4, FILE_LINES = 8;
const LAUNCH_SHOWN_MS = 300000;
const LEGEND = ["me", "flight", "ready"];
// What a step of a task is, as the lane glyph of its row.
const LEG_MARK = { ok: ["check", "done"], bad: ["warn", "blocked"], run: [null, "working"], you: [null, "accent"], wait: [null, "dim"] };
const line = (s, t, attention = false) => (attention ? alertLine(t, `alert-${String(s).length}-${String(s).slice(0, 24)}`, s).px(8).text_size(11) : div().px(8).text_size(11).text_color(t.muted).child(s));
const labelled = (t, id, label, body, width = 56) => h_flex().id(id).gap(8).items_start().min_w(0)
  .child(div().w(width).flex_none().pt(1).text_size(11).text_color(t.dim).child(label)).child(body);

// Runs in the panel: the list of runs, one run's tasks, and one task with its decision. Mixed into Inbox.
export class RunViews {
  startRuns() {
    this.runChange = TextareaState.new({ value: "", placeholder: "What should change?" });
    this.runChange.on("change", (_e, cx) => cx.notify());
    onSubmitChord(this.runChange, (cx) => this.sendRunChanges(cx));
    this.fixNote = TextareaState.new({ value: "", placeholder: "Anything else?" });
    this.fixNote.on("change", (_e, cx) => cx.notify());
    onSubmitChord(this.fixNote, (cx) => this.sendRunChanges(cx, true));
    this.fixPicks = null;
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
    return [...TASK_GROUPS, ...(rest ? ["open", "done"] : [])].flatMap((turn) => bucket[turn]).filter((task) => leads(bucket.all, task));
  }

  shownTask() {
    return this.runTask ? (this.workflowTasks ?? []).find((task) => task.id === this.runTask) ?? null : null;
  }

  runEntries() {
    const merged = this.mergedUrls();
    return this.goalProjection.groups.map(({ goal, items }) => {
      const bucket = this.runBucket(goal);
      const decision = Boolean(goal.decision?.trim()) && linkedDecision(goal, bucket.all, this.workflowError).state === "separate";
      const row = runRow(goal, bucket, { engine: this.workflowEngine, error: this.workflowError, decision, reviewCount: reviewableWork(items, this.clones).length, launch: this.liveLaunch() });
      const closed = goalState(goal) === "completed", done = finishedAt(goal, bucket.all, this.goalDoc?.history);
      // A finished run says when, so the list reads newest first.
      return { goal, items, closed, shipped: runShipped(goal, this.runBucket(goal, true), items, merged), ...row, finishedAt: done,
        ...((closed || row.group === "ready") && done ? { now: `${row.now} · ${finishedWords(done)}` } : {}) };
    });
  }

  // The runs in list order: by turn, finished ones newest first, and a run's child runs right under it.
  runTree(runs) {
    const newest = (a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0);
    const tasksOf = (goal) => this.runBucket(goal).all, parent = new Map(runs.map((e) => [e, parentRun(e, runs, tasksOf)]));
    // An open parent takes all its children; a closed one only its closed ones.
    const nested = (e) => { const p = parent.get(e); return p && (!p.closed || e.closed) ? p : null; };
    const kids = (p) => runs.filter((e) => nested(e) === p).sort(newest);
    const withKids = (list) => list.filter((e) => !nested(e)).flatMap((e) => [{ entry: e, depth: 0 }, ...kids(e).map((k) => ({ entry: k, depth: 1 }))]);
    const open = RUN_GROUPS.map(([group, label]) => ({ group, label, rows: withKids(runs.filter((e) => !e.closed && e.group === group).sort(group === "ready" ? newest : () => 0)) }));
    return { open, closed: withKids(runs.filter((e) => e.closed).sort(newest)) };
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
    const tree = this.runTree(runs);
    return [...tree.open.flatMap((g) => g.rows), ...(this.expanded["runs-closed"] ? tree.closed : [])]
      .map(({ entry }) => ({ id: `goal-${entry.goal.id}`, section: "goals", go: () => this.enterRun(entry.goal) }));
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

  // Accepted with nothing else open in its run: back to the runs, on this one, keeping what was just said.
  backToRuns(goalId) {
    if (shared(GOAL_SCOPE) !== goalId || (this.workflowTasks ?? []).some((x) => x.goalId === goalId && !["accepted", "cancelled"].includes(x.state))) return false;
    this.leaveRun(); this.runAt = this.runPlace();
    return true;
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
    this.closeDoneAgents(this.workflowTasks);
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
        if (outcome === "changes") this.clearPicks();
        const kept = outcome === "accept" && Boolean(task.worktree);
        this.runNotice = outcome !== "accept" ? "Feedback saved. The next result will return for your review."
          : !kept ? "Acceptance saved."
          : task.worktree.prHead ? `Accepted and committed. Push to ${task.worktree.prHead} adds it to the pull request.`
          : response.result?.pr ? `Accepted, and the draft pull request is open: ${response.result.pr}`
          : response.result?.prError ? `Accepted and committed; the draft pull request didn't open: ${response.result.prError}` : "Accepted and committed to its run branch.";
        // A pull request fix leaves once its push lands; a draft PR run once its PR is open.
        const done = !kept || (outcome === "accept" && Boolean(response.result?.pr));
        if (this.runTask === task.id && !(done && this.backToRuns(task.goalId)) && !kept) {
          this.runTask = null; this.runAt = this.runPlace();
          const next = this.orderedTasks({ id: task.goalId }, false).find((item) => item.id !== task.id);
          this.sel = next ? `task-${next.id}` : null;
        }
      } catch (e) { this.runError = `Action needs attention: ${e.message ?? e}`; }
      this.runBusy = false;
      this.loadGoals(cx);
      this.h.focus(); cx.notify();
      // A run that fixes a pull request goes onto it with the same click.
      if (!this.runError && outcome === "accept" && task.worktree?.prHead) this.pushRun(task, cx);
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
        if (this.runTask === task.id) this.backToRuns(task.goalId);
      } catch (e) { this.runError = `Not pushed: ${e.message ?? e}`; }
      this.runBusy = false; cx.notify();
    });
  }

  // A, or a click, arms the acceptance of the revision on screen; only Enter, or a second click, confirms it.
  acceptStep(task, cx, confirm = true) {
    if (task.pr) return this.finishStep(task, cx, confirm);
    if (this.runBusy || task.state !== "needs_you") return;
    if (confirm && acceptArmed(this.acceptIntent, task)) return this.decideRun(task, "accept", cx);
    this.acceptIntent = armAccept(task);
    cx.notify();
  }

  // Done on a deep review closes every reviewer's part: a verdict is accepted, anything else cancelled.
  finishStep(task, cx, confirm = true) {
    if (this.runBusy) return;
    if (!confirm || !acceptArmed(this.acceptIntent, task)) { this.acceptIntent = armAccept(task); cx.notify(); return; }
    this.acceptIntent = null;
    this.closeReview(task, cx, "Deep review closed.");
  }

  // Its findings are handled (posted, handed to a fix run, or done with): no reviewer part stays open, and its
  // worktrees go.
  closeReview(task, cx, notice, then = null) {
    if (this.runBusy) return;
    const reviews = this.reviewsOf(task).filter((x) => !["accepted", "cancelled"].includes(x.state));
    this.runBusy = true; this.runError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        for (const r of reviews) {
          this.takeDoc(await workflowCommand(r.state === "needs_you" ? decidePayload(r, "accept", "", { draft: false }) : { action: "cancel", taskId: r.id }));
        }
        await dropReviewTrees(this.reviewsOf(task));
        this.runNotice = notice;
        this.runTask = null; this.runAt = this.runPlace(); this.sel = null;
      } catch (e) { this.runError = `Action needs attention: ${e.message ?? e}`; }
      this.runBusy = false; cx.notify();
      then?.();
    });
  }

  // Their report is in Runs: the tab of an agent whose part is over goes, unless it is working on something.
  closeDoneAgents(tasks) {
    this.closedAgents ??= new Set();
    for (const address of finishedAgents(tasks ?? [])) {
      if (this.closedAgents.has(address) || agents().find((a) => a.address === address)?.status === "working") continue;
      const pane = panes().find((p) => p.terminal === address)?.pane;
      if (!pane) continue;
      this.closedAgents.add(address);
      run("pane.close", { pane });
    }
  }

  // A fix of a deep review reads against that review: each finding and what the fix did with it.
  // A fix run measured against the deep review it came from; null when it came from none.
  fixOutcomeOf(task) {
    const reviews = task.worktree?.prUrl ? (this.workflowTasks ?? []).filter((x) => x.pr?.url === task.worktree.prUrl) : [];
    const findings = mergedFindings(reviews);
    if (!findings.length) return null;
    const d = this.taskDiff?.taskId === task.id ? this.taskDiff : null;
    return fixOutcome(findings, task, d?.result ? diffFiles(d.result).list.map((f) => f.path) : []);
  }

  fixSummary(t, task, ui, outcome) {
    if (outcome) return [div().px(8).pb(8).child(fixGlanceView(t, "task-fix-outcome", outcome, ui))];
    const list = fixChecklist(task);
    return list ? [div().px(8).pb(6).child(fixChecklistView(t, "task-checklist", list))] : [];
  }

  // A run that opens its reviewer late: when its writing is done and checked, the reviewer opens here.
  openPendingReviewers(tasks, cx) {
    this.openingReviewer ??= new Set();
    for (const task of tasks ?? []) {
      if (!task.reviewLater || task.reviewer || task.state !== "needs_review" || this.openingReviewer.has(task.id)) continue;
      this.openingReviewer.add(task.id);
      cx.spawn(async () => {
        try { await openReviewer(task, cx); }
        catch (error) { this.openingReviewer.delete(task.id); notify({ title: "The reviewer did not open", body: String(error?.message ?? error), level: "error" }); }
      });
    }
  }

  reviewsOf(task) {
    return (this.workflowTasks ?? []).filter((x) => x.goalId === task.goalId && x.pr?.url === task.pr?.url);
  }

  // Findings marked with Ask to fix, kept while the task waits on this same revision.
  picksOf(task) {
    const p = this.fixPicks;
    return p && p.taskId === task.id && p.revision === task.revision && (task.state === "needs_you" || canTryAgain(task)) ? p.items : new Map();
  }

  // Marks the findings, or unmarks them when every one is marked already.
  togglePicks(task, list, cx) {
    const items = new Map(this.picksOf(task)), keys = list.map(findingKey);
    if (keys.every((k) => items.has(k))) keys.forEach((k) => items.delete(k));
    else list.forEach((f) => items.set(findingKey(f), f));
    this.fixPicks = items.size ? { taskId: task.id, revision: task.revision, items } : null;
    cx.notify();
  }

  clearPicks() {
    this.fixPicks = null; this.fixNote.set_value("");
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
  // `picked`: sent from the marked findings, whose details go under the person's own words.
  sendRunChanges(cx, picked = false) {
    const task = this.shownTask();
    if (picked && task && canTryAgain(task)) return this.tryAgain(cx);
    if (!task || task.state !== "needs_you" || this.runBusy || (!picked && task.id !== this.runChangeFor)) return;
    const picks = [...this.picksOf(task).values()], words = (picked ? this.fixNote : this.runChange).value().trim();
    const text = picks.length ? fixRequest(picks, words) : words;
    if (!text) return;
    if (changesPlan(task).spent) {
      if (picks.length) this.clearPicks();
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
    return [v_flex().id("task-files").px(8).pt(10).gap(2)
      .child(h_flex().gap(6).items_center().pb(2)
        .child(div().text_size(11).font_semibold().text_color(t.muted).child(files.head)).children(plusMinus(t, files.added, files.removed))
        .child(div().flex_1())
        .child(button(t, "task-diff", [keycap(t, "d"), "Review"], () => this.seeDiff(task),
          { kind: task.state === "needs_you" ? "solid" : "ghost", tip: task.worktree ? "Opens the change in the review pane beside the panel" : "Opens the run window on this task's result and diff" })))
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
      const waiting = (task.state === "needs_you" || Boolean(task.pr)) && !this.runBusy;
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
    if (!scope) {
      const goal = this.sel?.startsWith("goal-") ? (this.goalDoc?.goals ?? []).find((g) => `goal-${g.id}` === this.sel) : null, closed = goal && goalState(goal) === "completed";
      if (!goal) return false;
      if (e.key === "e") openGoal(goal.id);
      else if (e.key === "p" || e.key === "w") openWorkflow(goal.id);
      else if (e.key === "c" && !closed) { this.confirmClose = goal.id; cx.notify(); }
      else if (e.key === "a" && closed) this.archiveRuns([goal], cx);
      else return false;
      return true;
    }
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
      button(t, `goal-edit-${goal.id}`, [keycap(t, "e"), "Edit"], () => openGoal(goal.id), { kind: "ghost", size: "sm" }),
      ...(goalState(goal) !== "completed" ? [button(t, `goal-close-${goal.id}`, [keycap(t, "c"), "Close"], (cx) => { this.confirmClose = goal.id; cx.notify(); },
        { kind: "ghost", size: "sm", disabled: Boolean(this.closingRun), tip: "Cancel open tasks and close this run" })] : []),
      button(t, `goal-window-${goal.id}`, [keycap(t, "p"), "Plan"], () => openWorkflow(goal.id), { kind: "ghost", size: "sm", tip: "Plan or add tasks in the run window" }),
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
    if (task) return [[back("task-back", "Tasks", () => this.leaveTask()), title("task-title", task.pr ? reviewTitle(task.pr) : task.title)], []];
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
    const picked = this.sel?.startsWith("goal-") ? (this.goalDoc?.goals ?? []).find((g) => `goal-${g.id}` === this.sel) : null;
    if (picked) return keyBar(t, "list-keys", [[["j", "k"], "move"], [["enter"], "open"], [["e"], "edit"],
      ...(goalState(picked) === "completed" ? [[["a"], "archive"]] : [[["c"], "close"]]), [["p"], "plan"]], help);
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
    const tree = this.runTree(runs), open = tree.open.flatMap((g) => g.rows.map((r) => r.entry)), closed = tree.closed.map((r) => r.entry);
    const seen = ({ entry }) => !this.hiddenIds.has(`goal-${entry.goal.id}`);
    // A child run sits under the run it came from, indented.
    const draw = ({ entry, depth }) => (depth ? div().pl(18).child(this.runCard(t, entry, true)) : this.runCard(t, entry));
    const target = runs.find((entry) => `goal-${entry.goal.id}` === this.sel) ?? open[0];
    return [
      ...tree.open.flatMap(({ group, label, rows }) => {
        const shown = rows.filter(seen);
        return shown.length ? [legHeader(t, `runs-leg-${group}`, label, rows.filter((r) => !r.depth).length, { me: group === "me" }), ...joined(t, shown.map(draw))] : [];
      }),
      ...(!runs.length ? [line("No runs yet", t)] : []),
      ...(closed.length ? [foldRow(this, t, "runs-closed-fold", "runs-closed", `${closed.length} older finished ${closed.length === 1 ? "run" : "runs"}`, { gap: true })] : []),
      ...(this.expanded["runs-closed"] ? joined(t, tree.closed.filter(seen).map(draw)) : []),
      ...(this.expanded["runs-closed"] && closed.length > 1 ? [h_flex().px(8).pt(4).child(button(t, "runs-archive-all", this.archivingRuns ? "Archiving…" : `Archive all ${closed.length}`,
        (cx) => this.archiveRuns(closed.map((entry) => entry.goal), cx), { size: "sm", disabled: Boolean(this.archivingRuns), tip: "Files every closed run away; their history stays in the runs archive" }))] : []),
      ...this.setupsFold(t, target),
    ];
  }

  closedActions(t, goal) {
    const busy = Boolean(this.archivingRuns);
    if (this.confirmDelete === goal.id) return h_flex().gap(5).items_center()
      .child(div().text_size(11).text_color(t.blocked).child("Delete it and its worktrees?"))
      .child(button(t, `goal-delete-no-${goal.id}`, "Keep", (cx) => { this.confirmDelete = null; cx.notify(); }, { size: "sm", disabled: busy }))
      .child(button(t, `goal-delete-yes-${goal.id}`, "Delete", (cx) => this.archiveRuns([goal], cx, { remove: true }), { size: "sm", kind: "danger", disabled: busy }));
    return h_flex().gap(5)
      .child(button(t, `goal-archive-${goal.id}`, "Archive", (cx) => this.archiveRuns([goal], cx), { size: "sm", disabled: busy, tip: "A · files it away; its history stays in the runs archive" }))
      .child(button(t, `goal-delete-${goal.id}`, "Delete", (cx) => { this.confirmDelete = goal.id; cx.notify(); }, { size: "sm", kind: "ghost", disabled: busy, tip: "Also removes its worktrees, unless one has uncommitted work" }));
  }

  // A run answers three questions: what it is, what it does or wants now, and what it shipped.
  runCard(t, entry, child = false) {
    const { goal, shipped, hot } = entry, id = `goal-${goal.id}`, sel = this.selected(id);
    const answer = (key, label, value, tone) => labelled(t, `${key}-${goal.id}`, label,
      div().flex_1().min_w(0).truncate().text_size(13).text_color(tone).tooltip(value).child(value));
    return row(t, id, {
      // A click selects, showing Edit, Close and Plan; a second click, or Enter, opens it.
      turn: entry.turn, title: child ? `↳ ${goal.title}` : goal.title, selected: sel, onSelect: (cx) => { if (sel) this.openRun(goal, cx); else { this.sel = id; this.clicked = true; this.h.focus(); cx.notify(); } },
      lines: [answer("goal-now", "Now", entry.now, hot ? t.blocked : t.foreground),
        // A run starting shows its steps instead of what it shipped.
        ...(this.liveLaunch()?.goalId === goal.id && this.liveLaunch().steps ? [div().pl(LANE).pr(8).py(2).child(launchStepsView(t, `launch-${goal.id}`, this.liveLaunch().steps))]
          : [answer("goal-shipped", "Shipped", shipped.text, shipped.any ? t.foreground : t.muted)])],
      // A finished run is closed from its row: it then folds into the older finished runs, which archive or delete.
      action: entry.closed ? this.closedActions(t, goal)
        : entry.group === "ready" && goalState(goal) !== "completed" && !this.openTasks(goal.id).length
        ? button(t, `goal-close-row-${goal.id}`, this.closingRun === goal.id ? "Closing…" : "Close", (cx) => this.closeRun(goal, cx),
          { size: "sm", disabled: Boolean(this.closingRun), tip: "Nothing is left open: this files it under older finished runs" })
        : entry.group !== "flight" || sel ? this.runAction(t, entry, `goal-action-${goal.id}`) : null,
      below: sel ? [h_flex().gap(5).children(this.runTools(t, goal)), this.confirmClose === goal.id ? this.closeConfirm(t, goal) : null].filter(Boolean) : null,
    });
  }

  runView(t, entry) {
    const { goal } = entry, bucket = this.runBucket(goal), tasks = bucket.all, summary = runSummary(bucket), outside = this.goalProjection.outsideBlockers;
    const progress = runProgress(goal.id, tasks, this.workflowEngine, this.workflowError);
    const rest = [...bucket.open, ...bucket.done];
    const rows = (list) => joined(t, list.filter((task) => leads(tasks, task)).map((task) => (task.pr ? this.deepRow(t, goal, task, tasks) : this.taskRow(t, goal, task))));
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

  deepRow(t, goal, lead, tasks) {
    const reviews = tasks.filter((x) => x.pr?.url === lead.pr.url), id = `task-${lead.id}`, turn = taskTurn(lead), at = taskAt(lead);
    const open = (cx) => { this.resetRun(lead.id); this.h.focus(); cx.notify(); };
    const left = verdicts(reviews).filter((v) => v.state === "working").length, found = mergedFindings(reviews);
    const reason = left ? `${reviews.length - left} of ${reviews.length} reviewers done` : found.length ? counted(found) : "no findings";
    return this.item(t, id, {
      turn: turn === "done" ? "ready" : turn, kind: "relay", title: reviewTitle(lead.pr), reason, age: at ? ago(at, true) : null, tip: lead.pr.url,
      main: ["me", "stuck"].includes(turn) ? { id: `task-review-${lead.id}`, label: "Review", run: open, kind: "go" } : { id: `task-open-${lead.id}`, label: "Open", run: open },
      lines: () => (turn === "stuck" ? this.stuckLines(t, goal, lead) : []), actions: [],
    });
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

  dismissReview(task, cx) {
    if (this.runBusy) return;
    this.runBusy = true; cx.notify();
    cx.spawn(async (cx) => {
      try { this.takeDoc(await workflowCommand({ action: "cancel", taskId: task.id })); }
      catch (error) { this.runError = String(error?.message ?? error); }
      this.runBusy = false; cx.notify();
    });
  }

  // Why a task is stuck, in the reviewer's words, and the one way on.
  // `detail`: in the task's own view, where its findings show as cards and Try again sits with the decision.
  stuckLines(t, goal, task, detail = false) {
    const retry = canTryAgain(task);
    if (detail && retry) return [labelled(t, `task-why-text-${task.id}`, "Why", div().flex_1().min_w(0).text_size(13).child(stuckFindings(task)[0]), 40)];
    const findings = stuckFindings(task), more = findings.length - WHY_LINES;
    // A stuck PR review has nothing to retry into: it goes, and a new Deep review starts fresh.
    const next = task.pr ? button(t, `task-dismiss-${task.id}`, "Dismiss", (cx) => this.dismissReview(task, cx), { tip: "Cancels this reviewer's part; start Deep review again from the PR" })
      : followUpAvailable(task) ? this.followUpButton(t, goal, task, `task-follow-up-${task.id}`)
      : button(t, `task-retry-${task.id}`, "Retry in the run window", () => openWorkflow(goal.id, task.id), { tip: "It still has attempts left" });
    return [
      labelled(t, `task-why-text-${task.id}`, "Why", v_flex().flex_1().min_w(0).gap(2)
        .children(findings.slice(0, WHY_LINES).map((words) => div().min_w(0).text_size(13).child(words)))
        .when(more > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(`+${more} more in the run window`))), 40),
      labelled(t, `task-next-${task.id}`, "Next", h_flex().gap(5)
        .when(retry, (el) => el.child(button(t, `task-again-${task.id}`, "Try again…", () => this.resetRun(task.id),
          { kind: "solid", tip: "Opens the task: its findings, what to fix, then one more try in the same worktree" })))
        .child(next), 40),
    ];
  }

  // What Send will ask for: the count of marked findings, an optional note, Send and Clear.
  // `plan`: { head, hint, send, run(cx) }; Clear shows only while something is marked.
  picksBar(t, task, n, plan) {
    return v_flex().id("task-picks").w_full().gap(6).p(8).rounded(6).bg(t.raised)
      .child(h_flex().gap(6).items_center().child(icon("check", t.done, 12))
        .child(div().flex_none().text_size(13).font_semibold().child(plan.head ?? `${n} to fix`))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(plan.hint)))
      .child(Textarea.new(this.fixNote).id("task-picks-note").w_full().min_w(0).accessibility_label("Anything else?")
        .h(40).px(7).rounded(5).border(1).border_color(t.border).bg(t.background))
      .child(h_flex().gap(6)
        .child(button(t, "task-picks-send", plan.send, (cx) => (plan.run ?? ((c) => this.sendRunChanges(c, true)))(cx), { kind: "solid", disabled: Boolean(this.runBusy), tip: "⌘Enter" }))
        .when(n > 0, (el) => el.child(button(t, "task-picks-clear", "Clear", (cx) => { this.clearPicks(); cx.notify(); }, { kind: "ghost", disabled: Boolean(this.runBusy) }))));
  }

  // A stuck run, once more in place: the marked findings, or every one when none is marked, and the note.
  tryAgain(cx) {
    const task = this.shownTask();
    if (!task || !canTryAgain(task) || this.runBusy) return;
    const picks = [...this.picksOf(task).values()], findings = picks.length ? picks : taskNotes(task).findings, words = this.fixNote.value().trim();
    const text = findings.length ? fixRequest(findings, words) : words;
    if (!text) { this.runError = "Say what the next try should fix."; cx.notify(); return; }
    this.runBusy = true; this.runError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        this.takeDoc(await workflowCommand({ action: "retry", taskId: task.id, text }));
        this.clearPicks();
        this.runNotice = "Trying again: the writer has what to fix, then the reviewer looks again.";
      } catch (e) { this.runError = `Action needs attention: ${e.message ?? e}`; }
      this.runBusy = false;
      this.loadGoals(cx);
      this.h.focus(); cx.notify();
    });
  }

  // One line per leg: done, going, waiting, or your turn tinted.
  legLine(t, leg) {
    const at = Date.parse(leg.at ?? ""), [glyph, tone] = LEG_MARK[leg.state] ?? LEG_MARK.wait;
    return h_flex().id(`task-leg-${leg.id}`).w_full().min_w(0).gap(8).px(4).py(2).items_center().rounded(4).tooltip(leg.what)
      .when(leg.state === "you", (el) => el.bg(meTint(t)))
      .child(h_flex().w(12).flex_none().justify_center().child(glyph ? icon(glyph, t[tone], 11) : div().size(6).rounded_full().bg(t[tone])))
      .child(div().flex_none().text_size(13).font_semibold().text_color(leg.state === "wait" ? t.muted : t.foreground).child(leg.who))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.muted).child(leg.what))
      .when(Boolean(leg.now) || Number.isFinite(at), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(leg.now ? "now" : ago(at / 1000, true))));
  }

  // A task: the writer's summary, who did what, then the decision.
  // Expand and fold inside a deep review, and its findings' files opened at the PR's change.
  // The run a deep review handed its findings to: the newest task working on that PR's branch in another run.
  fixOf(reviews) {
    return this.fixesOf(reviews).at(-1) ?? null;
  }

  // Every run that fixes this review's pull request: the latest task of each.
  fixesOf(reviews) {
    const url = reviews[0]?.pr?.url, byGoal = new Map();
    for (const x of this.workflowTasks ?? []) if (url && x.worktree?.prUrl === url) byGoal.set(x.goalId, x);
    return [...byGoal.values()];
  }

  deepUi(reviews) {
    this.deepOpen ??= new Set();
    const fix = this.fixOf(reviews), outcome = fix ? fixOutcome(mergedFindings(reviews), fix) : null;
    const byFinding = new Map(outcome?.groups.flatMap((g) => g.rows.map((r) => [`${r.f.where}|${r.f.issue}`, g.outcome])) ?? []);
    return { open: this.deepOpen, outcomeOf: (f) => byFinding.get(`${f.where}|${f.issue}`) ?? null,
      toggle: (key, cx) => { if (!this.deepOpen.delete(key)) this.deepOpen.add(key); cx.notify(); },
      openFile: (where) => { const r = reviews[0]; openReview(r.root, null, null, null, { from: r.reviewBase, to: "HEAD", file: where.replace(/:\d+(-\d+)?$/, "") }); } };
  }

  taskDetail(t, goal, task) {
    const tasks = this.runBucket(goal).all, waiting = task.state === "needs_you", summary = taskSummary(task);
    if (task.pr) {
      const reviews = tasks.filter((x) => x.pr?.url === task.pr.url);
      // The runs this review handed its findings to, each a click away.
      const fixes = this.fixesOf(reviews).map((fix) => [fix, (this.goalDoc?.goals ?? []).find((g) => g.id === fix.goalId)]).filter(([, g]) => g);
      return [
        ...(fixes.length ? [v_flex().id("deep-fix-run").px(8).pb(6).gap(4)
          .child(div().text_size(11).text_color(t.dim).child(`Runs from this review · ${fixes.length}`))
          .children(fixes.map(([fix, fixGoal], i) => h_flex().id(`deep-fix-run-${i}`).gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().text_size(13).child(`↳ ${fixGoal.title} · ${taskReason(fix)}`))
            .child(button(t, i ? `deep-fix-open-${i}` : "deep-fix-open", "Open", (cx) => this.openRun(fixGoal, cx, fix.id), { size: "sm" }))))] : []),
        div().px(8).pb(6).child(deepReviewView(t, `deep-${goal.id}`, reviews, this.deepUi(reviews))), this.taskDecision(t, goal, task, tasks)];
    }
    const retry = canTryAgain(task), notes = waiting || retry ? taskNotes(task) : null, linked = linkedDecision(goal, tasks).task?.id === task.id;
    // A file a finding names opens in the run's change, beside the panel.
    const picks = this.picksOf(task);
    const pick = (waiting || retry) && !task.pr && task.executor ? { pick: (list, cx) => this.togglePicks(task, list, cx), picked: (key) => picks.has(key) } : {};
    const ui = { ...this.deepUi([task]), ...pick, openFile: task.worktree ? (where) => this.seeDiff(task, where.replace(/:\d+(-\d+)?$/, "")) : null };
    const outcome = this.fixOutcomeOf(task), left = outcome?.left.length ?? 0, status = statusWords(task);
    const tries = (task.attempts ?? []).filter((a) => a.role === "executor").length;
    return [
      ...(taskTurn(task) === "stuck" ? [v_flex().id("task-stuck").px(8).pb(6).gap(4).children(this.stuckLines(t, goal, task, true))] : []),
      div().id("task-status").px(8).pb(4).text_size(13).font_semibold().text_color(left ? t.ansi3 : t[status.tone])
        .child(left ? `${status.text} · ${left} ${left === 1 ? "major" : "majors"} from the deep review left` : status.text),
      ...(summary ? [div().id("task-summary").px(8).pb(6).text_size(13).child(summary)] : []),
      ...this.fixSummary(t, task, ui, outcome),
      ...(notes && (notes.findings.length || notes.unchecked.length) ? [div().id("task-notes").px(8).pt(2).child(notesView(t, `notes-${task.id}`, notes, ui))] : []),
      ...(linked ? [line(`Also resolves: ${caption(goal.decision, 120)}`, t)] : []),
      ...this.taskFiles(t, task),
      v_flex().id("task-how").px(8).pt(10).gap(3)
        .child(div().text_size(11).font_semibold().text_color(t.muted).child(`How it went${tries > 1 ? ` · ${tries} tries` : ""}`))
        .children(taskLegs(task).map((leg) => this.legLine(t, leg))),
      ...(canCompare(task) ? [v_flex().id("task-attempts").px(8).pt(6).gap(2).children(this.attemptLines(t, task))] : []),
      this.taskDecision(t, goal, task, tasks),
    ];
  }

  // A deep review of a PR has no writer to send changes to: its findings go to GitHub as a draft review, or to a fix run.
  prReviewDecision(t, goal, task, tasks, keyed, confirming, diff, more) {
    const reviews = tasks.filter((x) => x.pr?.url === task.pr.url), found = mergedFindings(reviews);
    const must = found.filter((f) => f.level !== "minor").length, busy = Boolean(this.runBusy) || this.posting === goal.id;
    const say = reviewAdvice(reviews);
    return v_flex().id("task-decision").px(8).pt(8).gap(6)
      .child(h_flex().flex_wrap().gap(6).items_center()
        .child(button(t, "task-post-review", this.posting === goal.id ? "Posting…" : "Post as draft review", (cx) => this.postReview(goal, reviews, cx),
          { kind: "accent", disabled: busy || !found.length, tip: "A pending review on the PR, with a comment on each line found; you edit and send it on GitHub" }))
        .child(button(t, "task-fix-findings", "Fix with a run", (cx) => this.closeReview(task, cx, "Handed to a fix run.", () => fixFindings(reviews).catch((e) => deepReviewNotice("Could not prepare the run", e))),
          { disabled: busy || !must, tip: "Starts now, on a copy of the PR's branch, with your usual writer and reviewer; Runs shows it starting" }))
        .child(button(t, "task-fix-adjust", "Adjust…", (cx) => this.closeReview(task, cx, "Handed to a fix run.", () => fixFindings(reviews, { adjust: true }).catch((e) => deepReviewNotice("Could not prepare the run", e))),
          { kind: "ghost", size: "sm", disabled: busy || !must, tip: "Choose who writes and reviews it, and its tests, before it starts" }))
        .child(button(t, "task-accept", confirming ? keyed("enter", "Confirm done") : keyed("a", "Done"), (cx) => this.acceptStep(task, cx),
          { disabled: busy, tip: "Closes the whole deep review; nothing is merged or posted" }))
        .child(diff).child(div().flex_1()).child(more))
      .child(div().id("task-effect").min_w(0).text_size(11).text_color(t.muted).child(say));
  }

  postReview(goal, reviews, cx, task = reviews[0]) {
    if (this.posting) return;
    this.posting = goal.id; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const url = await postDraftReview(reviews);
        notify({ title: `Draft review on #${reviews[0].pr.number}`, body: "Pending on GitHub until you send it", level: "success" });
        exec("open", [url]);
        this.posting = null;
        this.closeReview(task, cx, "Posted as a draft review.");
      } catch (error) { deepReviewNotice("Draft review not posted", error); }
      this.posting = null; cx.notify();
    });
  }

  taskDecision(t, goal, task, tasks) {
    const waiting = task.state === "needs_you", editing = waiting && this.runChangeFor === task.id, plan = changesPlan(task);
    const confirming = acceptArmed(this.acceptIntent, task);
    const keyed = (cap, label) => [keycap(t, cap), label];
    const more = button(t, "task-more", "More", () => openWorkflow(goal.id, task.id), { kind: "ghost", tip: "Full report, evidence and activity in the run window" });
    const filesShown = !task.pr && this.taskDiff?.taskId === task.id && Boolean(this.taskDiff.result);
    const diff = filesShown ? null : button(t, "task-diff", keyed("d", "See the diff"), () => this.seeDiff(task),
      { kind: waiting ? "solid" : "ghost", tip: task.worktree ? "Opens the change in the review pane beside the panel" : "Opens the run window on this task's result and diff" });
    const retry = canTryAgain(task), picks = waiting || retry ? this.picksOf(task) : new Map(), all = retry ? taskNotes(task).findings.length : 0;
    const retryPlan = { head: picks.size ? `${picks.size} to fix` : all ? `All ${all} ${all === 1 ? "finding" : "findings"} to fix` : "Try again",
      hint: "One more try in its worktree: write, then review.", send: "Try again", run: (cx) => this.tryAgain(cx) };
    if (editing) return v_flex().id("task-decision").px(8).pt(8).gap(6)
      .when(picks.size > 0, (el) => el.child(div().id("task-changes-picks").text_size(11).text_color(t.done).child(`With the ${picks.size} marked to fix`)))
      .child(Textarea.new(this.runChange).id("task-changes-field").w_full().min_w(0).accessibility_label("What should change?")
        .h(64).px(7).rounded(5).border(1).border_color(t.border).bg(t.background))
      .child(div().text_size(11).text_color(t.muted).child(plan.hint))
      .child(h_flex().gap(6)
        .child(button(t, "task-send-changes", plan.send, (cx) => this.sendRunChanges(cx),
          { kind: "solid", disabled: Boolean(this.runBusy) || !this.runChange.value().trim(), tip: "⌘Enter" }))
        .child(button(t, "task-changes-cancel", "Cancel", (cx) => { this.cancelRunChanges(); cx.notify(); }, { kind: "ghost", disabled: Boolean(this.runBusy) })));
    if (task.pr) return this.prReviewDecision(t, goal, task, tasks, keyed, confirming, diff, more);
    const effect = `${task.worktree?.prHead ? `Accepting commits to the run branch and pushes it onto ${task.worktree.prHead}, never forced. `
      : draftOnAccept(task, config.RUN_DRAFT_PR !== false) ? "Accepting commits to the run branch, pushes it and opens a draft pull request on GitHub. "
      : task.worktree ? "Accepting keeps the worktree and commits to its run branch. " : ""}${acceptanceEffect(task, tasks, this.workflowEngine)}`;
    const push = task.state === "accepted" && task.worktree?.prHead && !task.worktree.pushed && !task.worktree.removed;
    return v_flex().id("task-decision").px(8).pt(8).gap(6)
      .when(picks.size > 0 || retry, (el) => el.child(this.picksBar(t, task, picks.size, retry ? retryPlan : plan)))
      .child(h_flex().flex_wrap().gap(6).items_center()
        .when(waiting, (bar) => bar
          .child(button(t, "task-accept", confirming ? keyed("enter", "Confirm accept") : keyed("a", task.worktree?.prHead ? `Accept and push to ${task.worktree.prHead}` : draftOnAccept(task, config.RUN_DRAFT_PR !== false) ? "Accept and open draft PR" : "Accept"), (cx) => this.acceptStep(task, cx),
            { kind: "accent", disabled: Boolean(this.runBusy), tip: "A, then Enter" }))
          .child(button(t, "task-changes", keyed("r", "Ask for changes"), (cx) => this.askRunChanges(task, cx), { disabled: Boolean(this.runBusy) }))
          .when(Boolean(diff), (b) => b.child(diff)))
        .when(followUpAvailable(task), (bar) => bar.child(this.followUpButton(t, goal, task, "task-follow-up")))
        .when(Boolean(push), (bar) => bar.child(button(t, "task-push", `Push to ${task.worktree?.prHead}`, (cx) => this.pushRun(task, cx),
          { kind: "go", disabled: Boolean(this.runBusy), tip: "Adds the accepted commit to the pull request's branch on GitHub; never forced" })))
        .when(["accepted", "cancelled"].includes(task.state), (bar) => bar.child(button(t, "task-rerun", "Re-run with changes…",
          () => openWorkflow(goal.id, task.id, { followUp: "rerun" }), { tip: "Opens a new task with this one's prompt in the run window; nothing is sent until you start it" })))
        .when(canCompare(task), (bar) => bar.child(this.compareButton(t, task, "task-compare")))
        .when(!waiting && Boolean(diff), (bar) => bar.child(diff)).child(div().flex_1()).child(more))
      .when(waiting, (el) => el.child(div().id("task-effect").min_w(0).text_size(11).text_color(t.muted).child(effect)));
  }
}
