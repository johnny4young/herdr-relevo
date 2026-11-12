import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { run, exec, shared, setShared, readTextFile, appHome } from "herdr";
import { accountFor, inFocus } from "./context.js";
import { button, sectionHeader } from "./ui.js";
import { openGoal } from "./goals-editor.js";
import { readGoals, GOALS_CHANGED } from "./goals-store.js";
import { emptyGoals, groupSources, sourceKey } from "./lib/goals.js";
import { isAddressed } from "./lib/addressed.js";
import { openReview } from "./review.js";
import { reviewableWork, scopeGoals, runNextAction, linkedDecision, runProgress } from "./lib/goal-workflow.js";
import { openWorkflow } from "./workflow.js";
import { resultMeta } from "./lib/workflow-navigation.js";

export const GOAL_MODE = "relevo.goals.mode";
export const GOAL_SCOPE = "relevo.goals.scope";
const line = (s, t, attention = false) => div().text_size(11).text_color(attention ? t.blocked : t.muted).child(s);

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
        if (quiet && rev != null && this.goalPolls % 10 !== 0) { this.goalsLoading = false; return; }
        this.goalDoc = goals.doc;
        try {
          const raw = await readTextFile(`${appHome()}/relevo-workflow/state.json`);
          if (quiet && raw === this.workflowRaw) { this.goalsLoading = false; return; }
          this.workflowRaw = raw;
          const workflow = raw ? JSON.parse(raw) : { tasks: [], engine: { enabled: false } };
          if (!Array.isArray(workflow.tasks)) throw Error('Invalid task state');
          this.workflowTasks = workflow.tasks;
          this.workflowEngine = workflow.engine;
          this.workflowError = null; this.goalsKey = key;
        } catch { this.workflowError = "Workflow status unavailable; open Workflow to retry."; }
        this.goalsError = null;
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

  goalNav(sources) {
    return sources.map((s) => s.kind === "goal" ? { id: `goal-${s.goal.id}`, section: "goals", go: () => this.openRunAction(s.goal) }
      : s.kind === "pr" ? { id: `pr-${s.pr.url}`, section: "goals", go: () => s.draft ? exec("open", [s.pr.url]) : this.runPR(s.pr) }
      : { id: `in-${s.item.agent.address}`, section: "goals", go: () => s.item.kind === "blocked"
        ? run("agent.focus", { terminal: s.item.agent.address }) : openReview(s.item.top, s.item.agent.address),
      choose: (n, cx) => {
        const drawn = s.item.prompt, option = drawn?.options.find((o) => o.n === n);
        if (s.item.kind === "blocked" && option) this.answer(s.item.agent, option, cx, drawn);
      } });
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
    if (key === "g" && runMode) { this.nextGoal(cx); return true; }
    if (key === "?") {
      this.goalHelp = !this.goalHelp;
      if (this.goalHelp) this.shortcutHelp?.focus();
      else this.h.focus();
      return true;
    }
    const group = runMode && this.goalProjection?.groups.find((g) => `goal-${g.goal.id}` === this.sel);
    if (key === "f" && runMode && (group || this.goalProjection?.scope)) {
      this.focusGoal(this.goalProjection.scope ? null : group.goal.id, cx); return true;
    }
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

  focusGoal(id, cx) {
    setShared(GOAL_SCOPE, id); this.sel = id ? `goal-${id}` : null;
    this.h.focus(); cx.notify();
  }

  reviewGoal(items) {
    const source = reviewableWork(items, this.clones)[0];
    if (source?.kind === "pr") this.reviewPR(source.pr);
    else if (source) openReview(source.item.top, source.item.agent.address);
  }

  openRunAction(goal) {
    const items = this.goalProjection?.groups.find((group) => group.goal.id === goal.id)?.items ?? [];
    const action = runNextAction(goal, this.workflowTasks ?? [], this.workflowEngine, this.workflowError, reviewableWork(items, this.clones).length);
    if (action.action === 'review' || action.action === 'decision' || (!this.workflowError && (this.workflowTasks ?? []).some((task) => task.goalId === goal.id && task.state === 'needs_you'))) this.showRunReviews(goal);
    else openWorkflow(goal.id);
  }

  runReviews() {
    if (this.workflowError) return [];
    return (this.workflowTasks ?? []).filter((task) => task.state === "needs_you").map((task) => ({
      id: `result-${task.id}`, title: task.title, detail: this.goalDoc?.goals.find((goal) => goal.id === task.goalId)?.title ?? "Run result", meta: resultMeta(task),
      go: () => openWorkflow(task.goalId, task.id),
    }));
  }

  decisionReviews() {
    return (this.goalDoc?.goals ?? []).filter((goal) => goal.decision?.trim() && linkedDecision(goal, this.workflowTasks ?? [], this.workflowError).state === "separate").map((goal) => ({
      id: `decision-${goal.id}`, title: goal.decision.trim(), detail: goal.title,
      go: () => openGoal(goal.id, null, "decision"),
    }));
  }

  linkedReviews(v) {
    const listed = new Set([...(v.requested ?? []), ...(v.mine ?? []), ...(v.ready ?? []),
      ...(v.requestedDone ?? []), ...(v.mineDone ?? []), ...(this.drafts ?? [])].map((pr) => pr.url));
    return this.goalSources(v).filter((source) => source.kind === "pr" && !listed.has(source.pr.url));
  }

  linkedReviewRows(t, v) {
    const sources = this.linkedReviews(v);
    if (!sources.length) return [];
    return [sectionHeader(t, "LINKED WORK", sources.filter((source) => !source.addressed).length),
      ...sources.filter((source) => !source.addressed).map((source) => source.draft ? this.draftCard(t, source.pr) : this.prCard(t, source.pr, false)),
      ...this.addressedFold(t, "linked", sources.filter((source) => source.addressed), (source) => this.prCard(t, source.pr, false, true)),
    ];
  }

  reviewEntries() { return [...this.runReviews(), ...this.decisionReviews()]; }

  showRunReviews(goal) {
    const task = !this.workflowError && (this.workflowTasks ?? []).find((task) => task.goalId === goal.id && task.state === "needs_you");
    const result = this.runReviews().find((entry) => entry.id === `result-${task?.id}`);
    const decision = this.decisionReviews().find((entry) => entry.id === `decision-${goal.id}`);
    const source = this.goalSources(this.shown()).find((source) => goal.sources.includes(source.key) && !source.addressed && !source.draft);
    if (!result && !decision && source?.kind === "pr") {
      this.expanded[source.requested ? "requested" : "mine"] = true;
      if ((this.ready ?? []).some((pr) => pr.url === source.pr.url)) this.expanded["mine-ready"] = true;
    }
    this.sel = result?.id ?? (decision ? decision.id : source ? source.kind === "pr" ? `pr-${source.pr.url}` : `in-${source.item.agent.address}` : null);
    setShared(GOAL_MODE, false); this.h.focus();
  }

  runReviewRows(t) {
    const entries = this.reviewEntries();
    return [
      ...(this.workflowError ? [line(this.workflowError, t, true)] : []),
      ...(entries.length ? [sectionHeader(t, "READY FOR YOU", entries.length)] : []),
      ...entries.filter((entry) => !this.hiddenIds.has(entry.id)).map((entry) => this.card(t, entry.id, false,
        div().text_size(11).text_color(t.muted).truncate().tooltip(entry.detail).child(entry.detail),
        v_flex().gap(3).child(div().text_size(13).font_semibold().child(entry.title))
          .when(Boolean(entry.meta), (el) => el.child(div().id(`meta-${entry.id}`).text_size(11).text_color(t.muted).truncate().tooltip(entry.meta).child(entry.meta))),
        [button(t, `open-${entry.id}`, entry.id.startsWith("result-") ? "Review result" : "Review decision", entry.go,
          { kind: this.selected(entry.id) ? "solid" : "outline" })])),
    ];
  }

  sourceContextButton(t, key) {
    const source = this.goalSources(this.shown()).find((source) => source.key === key);
    if (!source) return null;
    const goal = this.goalDoc?.goals.find((goal) => goal.sources.includes(key));
    return button(t, `source-link-${key}`, goal ? "Open run" : "Link run", () => openGoal(goal?.id ?? null, source), { size: "sm" });
  }

  goalNewButton(t) {
    return button(t, "goal-new", "+ Run", () => openGoal(), { size: "sm", tip: "Write a prompt, choose agents, then start when ready" });
  }

  projectGoals(v) {
    const sources = this.goalSources(v);
    const scoped = scopeGoals({ sources, ...groupSources(this.goalDoc ?? emptyGoals(), sources) }, shared(GOAL_SCOPE));
    const { groups, unlinked } = scoped;
    const waiting = unlinked.filter((s) => s.blocked), other = unlinked.filter((s) => !s.blocked);
    return { ...scoped, sources, groups, waiting, other, ordered: groups.map((g) => ({ kind: "goal", goal: g.goal })) };
  }

  goalViewport() {
    const at = this.nav.findIndex((n) => n.id === this.sel);
    const above = this.keyboard && at > 1 ? at - 1 : 0;
    return { hidden: new Set(this.nav.slice(0, above).map((n) => n.id)), sections: new Set(), above };
  }

  goalsGroup(t) {
    const { groups, scope, outsideCount, outsideBlockers } = this.goalProjection;
    return [
      ...(scope ? [(this.narrowInbox ? v_flex() : h_flex()).w_full().min_w(0).gap(5)
        .child(button(t, "goal-all-work", "← All runs", (cx) => this.focusGoal(null, cx), { size: "sm", tip: "F: show all runs" }))
        .when(!this.narrowInbox, (el) => el.child(div().flex_1()))
        .when(outsideBlockers > 0, (el) => el.child(line(`${outsideBlockers} need attention elsewhere`, t, true)
          .min_w(0).tooltip(`${outsideCount} other items outside this run`)))]
        : []),
      ...(this.goalsError ? [div().text_size(11).text_color(t.blocked).child(this.goalsError)] : []),
      ...groups.filter((g) => !this.hiddenIds.has(`goal-${g.goal.id}`)).map(({ goal, items, urgency }) => {
        const tasks = (this.workflowTasks ?? []).filter((task) => task.goalId === goal.id);
        const reviewable = reviewableWork(items, this.clones);
        const next = runNextAction(goal, tasks, this.workflowEngine, this.workflowError, reviewable.length);
        const progress = runProgress(goal.id, tasks, this.workflowEngine, this.workflowError);
        const status = next.status;
        const inReviews = next.action === "review" || next.action === "decision" || (!this.workflowError && tasks.some((task) => task.state === "needs_you"));
        const actionLabel = inReviews ? "View in Reviews" : next.label;
        return v_flex().id(`goal-${goal.id}`).w_full().min_w(0).p(6).gap(4).rounded(8).bg(t.background).border_1().border_color(this.selected(`goal-${goal.id}`) ? t.accent : urgency === 0 ? t.blocked : t.border)
          .child(h_flex().gap(5).items_center().child(div().flex_1().min_w(0).text_size(13).font_semibold().child(goal.title))
            .child(button(t, `goal-edit-${goal.id}`, "Edit", () => openGoal(goal.id), { kind: "ghost", size: "sm", tip: "E · F focuses this run" })))
          .child(h_flex().id(`goal-next-row-${goal.id}`).min_w(0).gap(8).p(6).items_center().rounded(6).bg(t.raised)
            .child(v_flex().id(`goal-next-copy-${goal.id}`).flex_1().min_w(0).gap(2)
              .child(div().id(`goal-next-status-${goal.id}`).min_w(0).text_size(11).font_semibold().text_color(["Needs attention", "Status unavailable"].includes(next.status) ? t.blocked : t.accent).truncate().tooltip(status).child(status))
              .child(div().id(`goal-next-detail-${goal.id}`).min_w(0).text_size(13).truncate().tooltip(next.detail).child(next.detail)))
            .child(button(t, next.action === 'review' ? `goal-review-next-${goal.id}` : next.action === 'decision' ? `goal-decision-next-${goal.id}` : `goal-workflow-${goal.id}`, actionLabel, () => this.openRunAction(goal),
              { kind: this.selected(`goal-${goal.id}`) ? "solid" : "outline" })))
          .when(Boolean(progress), (el) => el.child(div().id(`goal-progress-${goal.id}`).text_size(11).text_color(t.muted)
            .child(progress)));
      }),
      ...(!groups.length ? [line("No runs yet", t)] : []),
    ];
  }
}
