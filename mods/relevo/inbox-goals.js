import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, terminals, run, exec, shared, setShared } from "herdr";
import { accountFor, inFocus } from "./context.js";
import { button, sectionHeader, foldRow } from "./ui.js";
import { openGoal } from "./goals-editor.js";
import { readGoals, GOALS_CHANGED } from "./goals-store.js";
import { emptyGoals, groupSources, evidenceState, sourceKey, webLink, goalState, GOAL_STATES, STEP_STATES } from "./lib/goals.js";
import { isAddressed } from "./lib/addressed.js";
import { openReplies } from "./replies.js";
import { openReview } from "./review.js";
import { reviewableWork, scopeGoals } from "./lib/goal-workflow.js";

export const GOAL_MODE = "relevo.goals.mode";
export const GOAL_SCOPE = "relevo.goals.scope";
const line = (s, t) => div().text_size(11).text_color(t.muted).child(s);

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
        this.goalsError = null;
      } catch (e) { this.goalsError = `Goals: ${e.message ?? e}. Classic Inbox is still available.`; }
      this.goalChange = shared(GOALS_CHANGED);
      this.goalsLoading = false;
      cx.notify();
    });
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
    return sources.map((s) => s.kind === "goal" ? { id: `goal-${s.goal.id}`, section: "goals", go: () => openGoal(s.goal.id) }
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
    if (key === "?") { this.goalHelp = !this.goalHelp; return true; }
    const group = this.goalProjection?.groups.find((g) => `goal-${g.goal.id}` === this.sel);
    if (key === "f" && (group || this.goalProjection?.scope)) {
      this.focusGoal(this.goalProjection.scope ? null : group.goal.id, cx); return true;
    }
    if (key === "r" && group) { this.reviewGoal(group.items); return true; }
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

  goalToolbar(t, cx) {
    if (this.goalChange !== shared(GOALS_CHANGED)) this.loadGoals(cx);
    return h_flex().px(8).py(6).gap(6).flex_none().items_center()
      .children([[false, "Classic"], [true, "Goals"]].map(([on, label]) => button(t, `inbox-mode-${on}`, label, (cx) => {
        setShared(GOAL_MODE, on); this.sel = null; this.keyboard = false; this.loadGoals(cx); cx.notify();
      }, { kind: (shared(GOAL_MODE) === true) === on ? "solid" : "outline", selected: (shared(GOAL_MODE) === true) === on,
        tip: on ? "Group existing work by goal, owner and pending decision" : "Show the original Inbox sections" })))
      .child(div().flex_1())
      .when(shared(GOAL_MODE) === true, (el) => el
        .child(button(t, "goal-jump", "Go to goal", (cx) => this.nextGoal(cx), { size: "sm", disabled: !this.goalDoc?.goals.length, tip: "G while the queue is focused: select the next goal" }))
        .child(button(t, "goal-new", "+ Goal", () => openGoal(), { size: "sm", tip: "Create a goal without starting an agent" })));
  }

  sourceCard(t, source, goal = null) {
    return v_flex().id(`source-${source.key}`).gap(4)
      .child(source.kind === "pr" ? source.draft ? this.draftCard(t, source.pr) : this.prCard(t, source.pr, source.requested, source.addressed) : this.localCard(t, source.item, source.addressed))
      .child(h_flex().flex_wrap().gap(5).justify_end()
        .when(source.kind === "pr", (el) => el.child(button(t, `source-skills-${source.key}`, "Skills…", () => this.openSkillMenu(source.pr),
          { size: "sm", disabled: !this.clones[source.pr.repo], tip: this.clones[source.pr.repo] ? "S on this card: choose a skill and account before running" : "Clone this repository to run its skills" })))
        .child(button(t, `source-link-${source.key}`, goal ? "Context / evidence" : "Link goal", () => openGoal(goal?.id ?? null, source), { size: "sm", tip: "E on this card: edit context, record feedback or attach evidence; no message is sent" })));
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
      ...(drafts.length ? [foldRow(this, t, `goal-drafts-${id}`, `goal-${id}-drafts`, `${drafts.length} draft(s)`),
        ...(this.expanded[`goal-${id}-drafts`] ? drafts.filter(visible).map((s) => this.sourceCard(t, s, goal)) : [])] : []),
      ...(done.length ? [foldRow(this, t, `goal-addressed-${id}`, `goal-${id}-done`, `${done.length} addressed · not necessarily completed`),
        ...(this.expanded[`goal-${id}-done`] ? done.filter(visible).map((s) => this.sourceCard(t, s, goal)) : [])] : []),
    ];
  }

  goalViewport() {
    const at = this.nav.findIndex((n) => n.id === this.sel);
    const above = this.keyboard && at > 1 ? at - 1 : 0;
    return { hidden: new Set(this.nav.slice(0, above).map((n) => n.id)), sections: new Set(), above };
  }

  goalsGroup(t) {
    const { sources, groups, waiting, other, scope, outsideCount, outsideBlockers } = this.goalProjection;
    const visible = (s) => !this.hiddenIds.has(s.kind === "pr" ? `pr-${s.pr.url}` : `in-${s.item.agent.address}`);
    const fresh = Boolean(this.prsAt && !this.error && Date.now() / 1000 - this.prsAt < 180);
    return [
      ...(scope ? [v_flex().gap(5).p(8).rounded(6).bg(t.raised)
        .child(h_flex().gap(5).items_center().child(div().flex_1().font_semibold().text_size(13).child("Focused goal"))
          .child(button(t, "goal-all-work", "All work", (cx) => this.focusGoal(null, cx), { size: "sm", tip: "F: return to the full queue; no work is marked addressed" })))
        .child(line(this.prsAt ? `${outsideCount} PR/local items outside · ${outsideBlockers} PR/local blockers` : "PR/local counts are still loading.", t))
        .child(line("Other Inbox sections remain available in All work.", t))]
        : [line(`${groups.length} goal(s) · ${groups.filter((g) => g.goal.decision.trim()).length} pending goal decision(s)`, t),
          line("Blockers first. Focus a goal to review its work together; All work restores the queue.", t)]),
      ...(this.goalsError ? [div().text_size(11).text_color(t.blocked).child(this.goalsError)] : []),
      ...(waiting.length ? [sectionHeader(t, "UNLINKED BLOCKERS", waiting.length), ...waiting.filter(visible).map((s) => this.sourceCard(t, s))] : []),
      ...groups.filter((g) => !this.hiddenIds.has(`goal-${g.goal.id}`) || this.goalVisibleSources(g.goal.id, g.items).some(visible)).map(({ goal, items, urgency }) => {
        const liveAgents = agents(), lead = liveAgents.find((a) => a.address === goal.lead);
        const children = lead ? terminals().filter((k) => k.parent === lead.address && liveAgents.some((a) => a.address === k.address)) : [];
        const missing = goal.sources.filter((key) => !sources.some((s) => s.key === key));
        const steps = goal.steps ?? [];
        const reviewable = reviewableWork(items, this.clones);
        return v_flex().id(`goal-${goal.id}`).p(8).gap(7).rounded(8).bg(t.background).border_1().border_color(this.selected(`goal-${goal.id}`) ? t.accent : urgency === 0 ? t.blocked : t.border)
          .child(h_flex().gap(5).items_center().child(div().flex_1().min_w(0).text_size(13).font_semibold().child(goal.title))
            .when(!scope, (el) => el.child(button(t, `goal-focus-view-${goal.id}`, "Focus", (cx) => this.focusGoal(goal.id, cx), { size: "sm", tip: "F on this goal: focus its linked work; other blockers remain counted" })))
            .child(button(t, `goal-edit-${goal.id}`, "Edit", () => openGoal(goal.id), { size: "sm", tip: "Edit plan, ownership or recorded context" })))
          .child(v_flex().gap(6).p(8).rounded(6).bg(t.raised)
            .child(div().text_size(11).font_semibold().text_color(goal.decision ? t.accent : t.muted).child(goal.decision ? "YOUR NEXT DECISION" : "REVIEW WORK"))
            .child(div().text_size(13).child(goal.decision || "Inspect the linked changes before recording an outcome."))
            .child(h_flex().gap(5).flex_wrap()
              .child(button(t, `goal-review-next-${goal.id}`, "Review changes", () => this.reviewGoal(items),
                { kind: "solid", disabled: !reviewable.length, tip: reviewable.length ? "R on this goal: open the existing diff review; does not run an agent or approve work" : "No linked diff is available yet. Keep the agent connected or link a PR with a local clone." }))
              .child(button(t, `goal-record-${goal.id}`, "Record decision", () => openGoal(goal.id), { tip: "Record feedback after review. Saving does not send it or approve a PR." })))
            .child(line(`${reviewable.length} change sets available · acceptance stays with you`, t)))
          .child(line(`${["Urgent", "High", "Normal", "Low"][goal.priority]} · Owner: ${goal.owner || "Not set"}`, t))
          .child(line(`${GOAL_STATES[goalState(goal)]} · ${steps.filter((s) => s.state === "done").length}/${steps.length} steps validated by you`, t))
          .when(goalState(goal) !== "active" && items.some((s) => !s.addressed && !s.draft), (el) => el.child(line("Open work remains visible regardless of the goal state.", t)))
          .when(Boolean(steps.length), (el) => el.child(foldRow(this, t, `goal-plan-${goal.id}`, `goal-${goal.id}-plan`, "Plan and progress")))
          .children(this.expanded[`goal-${goal.id}-plan`] ? steps.map((s) => line(`${STEP_STATES[s.state]} · ${s.title}`, t)) : [])
          .child(line(`Lead: ${lead ? lead.tab_name || lead.address : goal.lead ? `${goal.lead} · not connected` : "Unassigned"}${lead ? ` · ${children.length} observed child agents` : ""}`, t))
          .when(Boolean(lead), (el) => el.child(h_flex().gap(5)
            .child(button(t, `goal-focus-${goal.id}`, "Focus lead", () => run("agent.focus", { terminal: lead.address }), { size: "sm" }))
            .child(button(t, `goal-reply-${goal.id}`, "Message lead", () => openReplies(lead.address), { size: "sm" }))))
          .when(Boolean(goal.recommendation), (el) => el.child(line(`Recommendation: ${goal.recommendation}`, t)))
          .when(!goal.evidence.length, (el) => el.child(line("Screenshots and demo: no linked evidence", t)))
          .children(goal.evidence.map((e, n) => h_flex().gap(5).items_center()
            .child(div().flex_1().child(line(`${e.label} · ${evidenceState(e, sources, fresh)}`, t)))
            .child(button(t, `goal-evidence-${goal.id}-${n}`, "Open", () => { if (webLink(e.url)) exec("open", [e.url]); }, { size: "sm" }))))
          .child(foldRow(this, t, `goal-context-${goal.id}`, `goal-${goal.id}-context`,
            `Criteria and feedback${goal.decisions.length ? ` · ${goal.decisions.length} recorded` : ""}`))
          .when(Boolean(this.expanded[`goal-${goal.id}-context`]), (el) => el.child(v_flex().id(`goal-context-detail-${goal.id}`).gap(5)
            .child(line(`Criteria: ${goal.criteria || "Not set"}`, t))
            .when(Boolean(goal.decisions.length), (detail) => detail.child(line(`Latest recorded feedback: ${goal.decisions.at(-1).text}`, t)))))
          .when(!items.length, (el) => el.child(line("No work visible in this filter. Link a PR or local change from its card.", t)))
          .when(Boolean(missing.length), (el) => el.child(line(`${missing.length} link(s) outside this Inbox; this does not imply completion.`, t)))
          .children(this.goalSourceRows(t, goal.id, items, goal));
      }),
      ...(!groups.length ? [line("Create a goal or link an existing card. PRs and replies keep their controls.", t)] : []),
      ...(other.length ? [sectionHeader(t, "UNLINKED WORK", other.length), ...this.goalSourceRows(t, "unlinked", other)] : []),
    ];
  }
}
