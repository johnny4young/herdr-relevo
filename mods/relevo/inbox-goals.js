import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { run, exec, shared, setShared, readTextFile, appHome } from "herdr";
import { accountFor, inFocus } from "./context.js";
import { button, sectionHeader, foldRow } from "./ui.js";
import { openGoal } from "./goals-editor.js";
import { readGoals, GOALS_CHANGED } from "./goals-store.js";
import { emptyGoals, groupSources, sourceKey } from "./lib/goals.js";
import { isAddressed } from "./lib/addressed.js";
import { openReview } from "./review.js";
import { reviewableWork, scopeGoals, missionNextAction } from "./lib/goal-workflow.js";
import { openWorkflow } from "./workflow.js";

export const GOAL_MODE = "relevo.goals.mode";
export const GOAL_SCOPE = "relevo.goals.scope";
const line = (s, t, attention = false) => div().text_size(11).text_color(attention ? t.blocked : t.muted).child(s);
const missionFold = (view, t, id, key, label) => foldRow(view, t, id, key, label).w_full().justify_start().text_left();

export class GoalViews {
  startGoals(cx) {
    this.goalDoc = emptyGoals();
    this.loadGoals(cx);
    // A bounded local metadata read also catches edits by an external lead agent.
    cx.timer.every(5000, (cx) => { if (shared(GOAL_MODE) === true) this.loadGoals(cx); });
  }

  loadGoals(cx) {
    if (this.goalsLoading) return;
    this.goalsLoading = true;
    cx.spawn(async (cx) => {
      try {
        this.goalDoc = (await readGoals()).doc;
        try {
          const raw = await readTextFile(`${appHome()}/relevo-workflow/state.json`);
          const workflow = raw ? JSON.parse(raw) : { tasks: [], engine: { enabled: false } };
          if (!Array.isArray(workflow.tasks)) throw Error('Invalid task state');
          this.workflowTasks = workflow.tasks;
          this.workflowEngine = workflow.engine;
          this.workflowError = null;
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
    return sources.map((s) => s.kind === "goal" ? { id: `goal-${s.goal.id}`, section: "goals", go: () => this.openMissionAction(s.goal) }
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
    if (shared(GOAL_MODE) !== true) return false;
    if (key === "g") { this.nextGoal(cx); return true; }
    if (key === "?") {
      this.goalHelp = !this.goalHelp;
      if (this.goalHelp) this.shortcutHelp?.focus();
      else this.h.focus();
      return true;
    }
    const group = this.goalProjection?.groups.find((g) => `goal-${g.goal.id}` === this.sel);
    if (key === "f" && (group || this.goalProjection?.scope)) {
      this.focusGoal(this.goalProjection.scope ? null : group.goal.id, cx); return true;
    }
    if (key === "r" && group) { this.reviewGoal(group.items); return true; }
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

  openMissionAction(goal) {
    const items = this.goalProjection?.groups.find((group) => group.goal.id === goal.id)?.items ?? [];
    const action = missionNextAction(goal, this.workflowTasks ?? [], this.workflowEngine, this.workflowError, reviewableWork(items, this.clones).length);
    if (action.action === 'review') this.reviewGoal(items);
    else if (action.action === 'decision') openGoal(goal.id);
    else openWorkflow(goal.id);
  }

  goalNewButton(t) {
    return button(t, "goal-new", "+ Run", () => openGoal(), { size: "sm", tip: "Write a prompt, choose agents, then start when ready" });
  }

  sourceCard(t, source, goal = null) {
    return v_flex().id(`source-${source.key}`).gap(4)
      .child(source.kind === "pr" ? source.draft ? this.draftCard(t, source.pr) : this.prCard(t, source.pr, source.requested, source.addressed) : this.localCard(t, source.item, source.addressed))
      .child(h_flex().flex_wrap().gap(5).justify_end()
        .when(source.kind === "pr", (el) => el.child(button(t, `source-skills-${source.key}`, "Skills…", () => this.openSkillMenu(source.pr),
          { size: "sm", disabled: !this.clones[source.pr.repo], tip: this.clones[source.pr.repo] ? "S on this card: choose a skill and account before running" : "Clone this repository to run its skills" })))
        .child(button(t, `source-link-${source.key}`, goal ? "Context / evidence" : "Link run", () => openGoal(goal?.id ?? null, source), { size: "sm", tip: "E on this card: edit context, record feedback or attach evidence; no message is sent" })));
  }

  projectGoals(v) {
    const sources = this.goalSources(v);
    const scoped = scopeGoals({ sources, ...groupSources(this.goalDoc ?? emptyGoals(), sources) }, shared(GOAL_SCOPE));
    const { groups, unlinked } = scoped;
    const waiting = unlinked.filter((s) => s.blocked), other = unlinked.filter((s) => !s.blocked);
    return { ...scoped, sources, groups, waiting, other, ordered: [...waiting,
      ...groups.flatMap((g) => [{ kind: "goal", goal: g.goal }, ...this.goalVisibleSources(g.goal.id, g.items)]), ...this.goalVisibleSources("unlinked", other)] };
  }

  goalVisibleSources(id, items) {
    return [...items.filter((s) => !s.addressed && !s.draft),
      ...(this.expanded[`goal-${id}-drafts`] ? items.filter((s) => s.draft && !s.addressed) : []),
      ...(this.expanded[`goal-${id}-done`] ? items.filter((s) => s.addressed) : [])];
  }

  goalSourceRows(t, id, items, goal = null) {
    const visible = (s) => !this.hiddenIds.has(s.kind === "pr" ? `pr-${s.pr.url}` : `in-${s.item.agent.address}`);
    const drafts = items.filter((s) => s.draft && !s.addressed), done = items.filter((s) => s.addressed);
    return [
      ...items.filter((s) => !s.draft && !s.addressed && visible(s)).map((s) => this.sourceCard(t, s, goal)),
      ...(drafts.length ? [missionFold(this, t, `goal-drafts-${id}`, `goal-${id}-drafts`, `${drafts.length} draft(s)`),
        ...(this.expanded[`goal-${id}-drafts`] ? drafts.filter(visible).map((s) => this.sourceCard(t, s, goal)) : [])] : []),
      ...(done.length ? [missionFold(this, t, `goal-addressed-${id}`, `goal-${id}-done`, `${done.length} addressed · not necessarily completed`),
        ...(this.expanded[`goal-${id}-done`] ? done.filter(visible).map((s) => this.sourceCard(t, s, goal)) : [])] : []),
    ];
  }

  goalViewport() {
    const at = this.nav.findIndex((n) => n.id === this.sel);
    const above = this.keyboard && at > 1 ? at - 1 : 0;
    return { hidden: new Set(this.nav.slice(0, above).map((n) => n.id)), sections: new Set(), above };
  }

  goalsGroup(t) {
    const { groups, waiting, other, scope, outsideCount, outsideBlockers } = this.goalProjection;
    const visible = (s) => !this.hiddenIds.has(s.kind === "pr" ? `pr-${s.pr.url}` : `in-${s.item.agent.address}`);
    return [
      ...(scope ? [(this.narrowInbox ? v_flex() : h_flex()).w_full().min_w(0).gap(5)
        .child(button(t, "goal-all-work", "← All runs", (cx) => this.focusGoal(null, cx), { size: "sm", tip: "F: show all runs and unlinked work" }))
        .when(!this.narrowInbox, (el) => el.child(div().flex_1()))
        .when(outsideBlockers > 0, (el) => el.child(line(`${outsideBlockers} need attention elsewhere`, t, true)
          .min_w(0).tooltip(`${outsideCount} other items outside this run`)))]
        : [line("Start a run, then review its work.", t)]),
      ...(this.goalsError ? [div().text_size(11).text_color(t.blocked).child(this.goalsError)] : []),
      ...(waiting.length ? [sectionHeader(t, "UNLINKED BLOCKERS", waiting.length), ...waiting.filter(visible).map((s) => this.sourceCard(t, s))] : []),
      ...groups.filter((g) => !this.hiddenIds.has(`goal-${g.goal.id}`) || this.goalVisibleSources(g.goal.id, g.items).some(visible)).map(({ goal, items, urgency }) => {
        const tasks = (this.workflowTasks ?? []).filter((task) => task.goalId === goal.id);
        const reviewable = reviewableWork(items, this.clones);
        const next = missionNextAction(goal, tasks, this.workflowEngine, this.workflowError, reviewable.length);
        const status = next.status.replace(/\bMission\b/g, "Run");
        const actionLabel = next.label.replace(/\bmission\b/gi, "run");
        return v_flex().id(`goal-${goal.id}`).w_full().min_w(0).p(6).gap(4).rounded(8).bg(t.background).border_1().border_color(this.selected(`goal-${goal.id}`) ? t.accent : urgency === 0 ? t.blocked : t.border)
          .child(h_flex().gap(5).items_center().child(div().flex_1().min_w(0).text_size(13).font_semibold().child(goal.title))
            .when(!scope, (el) => el.child(button(t, `goal-focus-view-${goal.id}`, "Focus", (cx) => this.focusGoal(goal.id, cx), { size: "sm", tip: "F on this goal: focus its linked work; other blockers remain counted" })))
            .child(button(t, `goal-edit-${goal.id}`, "Edit", () => openGoal(goal.id), { size: "sm", tip: "Edit plan, ownership or recorded context" })))
          .child(h_flex().id(`goal-next-row-${goal.id}`).min_w(0).gap(8).p(6).items_center().rounded(6).bg(t.raised)
            .child(v_flex().id(`goal-next-copy-${goal.id}`).flex_1().min_w(0).gap(2)
              .child(div().id(`goal-next-status-${goal.id}`).min_w(0).text_size(11).font_semibold().text_color(["Needs attention", "Status unavailable"].includes(next.status) ? t.blocked : t.accent).truncate().tooltip(status).child(status))
              .child(div().id(`goal-next-detail-${goal.id}`).min_w(0).text_size(13).truncate().tooltip(next.detail).child(next.detail)))
            .child(button(t, next.action === 'review' ? `goal-review-next-${goal.id}` : next.action === 'decision' ? `goal-decision-next-${goal.id}` : `goal-workflow-${goal.id}`, actionLabel, () => this.openMissionAction(goal),
              { kind: "solid", tip: "Open the next step. This does not send work or accept a result." })))
          .children(this.goalSourceRows(t, goal.id, items, goal));
      }),
      ...(!groups.length ? [line("Create a run to give agents an outcome and review their work here.", t)] : []),
      ...(other.length ? [sectionHeader(t, "UNLINKED WORK", other.length), ...this.goalSourceRows(t, "unlinked", other)] : []),
    ];
  }
}
