import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { shared, setShared, readTextFile, appHome } from "herdr";
import { runtimeCommand } from "./runtime-cli.js";
import { accountFor, inFocus } from "./context.js";
import { button } from "./ui.js";
import { openGoal } from "./goals-editor.js";
import { readGoals, writeGoal, GOALS_CHANGED } from "./goals-store.js";
import { emptyGoals, groupSources, sourceKey, closeGoal, goalState } from "./lib/goals.js";
import { isAddressed } from "./lib/addressed.js";
import { runResultAlerts } from "./alerts.js";
import { resultMark } from "./lib/run-alerts.js";
import { openReview } from "./review.js";
import { reviewableWork, scopeGoals, linkedDecision } from "./lib/goal-workflow.js";
import { openWorkflow } from "./workflow.js";
import { resultMeta } from "./lib/workflow-navigation.js";

export const GOAL_MODE = "relevo.goals.mode";
export const GOAL_SCOPE = "relevo.goals.scope";
// A mark hides a review until its task returns a new revision or the question changes.
const textKey = (s) => [...s].reduce((h, c) => (h * 31 + c.codePointAt(0)) >>> 0, 7).toString(36);
export const workflowCommand = async (payload) => {
  const result = await runtimeCommand(payload);
  let response = {};
  try { response = JSON.parse(result.stdout || result.stderr || "{}"); } catch { /* reported below */ }
  if (response.error || result.code !== 0) throw Error(response.error || result.stderr || "Workflow command failed");
  return response;
};

export class GoalViews {
  startGoals(cx) {
    this.goalDoc = emptyGoals();
    this.loadGoals(cx);
    // A bounded local metadata read also catches edits by an external lead agent.
    cx.timer.every(5000, (cx) => { this.loadGoals(cx); });
  }

  loadGoals(cx) {
    if (this.goalsLoading) return;
    this.goalsLoading = true;
    cx.spawn(async (cx) => {
      try {
        // Nothing is parsed or redrawn while neither file moved; every tenth poll reads the state regardless.
        const [goals, rev] = await Promise.all([readGoals(), readTextFile(`${appHome()}/relevo-workflow/state.rev`).catch(() => null)]);
        this.goalPolls = (this.goalPolls ?? 0) + 1;
        const key = `${rev}\0${goals.raw}`;
        const quiet = key === this.goalsKey && !this.goalsError && !this.workflowError && this.goalChange === shared(GOALS_CHANGED);
        // A merge can land while nothing else moves, so it is remembered on quiet polls too.
        if (quiet && rev != null && this.goalPolls % 10 !== 0) { this.workflowAt = Date.now() / 1000; this.rememberMerged(); this.goalsLoading = false; return; }
        this.goalDoc = goals.doc;
        try {
          const raw = await readTextFile(`${appHome()}/relevo-workflow/state.json`);
          if (quiet && raw === this.workflowRaw) { this.workflowAt = Date.now() / 1000; this.rememberMerged(); this.goalsLoading = false; return; }
          this.workflowRaw = raw;
          const workflow = raw ? JSON.parse(raw) : { tasks: [], engine: { enabled: false } };
          if (!Array.isArray(workflow.tasks)) throw Error('Invalid task state');
          this.workflowTasks = workflow.tasks;
          this.workflowEngine = workflow.engine;
          this.workflowError = null; this.goalsKey = key; this.workflowAt = Date.now() / 1000;
        } catch { this.workflowError = "Workflow status unavailable."; }
        this.goalsError = null;
        if (!this.workflowError) {
          this.pruneReviewMarks();
          this.rememberMerged();
          runResultAlerts(this.workflowTasks);
        }
      } catch (e) { this.goalsError = `Runs: ${e.message ?? e}. Reviews is still available.`; }
      this.goalChange = shared(GOALS_CHANGED);
      this.goalsLoading = false;
      cx.notify();
    });
  }

  refreshGoals(cx) {
    if (this.goalChange !== shared(GOALS_CHANGED)) this.loadGoals(cx);
  }

  goalSources(v) {
    const sources = [];
    for (const [list, requested, addressed, draft] of [[v.requested, true], [v.mine, false], [v.ready, false],
      [(this.drafts ?? []).filter((p) => inFocus(accountFor(p.repo))), false, false, true],
      [v.requestedDone ?? [], true, true], [v.mineDone ?? [], false, true]]) {
      for (const pr of list) sources.push({ key: sourceKey("pr", pr.url), title: `${pr.repo} #${pr.number} · ${pr.title}`,
        revision: pr.headRefOid ?? null, blocked: !addressed && Boolean(pr.hot || pr.mergeable === "CONFLICTING"), kind: "pr", pr, requested, addressed: Boolean(addressed), draft: Boolean(draft || pr.isDraft) });
    }
    const linked = new Set((this.goalDoc?.goals ?? []).flatMap((g) => g.sources));
    for (const pr of this.openPRs ?? []) {
      const key = sourceKey("pr", pr.url);
      if (!linked.has(key) || sources.some((s) => s.key === key) || !inFocus(accountFor(pr.repo))) continue;
      sources.push({ key, title: `${pr.repo} #${pr.number} · ${pr.title}`, revision: pr.headRefOid ?? null,
        blocked: false, kind: "pr", requested: false, draft: Boolean(pr.isDraft), addressed: isAddressed(pr, this.addressed),
        pr: { ...pr, reasons: [pr.isDraft ? "draft" : "linked objective"], skills: [], threads: 0, hot: false } });
    }
    for (const [list, addressed] of [[v.local, false], [v.localDone ?? [], true]]) {
      for (const item of list) sources.push({ key: sourceKey("local", item.kind === "blocked" ? `agent:${item.agent.address}` : item.top || item.agent.address), title: item.agent.tab_name || item.top || item.agent.address,
        revision: null, blocked: item.kind === "blocked", kind: "local", item, addressed });
    }
    const unique = new Map();
    for (const source of sources) if (!unique.has(source.key)) unique.set(source.key, source);
    return [...unique.values()];
  }

  nextGoal(cx) {
    const goals = (this.nav ?? []).filter((n) => n.id.startsWith("goal-"));
    if (!goals.length) return;
    const at = goals.findIndex((n) => n.id === this.sel);
    this.sel = goals[(at + 1) % goals.length].id;
    this.h.focus(); cx.notify();
  }

  goalAction(key, cx) {
    const runMode = shared(GOAL_MODE) === true;
    if (key === "?") {
      this.goalHelp = !this.goalHelp;
      if (this.goalHelp) this.shortcutHelp?.focus();
      else this.h.focus();
      return true;
    }
    // An open run has its own keys; the list's shortcuts wait until it closes.
    if (runMode && this.goalProjection?.scope) return false;
    if (key === "g" && runMode) { this.nextGoal(cx); return true; }
    const group = runMode && this.goalProjection?.groups.find((g) => `goal-${g.goal.id}` === this.sel);
    if (key === "f" && group) { this.openRun(group.goal, cx); return true; }
    if (key === "r" && group) { this.showRunReviews(group.goal); return true; }
    if (key === "w" && group) { openWorkflow(group.goal.id); return true; }
    const source = this.goalProjection?.sources.find((s) => (s.kind === "pr" ? `pr-${s.pr.url}` : `in-${s.item.agent.address}`) === this.sel);
    if (key === "e" && (group || source)) {
      const goal = group?.goal ?? this.goalDoc.goals.find((g) => g.sources.includes(source.key));
      openGoal(goal?.id ?? null, source ?? null); return true;
    }
    if (key === "s" && source?.kind === "pr") { this.openSkillMenu(source.pr); return true; }
    if (key === "r" && source) {
      if (source.kind === "pr" && this.clones[source.pr.repo]) this.reviewPR(source.pr);
      else if (source.kind === "local" && source.item.kind === "diff") openReview(source.item.top, source.item.agent.address);
      return true;
    }
    return false;
  }

  reviewGoal(items) {
    const source = reviewableWork(items, this.clones)[0];
    if (source?.kind === "pr") this.reviewPR(source.pr);
    else if (source) openReview(source.item.top, source.item.agent.address);
  }

  runReviews() {
    if (this.workflowError) return [];
    return (this.workflowTasks ?? []).filter((task) => task.state === "needs_you").map((task) => ({
      id: `result-${task.id}`, mark: `review:result-${resultMark(task)}`, title: task.title, detail: this.goalDoc?.goals.find((goal) => goal.id === task.goalId)?.title ?? "Run result", meta: resultMeta(task),
      go: () => this.showResult(task),
    }));
  }

  decisionReviews() {
    return (this.goalDoc?.goals ?? []).filter((goal) => goal.decision?.trim() && linkedDecision(goal, this.workflowTasks ?? [], this.workflowError).state === "separate").map((goal) => ({
      id: `decision-${goal.id}`, mark: `review:decision-${goal.id}@${textKey(goal.decision.trim())}`, title: goal.decision.trim(), detail: goal.title,
      go: () => openGoal(goal.id, null, "decision"),
    }));
  }

  linkedReviews(v) {
    const listed = new Set([...(v.requested ?? []), ...(v.mine ?? []), ...(v.ready ?? []),
      ...(v.requestedDone ?? []), ...(v.mineDone ?? []), ...(this.drafts ?? [])].map((pr) => pr.url));
    return this.goalSources(v).filter((source) => source.kind === "pr" && !listed.has(source.pr.url));
  }

  reviewEntries() { return [...this.runReviews(), ...this.decisionReviews()]; }
  openReviews() { return this.reviewEntries().filter((entry) => !this.addressed?.[entry.mark]); }
  doneReviews() { return this.reviewEntries().filter((entry) => this.addressed?.[entry.mark]); }

  setReviewAddressed(entry, on, cx) {
    const next = { ...this.addressed };
    if (on) next[entry.mark] = Math.ceil(Date.now() / 1000);
    else delete next[entry.mark];
    this.saveAddressed(next);
    this.publish();
    cx.notify();
  }

  pruneReviewMarks() {
    const live = new Set(this.reviewEntries().map((entry) => entry.mark));
    const marks = Object.fromEntries(Object.entries(this.addressed ?? {}).filter(([key]) => !key.startsWith("review:") || live.has(key)));
    if (Object.keys(marks).length !== Object.keys(this.addressed ?? {}).length) this.saveAddressed(marks);
  }

  showRunReviews(goal) {
    const task = !this.workflowError && (this.workflowTasks ?? []).find((task) => task.goalId === goal.id && task.state === "needs_you");
    const result = this.runReviews().find((entry) => entry.id === `result-${task?.id}`);
    const decision = this.decisionReviews().find((entry) => entry.id === `decision-${goal.id}`);
    const source = this.goalSources(this.shown()).find((source) => goal.sources.includes(source.key) && !source.addressed && !source.draft);
    const id = result?.id ?? (decision ? decision.id : source ? source.kind === "pr" ? `pr-${source.pr.url}` : `in-${source.item.agent.address}` : null);
    setShared(GOAL_MODE, false);
    if (id) this.reveal(id);
    this.h.focus();
  }

  // What a run result or a decision row can do, for its buttons, its keys and its keycaps alike.
  reviewActions(entry, addressed = false) {
    const result = entry.id.startsWith("result-");
    return {
      main: { id: `open-${entry.id}`, label: result ? "Review result" : "Review decision", run: entry.go, kind: "go" },
      mark: this.markAction(entry.id, addressed, (on, cx) => this.setReviewAddressed(entry, on, cx), "Hide until it changes. Nothing is accepted."),
    };
  }

  // A run result or a decision that waits on you.
  reviewRow(t, entry, addressed = false) {
    const result = entry.id.startsWith("result-");
    return this.item(t, entry.id, {
      turn: "me", done: addressed, kind: result ? "relay" : "comment", title: entry.title, reason: result ? "result ready" : "your decision", tip: entry.detail,
      lines: [
        div().text_size(11).text_color(t.muted).truncate().child(entry.detail),
        entry.meta ? div().id(`meta-${entry.id}`).text_size(11).text_color(t.muted).truncate().tooltip(entry.meta).child(entry.meta) : null,
      ],
      ...this.reviewActions(entry, addressed),
    });
  }

  sourceContextAction(key) {
    const source = this.goalSources(this.shown()).find((source) => source.key === key);
    if (!source) return null;
    const goal = this.goalDoc?.goals.find((goal) => goal.sources.includes(key));
    return { id: `source-link-${key}`, label: goal ? "Open run" : "Link run", run: () => openGoal(goal?.id ?? null, source), size: "sm" };
  }

  projectGoals(v) {
    const sources = this.goalSources(v);
    const scoped = scopeGoals({ sources, ...groupSources(this.goalDoc ?? emptyGoals(), sources) }, shared(GOAL_SCOPE));
    return { ...scoped, sources };
  }

  goalViewport() {
    const at = this.nav.findIndex((n) => n.id === this.sel);
    const above = this.keyboard && at > 1 ? at - 1 : 0;
    return { hidden: new Set(this.nav.slice(0, above).map((n) => n.id)), sections: new Set(), above };
  }

  openTasks(goalId) {
    return (this.workflowTasks ?? []).filter((task) => task.goalId === goalId && !["accepted", "cancelled"].includes(task.state));
  }

  closeRun(goal, cx) {
    if (this.closingRun) return;
    this.closingRun = goal.id; this.runCloseError = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        for (const task of this.openTasks(goal.id)) await workflowCommand({ action: "cancel", taskId: task.id });
        const current = (await readGoals()).doc.goals.find((item) => item.id === goal.id);
        if (current && goalState(current) !== "completed") await writeGoal(closeGoal(current), current.version, { close: true });
        this.confirmClose = null;
      } catch (e) { this.runCloseError = `Could not close the run: ${e.message ?? e}`; }
      this.closingRun = null;
      this.loadGoals(cx);
      cx.notify();
    });
  }

  closeConfirm(t, goal) {
    const open = this.openTasks(goal.id).length, busy = this.closingRun === goal.id;
    return h_flex().id(`goal-close-confirm-${goal.id}`).flex_wrap().gap(6).items_center().role("alert")
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.blocked)
        .child(open ? `Cancel ${open} open ${open === 1 ? "task" : "tasks"} and close this run?` : "Close this run?"))
      .child(button(t, `goal-close-keep-${goal.id}`, "Keep", (cx) => { this.confirmClose = null; cx.notify(); }, { size: "sm", disabled: busy }))
      .child(button(t, `goal-close-yes-${goal.id}`, busy ? "Closing…" : "Close run", (cx) => this.closeRun(goal, cx), { kind: "solid", size: "sm", disabled: busy }));
  }
}
