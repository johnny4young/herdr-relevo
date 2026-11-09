import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents } from "herdr";
import { button } from "./ui.js";
import { projectGoalPlan, defaultPlanStepIds } from "./lib/goal-plan.js";

const labels = { todo: "Not started", planned: "Planned", ready: "Ready", running: "In progress", working: "In progress", needs_review: "Independent review", review: "Needs review", needs_you: "Needs your review", accepted: "Accepted", done: "Validated", blocked: "Needs attention", failed: "Failed", cancelled: "Cancelled" };
const row = (t, value) => div().w_full().min_w(0).text_size(13).text_color(t.muted).child(value);

export class WorkflowPlan {
  openPlan(cx, reset = false) {
    this.tab = "Plan"; this.explicitNew = false;
    this.planMoreOpen = false;
    if (this.goal && (!this.planDraftGoal || reset)) {
      this.planDraftGoal = this.goal;
      this.planStepIds = defaultPlanStepIds(this.goal, this.tasks);
      this.planRequestId = null;
    }
    this.h.focus(); cx.notify();
  }

  createPlan(cx) {
    if (this.busy || !this.planDraftGoal || !this.planStepIds?.length) return;
    const goal = this.planDraftGoal;
    if (this.goal?.version !== goal.version) {
      this.error = "The goal changed. Refresh the plan before saving."; cx.notify(); return;
    }
    const root = this.form.root.value().trim();
    const executor = agents().find((agent) => agent.address === this.executor);
    const reviewer = agents().find((agent) => agent.address === this.reviewer);
    const maxRounds = Number(this.form.maxRounds.value()), maxMinutes = Number(this.form.maxMinutes.value());
    if (!root.startsWith("/") || !executor || !reviewer || executor.address === reviewer.address) {
      this.planMoreOpen = true; this.planConfigOpen = true;
      this.error = "Choose an absolute repository path and two different connected agents for this plan."; cx.notify(); return;
    }
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5 || !Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 120) {
      this.planMoreOpen = true; this.planConfigOpen = true;
      this.error = "Use 1–5 rounds and a 1–120 minute limit."; cx.notify(); return;
    }
    let checks;
    try {
      checks = this.form.checks.value().trim() ? JSON.parse(this.form.checks.value()) : [];
      if (!Array.isArray(checks) || checks.some((args) => !Array.isArray(args) || !args.length || args.some((arg) => typeof arg !== "string"))) throw Error();
    } catch { this.planMoreOpen = true; this.planConfigOpen = true; this.error = 'Checks must be JSON argv lists, such as [["npm","test"]].'; cx.notify(); return; }
    const payload = { action: "create-plan", goalId: goal.id, goalVersion: goal.version,
      stepIds: goal.steps.filter((step) => this.planStepIds.includes(step.id)).map((step) => step.id), root,
      executor: { address: executor.address, label: executor.title || executor.address },
      reviewer: { address: reviewer.address, label: reviewer.title || reviewer.address }, checks, maxRounds, maxMinutes };
    // Retain the id for an identical retry after an uncertain transport result.
    const key = JSON.stringify(payload);
    if (key !== this.planRequestKey) { this.planRequestKey = key; this.planRequestId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
    this.command({ ...payload, planId: this.planRequestId }, cx, () => {
      this.planStepIds = []; this.notice = "Plan saved. Start plan begins the first task; later tasks wait for your acceptance.";
    });
  }

  planPanel(t) {
    if (!this.goal) return v_flex().gap(8).child(row(t, this.goalError || "This goal is no longer available. Return to Inbox to choose an active goal."));
    const goal = this.planDraftGoal ?? this.goal;
    const projected = projectGoalPlan(this.goal, this.tasks);
    const draftRows = projectGoalPlan(goal, this.tasks);
    const selected = goal.steps.filter((step) => this.planStepIds?.includes(step.id));
    const stale = this.goal.version !== goal.version;
    const active = (this.goal.state ?? "active") === "active";
    const plans = (this.plans ?? []).filter((plan) => plan.state !== "cancelled" && plan.taskIds.some((id) => this.tasks.some((task) => task.id === id && task.state !== "cancelled")));
    const terminal = (task) => ["accepted", "cancelled"].includes(task.state);
    const livePlans = plans.filter((plan) => plan.state === "planned" || (plan.state === "started" && plan.taskIds.some((id) => {
      const task = this.tasks.find((item) => item.id === id);
      return task && !terminal(task);
    })));
    const showBuilder = livePlans.length === 0 || this.planMoreOpen;
    return v_flex().w_full().min_w(0).gap(9)
      .child(div().font_semibold().child(this.goal.title))
      .child(row(t, `${projected.filter((item) => item.state === "done").length}/${projected.length} outcomes validated`))
      .children(plans.map((plan) => {
        const tasks = plan.taskIds.map((id) => this.tasks.find((task) => task.id === id)).filter(Boolean);
        const stopped = tasks.some((task) => task.paused);
        const cancelled = tasks.some((task) => task.state === "cancelled");
        const first = tasks[0];
        const accepted = tasks.filter((task) => task.state === "accepted").length;
        const needsYou = tasks.find((task) => ["needs_you", "blocked", "failed"].includes(task.state));
        const pausedTask = tasks.find((task) => task.paused && task.state !== "accepted");
        const cancelledTask = tasks.find((task) => task.state === "cancelled");
        const next = tasks.find((task) => !terminal(task));
        const openTask = (task, cx) => {
          this.selected = task.id;
          this.filter = task.state === "accepted" ? "Completed" : ["needs_you", "blocked", "failed"].includes(task.state) ? "Needs you" : "In progress";
          this.tab = "Overview"; this.h.focus(); cx.notify();
        };
        const nextAction = plan.state === "planned" ? (stopped ? "Ready to resume and start" : "Ready to start")
          : cancelledTask ? `Cancelled: ${cancelledTask.title} · plan needs an update`
          : needsYou ? `${needsYou.state === "needs_you" ? "Review" : "Resolve"}: ${needsYou.title}`
          : pausedTask ? `Paused: ${pausedTask.title}`
          : next ? `${next.state === "needs_review" ? "Independent review" : next.state === "running" || next.state === "working" ? "In progress" : next.state === "ready" ? "Queued" : "Next"}: ${next.title}`
          : "All tasks accepted";
        const detailsOpen = Boolean(this.planDetailsOpen?.[plan.id]);
        return v_flex().gap(5).p(8).border(1).border_color(t.border).rounded(5)
          .child(div().font_semibold().child(`${accepted}/${tasks.length} tasks accepted`))
          .child(row(t, nextAction))
          .when(Boolean(needsYou), (el) => el.child(button(t, `workflow-plan-next-${plan.id}`, needsYou.state === "needs_you" ? "Review result" : "Resolve issue", (cx) => openTask(needsYou, cx), { tip: "Open this task in Workflow without dispatching work" })))
          .when(!needsYou && Boolean(next) && !cancelledTask, (el) => el.child(button(t, `workflow-plan-next-${plan.id}`, "View progress", (cx) => openTask(next, cx), { tip: "Open this task's progress in Workflow without dispatching work" })))
          .child(button(t, `workflow-plan-details-${plan.id}`, detailsOpen ? "Hide plan details" : "Plan details", (cx) => {
            this.planDetailsOpen ??= {}; this.planDetailsOpen[plan.id] = !detailsOpen; cx.notify();
          }, { accessibleLabel: `${detailsOpen ? "Hide" : "Show"} details for saved plan` }))
          .when(detailsOpen, (el) => el
            .children(tasks.map((task, index) => row(t, `${index + 1}. ${task.title} · ${labels[task.state] ?? task.state}`)))
            .child(row(t, `Repository: ${first?.root ?? "Unavailable"}`))
            .child(row(t, `${first?.executor?.label ?? "Executor"} → ${first?.reviewer?.label ?? "Independent reviewer"} · ${first?.maxRounds ?? "?"} rounds · ${first?.maxMinutes ?? "?"} min per task`)))
          .when(plan.state === "planned", (el) => el.child(button(t, `workflow-start-plan-${plan.id}`, stopped ? "Resume & start plan" : "Start plan", (cx) => this.command({ action: "start-plan", planId: plan.id, ...(stopped ? { resumePaused: true } : {}) }, cx, (_response, context) => {
            this.notice = "Plan started. Review results in Needs you; accepted tasks release the next step automatically.";
            this.selectFilter("In progress", context);
          }), { kind: "solid", disabled: this.busy || cancelled || !active || plan.goalVersion !== this.goal.version,
            tip: cancelled ? "Cancel this draft and prepare an updated plan without the cancelled task." : plan.goalVersion !== this.goal.version ? "The goal changed. Cancel these planned tasks and prepare an updated plan." : stopped ? "Explicitly resume the paused tasks in this draft and start the plan; other paused work stays paused" : "Start this bounded plan once; each subsequent task waits for human acceptance" })))
          .when(plan.state === "planned", (el) => el.child(button(t, `workflow-cancel-plan-${plan.id}`, "Cancel draft plan", (cx) => this.command({ action: "cancel-plan", planId: plan.id }, cx, (_response, context) => {
            this.openPlan(context, true); this.notice = "Draft plan cancelled. Its history remains; you can prepare an updated plan.";
          }), { disabled: this.busy, tip: "Cancel only this unstarted plan and its tasks; keep the goal and all previous accepted work" })));
      }))
      .when(livePlans.length > 0, (el) => el.child(button(t, "workflow-plan-more", this.planMoreOpen ? "Hide plan more work" : "Plan more work", (cx) => {
        this.planMoreOpen = !this.planMoreOpen; cx.notify();
      }, { accessibleLabel: `${this.planMoreOpen ? "Hide" : "Show"} outcome selection for another plan` })))
      .when(showBuilder, (el) => el
      .child(div().font_semibold().pt(8).child("Choose outcomes"))
      .child(row(t, "Select the work to include. Existing tasks and validated outcomes are already excluded."))
      .when(stale, (el) => el.child(row(t, "The goal changed while you were planning. Refresh before saving.")))
      .child(button(t, "workflow-plan-refresh", "Refresh plan selection", (cx) => this.openPlan(cx, true), { disabled: this.busy, tip: "Reload current outcomes and default selection; keep your repository and agent choices" }))
      .children(draftRows.map((item) => {
        const linked = Boolean(item.taskId || item.issue);
        const status = labels[item.state] ?? item.state;
        return v_flex().gap(4)
          .child(item.state === "done" ? row(t, `✓ ${item.step.title} · ${item.source === "workflow" ? "accepted in Workflow" : "manually validated"}`)
            : button(t, `workflow-plan-select-${item.step.id}`, [v_flex().w_full().min_w(0).gap(2).text_left()
              .child(div().w_full().truncate().child(`${this.planStepIds?.includes(item.step.id) ? "☑" : "☐"} ${item.step.title}`))
              .child(div().text_size(11).child(status))], (cx) => {
              this.planStepIds ??= [];
              this.planStepIds = this.planStepIds.includes(item.step.id) ? this.planStepIds.filter((id) => id !== item.step.id) : [...this.planStepIds, item.step.id]; cx.notify();
            }, { disabled: this.busy || linked || stale || !active, selected: this.planStepIds?.includes(item.step.id),
              accessibleLabel: `${item.step.title}. ${status}. ${linked ? "Already linked to work" : this.planStepIds?.includes(item.step.id) ? "Selected" : "Not selected"}`,
              tip: linked ? item.issue || "This outcome already has a task. View it below." : `Include outcome: ${item.step.title}` }).h(48).w_full().min_w(0).overflow_hidden())
          .when(Boolean(item.issue), (el) => el.child(row(t, item.issue)))
          .when(Boolean(item.taskId), (el) => el.child(button(t, `workflow-plan-task-${item.step.id}`, "View task", (cx) => {
            const task = this.tasks.find((task) => task.id === item.taskId);
            if (task) {
              this.selected = task.id; this.filter = task.state === "accepted" ? "Completed" : ["needs_you", "blocked", "failed"].includes(task.state) ? "Needs you" : "In progress";
              this.tab = "Overview"; this.h.focus(); cx.notify();
            }
          }, { tip: "Inspect the result and its evidence without changing progress" })));
      }))
      .when(selected.length > 0, (el) => el
        .child(div().font_semibold().child(`Preview · ${selected.length} tasks in order`))
        .children(selected.map((step, index) => row(t, `${index + 1}. ${step.title}${index ? " · after acceptance" : " · starts first"}`)))
        .child(row(t, `Shared acceptance criteria: ${goal.criteria || "Add acceptance criteria in the goal before saving."}`))
        .child(button(t, "workflow-plan-config", this.planConfigOpen ? "Hide setup" : "Repository, agents and limits", (cx) => {
          this.planConfigOpen = !this.planConfigOpen; cx.notify();
        }, { accessibleLabel: `${this.planConfigOpen ? "Hide" : "Show"} repository, agent and limit settings` }))
        .when(this.planConfigOpen, (config) => config
          .child(this.field(t, "root", "Repository path"))
          .child(this.repositoryPicker(t))
          .child(this.agentPicker(t, "executor", "Executor"))
          .child(this.agentPicker(t, "reviewer", "Independent reviewer"))
          .child(h_flex().gap(6).child(this.field(t, "maxRounds", "Rounds per task (1–5)"))
            .child(this.field(t, "maxMinutes", "Minutes per round (1–120)")))
          .child(this.field(t, "checks", "Optional checks JSON"))
          .child(row(t, "Limits apply to each task. Saving creates a preview; Start plan is what authorizes agents to begin.")))
        .child(button(t, "workflow-create-plan", "Save plan preview", (cx) => this.createPlan(cx), { kind: "solid", disabled: this.busy || stale || !active || !goal.criteria?.trim(), tip: "Atomically create all selected tasks and their dependencies without running agents" })))
      .when(!active, (el) => el.child(row(t, "This goal is not active. Its history remains available; reopen the goal before planning new work."))));
  }
}
