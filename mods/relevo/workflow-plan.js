import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents } from "herdr";
import { button } from "./ui.js";
import { projectGoalPlan, defaultPlanStepIds } from "./lib/goal-plan.js";

const labels = { todo: "Not started", working: "In progress", review: "Needs review", done: "Validated", blocked: "Needs attention" };
const row = (t, value) => div().w_full().min_w(0).text_size(13).text_color(t.muted).child(value);

export class WorkflowPlan {
  openPlan(cx, reset = false) {
    this.tab = "Plan"; this.explicitNew = false;
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
      this.error = "Choose an absolute repository path and two different connected agents for this plan."; cx.notify(); return;
    }
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5 || !Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 120) {
      this.error = "Use 1–5 rounds and a 1–120 minute limit."; cx.notify(); return;
    }
    let checks;
    try {
      checks = this.form.checks.value().trim() ? JSON.parse(this.form.checks.value()) : [];
      if (!Array.isArray(checks) || checks.some((args) => !Array.isArray(args) || !args.length || args.some((arg) => typeof arg !== "string"))) throw Error();
    } catch { this.error = 'Checks must be JSON argv lists, such as [["npm","test"]].'; cx.notify(); return; }
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
    return v_flex().w_full().min_w(0).gap(9)
      .child(div().font_semibold().child(this.goal.title))
      .child(row(t, `${projected.filter((item) => item.state === "done").length}/${projected.length} outcomes validated`))
      .child(row(t, "Choose outcomes once, then start the plan. Each task runs through implementation, checks and independent review. Your acceptance unlocks the next task automatically."))
      .children((this.plans ?? []).filter((plan) => plan.state !== "cancelled" && plan.taskIds.some((id) => this.tasks.some((task) => task.id === id && task.state !== "cancelled"))).map((plan) => {
        const tasks = plan.taskIds.map((id) => this.tasks.find((task) => task.id === id)).filter(Boolean);
        const stopped = tasks.some((task) => task.paused);
        const cancelled = tasks.some((task) => task.state === "cancelled");
        const first = tasks[0];
        return v_flex().gap(5).p(8).border(1).border_color(t.border).rounded(5)
          .child(row(t, `${tasks.filter((task) => task.state === "accepted").length}/${tasks.length} tasks accepted · ${plan.state === "planned" ? "Ready to start" : stopped ? "Paused or cancelled work needs attention" : "Plan started"}`))
          .children(tasks.map((task, index) => row(t, `${index + 1}. ${task.title}`)))
          .child(row(t, `Repository: ${first?.root ?? "Unavailable"}`))
          .child(row(t, `${first?.executor?.label ?? "Executor"} → ${first?.reviewer?.label ?? "Independent reviewer"} · ${first?.maxRounds ?? "?"} round(s) per task · ${first?.maxMinutes ?? "?"} minutes per round`))
          .when(plan.state === "planned", (el) => el.child(button(t, `workflow-start-plan-${plan.id}`, stopped ? "Resume & start plan" : "Start plan", (cx) => this.command({ action: "start-plan", planId: plan.id, ...(stopped ? { resumePaused: true } : {}) }, cx, (_response, context) => {
            this.notice = "Plan started. Review results in Needs you; accepted tasks release the next step automatically.";
            this.selectFilter("In progress", context);
          }), { kind: "solid", disabled: this.busy || cancelled || !active || plan.goalVersion !== this.goal.version,
            tip: cancelled ? "Cancel this draft and prepare an updated plan without the cancelled task." : plan.goalVersion !== this.goal.version ? "The goal changed. Cancel these planned tasks and prepare an updated plan." : stopped ? "Explicitly resume the paused tasks in this draft and start the plan; other paused work stays paused" : "Start this bounded plan once; each subsequent task waits for human acceptance" })))
          .when(plan.state === "planned", (el) => el.child(button(t, `workflow-cancel-plan-${plan.id}`, "Cancel draft plan", (cx) => this.command({ action: "cancel-plan", planId: plan.id }, cx, (_response, context) => {
            this.openPlan(context, true); this.notice = "Draft plan cancelled. Its history remains; you can prepare an updated plan.";
          }), { disabled: this.busy, tip: "Cancel only this unstarted plan and its tasks; keep the goal and all previous accepted work" })));
      }))
      .child(div().font_semibold().pt(8).child("Prepare remaining work"))
      .child(row(t, "Existing tasks and validated outcomes are excluded. Steps already awaiting review are optional and unchecked; select one only if you want agents to work on it again."))
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
            this.selected = item.taskId; this.filter = task?.state === "accepted" ? "Completed" : ["needs_you", "blocked", "failed"].includes(task?.state) ? "Needs you" : "In progress";
            this.tab = "Overview"; this.h.focus(); cx.notify();
          }, { tip: "Inspect the result and its evidence without changing progress" })));
      }))
      .when(selected.length > 0, (el) => el
        .child(div().font_semibold().child(`Preview · ${selected.length} tasks in order`))
        .children(selected.map((step, index) => row(t, `${index + 1}. ${step.title}${index ? " · after your acceptance of the previous task" : " · starts first"}`)))
        .child(row(t, `Shared acceptance criteria: ${goal.criteria || "Add acceptance criteria in the goal before saving."}`))
        .child(this.field(t, "root", "Repository path for this plan"))
        .child(this.repositoryPicker(t))
        .child(this.agentPicker(t, "executor", "Executor for this plan"))
        .child(this.agentPicker(t, "reviewer", "Independent reviewer for this plan"))
        .child(h_flex().gap(6).child(this.field(t, "maxRounds", "Maximum rounds per task (1–5)"))
          .child(this.field(t, "maxMinutes", "Minutes per round (1–120)")))
        .child(this.field(t, "checks", "Optional checks JSON · runs for each task"))
        .child(row(t, "These limits apply to each task, not the whole plan. Saving does not send a prompt. Start plan authorizes the sequence; acceptance, pauses and cancellation remain yours."))
        .child(button(t, "workflow-create-plan", "Save plan preview", (cx) => this.createPlan(cx), { kind: "solid", disabled: this.busy || stale || !active || !goal.criteria?.trim(), tip: "Atomically create all selected tasks and their dependencies without running agents" })))
      .when(!active, (el) => el.child(row(t, "This goal is not active. Its history remains available; reopen the goal before planning new work.")));
  }
}
