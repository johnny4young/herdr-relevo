import { div } from "gpui-kit";
import { h_flex, v_flex, Input, TextView } from "gpui-base";
import { agents, exec, run } from "herdr";
import { button, pill } from "./ui.js";
import { openReview } from "./review.js";
import * as config from "./config.js";
import { acceptanceEffect, workflowCheckSummary } from "./lib/workflow-navigation.js";
import { linkedDecision } from "./lib/goal-workflow.js";
import { agentMarkdown } from "./lib/agent-markdown.js";
import { WorkflowRuns } from "./workflow-runs.js";
import { row, taskState, reportState, caption, SUMMARY_PREVIEW } from "./workflow-labels.js";

const CONFIGURED_SKILLS = config.SKILLS;

export class WorkflowDetail extends WorkflowRuns {
  taskActions(t, task, cx) {
    const action = (label, name, tip) => button(t, `workflow-action-${name}`, label,
      (context) => this.command({ action: name, taskId: task.id }, context), { disabled: this.busy, tip });
    const actions = [];
    const planDraft = task.planId && (this.plans ?? []).some((plan) => plan.id === task.planId && plan.state === "planned");
    const cancelledDependency = (task.dependsOn ?? []).some((id) => this.tasks?.find((item) => item.id === id)?.state === "cancelled");
    if (!planDraft && !cancelledDependency && (task.state === "planned" || (task.state === "ready" && !this.engine?.enabled)) && !task.paused) actions.push(action("Start", "start", "Start the chosen existing sessions"));
    const last = task.attempts?.at(-1);
    // The coordinator validates task.revision against the live checkout fingerprint.
    // A historical attempt revision is not part of that command guard.
    const hasRevision = Boolean(task.revision);
    const checksPassed = (task.checksResult ?? []).every((check) => check.code === 0);
    const reviewBudgetAvailable = (task.attempts ?? []).filter((attempt) => attempt.role === "reviewer").length < (task.maxRounds ?? 2) + 1;
    const attemptBudgetAvailable = (task.round ?? 0) < (task.maxRounds ?? 2);
    const noUncertainDelivery = last?.delivery !== "uncertain";
    const noLiveAttempt = !(task.state === "blocked" && last?.state === "running");
    const canRetryReview = task.state === "blocked" && last?.role === "reviewer" && last.state === "reported" && hasRevision && checksPassed && reviewBudgetAvailable;
    const canStartAgain = ["blocked", "failed"].includes(task.state) && !task.paused && attemptBudgetAvailable && noUncertainDelivery && noLiveAttempt;
    const canResume = task.paused && !planDraft && !["needs_you", "accepted", "cancelled"].includes(task.state) && noUncertainDelivery && noLiveAttempt &&
      (!["blocked", "failed", "planned"].includes(task.state) || attemptBudgetAvailable);
    if (canRetryReview) {
      actions.push(action("Retry review", "retry-review", "Ask the independent reviewer to reassess the same checked revision; the coordinator verifies it is unchanged"));
    }
    if (canStartAgain) actions.push(action("Retry", "start", "Start a new bounded attempt after reviewing the reported issue"));
    if (canResume) actions.push(action("Resume", "resume", "Resume dispatches for this task"));
    else if (!task.paused && ["running", "ready", "planned", "needs_review", "needs_you", "blocked"].includes(task.state)) actions.push(action("Pause", "pause", "Pause new dispatches; an active agent may finish"));
    if (!["accepted", "cancelled"].includes(task.state)) actions.push(action("Cancel", "cancel", "Cancel task and request an interrupt if an agent is running"));
    actions.push(action("Refresh", "refresh", "Refresh checkout and evidence status"));
    return h_flex().gap(5).children(actions);
  }

  editDecisionNote(task, changes, cx) {
    this.decisionDrafts ??= {};
    if (this.decisionNoteFor) this.decisionDrafts[this.decisionNoteFor] = this.form.decision.value();
    this.form.decision.set_value(this.decisionDrafts[task.id] ?? "");
    this.decisionNoteFor = task.id; this.requestChangesFor = changes ? task.id : null; this.acceptIntent = null; cx.notify();
    cx.timer.after(30, () => { if (!this.closed && this.decisionNoteFor === task.id) this.form.decision.focus(); });
  }

  prepareFollowUp(task, cx) {
    this.form.title.set_value(`Follow up: ${task.title}`.slice(0, 240));
    this.form.root.set_value(task.root ?? "");
    this.form.criteria.set_value(`${task.criteria ?? ""}\nRequested changes: ${this.form.decision.value().trim()}`);
    this.form.checks.set_value(JSON.stringify(task.checks ?? []));
    this.checkPreset = task.checks?.length ? "custom" : "none";
    this.form.maxRounds.set_value(String(task.maxRounds ?? 2));
    this.form.maxMinutes.set_value(String(task.maxMinutes ?? 20));
    this.executor = task.executor?.address ?? ""; this.reviewer = task.reviewer?.address ?? "";
    this.dependsOn = (task.dependsOn ?? []).filter((id) => id !== task.id); this.selected = null; this.explicitNew = true; this.tab = "Overview";
    this.form.decision.set_value(""); this.decisionNoteFor = null; this.requestChangesFor = null;
    cx.notify();
  }

  prepareBlockedFollowUp(task, cx) {
    const reviewer = [...(task.attempts ?? [])].reverse().find((attempt) => attempt.role === "reviewer" && attempt.report);
    const findings = reviewer?.report?.summary?.trim();
    this.form.title.set_value(`Follow up: ${task.title}`.slice(0, 240));
    this.form.root.set_value(task.root ?? "");
    this.form.criteria.set_value([task.criteria, findings ? `Latest reviewer findings: ${findings}` : "Latest reviewer findings: none recorded."].filter(Boolean).join("\n\n"));
    this.form.checks.set_value(JSON.stringify(task.checks ?? []));
    this.checkPreset = task.checks?.length ? "custom" : "none";
    this.form.maxRounds.set_value(String(task.maxRounds ?? 2));
    this.form.maxMinutes.set_value(String(task.maxMinutes ?? 20));
    this.executor = task.executor?.address ?? ""; this.reviewer = task.reviewer?.address ?? "";
    this.dependsOn = (task.dependsOn ?? []).filter((id) => id !== task.id); this.selected = null; this.explicitNew = true; this.tab = "Overview";
    this.form.decision.set_value(""); this.decisionNoteFor = null; this.requestChangesFor = null;
    cx.notify();
  }

  submitDecision(task, outcome, cx) {
    if (this.busy || task.state !== "needs_you") return;
    const current = this.tasks?.find((item) => item.id === task.id);
    if (!current || current.revision !== task.revision || current.state !== "needs_you") return;
    const editing = this.decisionNoteFor === task.id;
    if (outcome === "changes" && (!editing || !this.form.decision.value().trim())) return;
    this.acceptIntent = null;
    this.command({ action: "decide", taskId: task.id,
      outcome, text: editing ? this.form.decision.value() : "", revision: task.revision ?? "" }, cx, () => {
      if (this.decisionDrafts) delete this.decisionDrafts[task.id];
      this.form.decision.set_value(""); this.decisionNoteFor = null; this.requestChangesFor = null;
    });
  }

  // The decision stays fixed under the content, so it never scrolls out of reach.
  decisions(t, task) {
    if (task.state !== "needs_you") return null;
    const editing = this.decisionNoteFor === task.id;
    const changes = this.requestChangesFor === task.id;
    const submit = (outcome, cx) => this.submitDecision(task, outcome, cx);
    const confirming = this.acceptIntent?.id === task.id && this.acceptIntent?.revision === task.revision;
    const effect = acceptanceEffect(task, this.tasks ?? [], this.engine);
    return v_flex().id("workflow-decision-card").w_full().min_w(0).flex_none().gap(8).px(14).py(10).border_t(1).border_color(t.border).bg(t.chrome)
      .when(Boolean(this.goal && linkedDecision(this.goal, this.tasks ?? []).task?.id === task.id), (el) => el.child(row(t, `Also resolves: ${this.goal.decision}`)))
      .when(editing, (el) => el.child(this.field(t, "decision", changes ? "What should change?" : "Decision note", true).id("workflow-decision-editor")
        .on_key_down((event, cx) => {
          if (event.key !== "enter" || !(event.modifiers?.platform || event.modifiers?.control) || event.modifiers?.alt || !changes) return;
          cx.stop_propagation();
          this.sendChanges(task, cx);
        }))
        .when(changes, (panel) => panel.child(row(t, task.round >= task.maxRounds
          ? "Round limit reached: this prepares a follow-up task for you to start."
          : "Sends another implementation and review round."))))
      .child(h_flex().w_full().min_w(0).gap(6).items_center().flex_wrap()
        .when(!editing, (bar) => bar
          .child(button(t, "workflow-decide-accept", confirming ? "Confirm ↵" : "Accept", (cx) => submit("accept", cx),
            { kind: "solid", disabled: this.busy || changes, tip: "A, then Enter" })
            .when(!this.busy && !changes, (el) => el.bg(t.accent).text_color(t.accent_foreground)))
          .child(button(t, "workflow-decide-changes", "Request changes", (cx) => this.editDecisionNote(task, true, cx), { disabled: this.busy, tip: "R" }))
          .child(button(t, "workflow-decision-diff", "Diff", (cx) => this.openDiff(task, cx), { kind: "ghost", size: "sm", disabled: this.busy || !task.root }))
          .child(button(t, "workflow-decide-defer", "Later", (cx) => submit("defer", cx), { kind: "ghost", size: "sm", disabled: this.busy, tip: "Keep it pending and pause further work" }))
          .child(button(t, "workflow-decision-note-toggle", "Note", (cx) => this.editDecisionNote(task, false, cx), { kind: "ghost", size: "sm" })))
        .when(editing, (bar) => bar.children([
          changes ? button(t, "workflow-send-changes", task.round >= task.maxRounds ? "Prepare follow-up" : "Send feedback",
            (cx) => task.round >= task.maxRounds ? this.prepareFollowUp(task, cx) : submit("changes", cx),
            { kind: "solid", disabled: this.busy || !this.form.decision.value().trim(), tip: "⌘Enter" }) : null,
          button(t, "workflow-decision-note-cancel", changes ? "Cancel" : "Remove note", (cx) => {
            if (this.decisionDrafts) delete this.decisionDrafts[task.id];
            this.form.decision.set_value(""); this.decisionNoteFor = null; this.requestChangesFor = null; this.h.focus(); cx.notify();
          }, { kind: "ghost", disabled: this.busy }),
        ].filter(Boolean))))
      .when(!editing, (el) => el.child(div().w_full().min_w(0).truncate().text_size(11).text_color(t.muted).tooltip(effect).child(effect)));
  }

  sendChanges(task, cx) {
    if (this.busy || !this.form.decision.value().trim()) return;
    if (task.round >= task.maxRounds) this.prepareFollowUp(task, cx);
    else this.submitDecision(task, "changes", cx);
  }

  composing() {
    return !this.selected && !this.pendingDraft && !["Preferences", "Plan", "Tools"].includes(this.tab) && (this.explicitNew || !(this.tasks ?? []).length);
  }

  nextStep(task) {
    if (task.state === "needs_you") return "The agents have finished. Review the result below, then accept it or request changes. You do not need to open their sessions.";
    if (task.state === "accepted") return "Accepted and saved in History.";
    if (task.state === "cancelled") return "Cancelled. Create a new task to continue.";
    if (task.state === "blocked" || task.state === "failed") return "Blocked. Review the findings, then prepare a follow-up.";
    if (task.state === "ready") {
      const pending = (task.dependsOn ?? []).map((id) => this.tasks?.find((item) => item.id === id)).filter((item) => !item || item.state !== "accepted");
      const continuation = this.engine?.enabled && !task.paused ? "This task continues automatically once its prerequisite is accepted." : "After the prerequisite is accepted, resume this task or start automation to continue.";
      const cancelled = pending.find((item) => item?.state === "cancelled");
      if (cancelled) return `The prerequisite “${cancelled.title}” was cancelled. This task cannot start automatically. Cancel this task and prepare an updated plan, or create a separate task with the prerequisites you need.`;
      const blocked = pending.find((item) => ["blocked", "failed"].includes(item?.state));
      if (blocked) return `Waiting for “${blocked.title}” to be resolved and accepted. Open that task in Needs you to inspect the issue. ${continuation}`;
      if (pending.length) return `Waiting for your acceptance of ${pending.map((item) => item?.title ?? "a prerequisite task").join(", ")}. ${continuation}`;
    }
    if (task.paused) return "This task is paused.";
    if (task.state === "planned" && task.planId) return "This task belongs to a saved plan. Open Goal plan and choose Start plan once for the whole sequence.";
    if (task.state === "ready" && this.engine?.enabled) return "Queued. Starts when its agent is free.";
    if (task.state === "planned" || task.state === "ready") return "Choose Start to assign this task.";
    if (task.state === "needs_review") return "Independent review in progress.";
    return "In progress. Checks and independent review follow.";
  }

  statusChips(t, task, review) {
    const checks = workflowCheckSummary(task);
    const checkText = checks.tone === "normal" ? `✓ Checks ${checks.label}` : checks.tone === "failure" ? `✗ Checks ${checks.label}` : `Checks · ${checks.label.toLowerCase()}`;
    const reviewText = !review ? "Review pending" : review.status === "completed" ? "✓ Review approved" : review.status === "changes_requested" ? "Changes requested" : "✗ Review blocked";
    const agents = [task.executor?.label ?? task.executor?.address, task.reviewer?.label ?? task.reviewer?.address].filter(Boolean).join(" → ");
    const evidence = task.evidence?.length ?? 0;
    return h_flex().id("workflow-status-chips").w_full().min_w(0).flex_wrap().gap(5).children([
      pill(t, "workflow-chip-checks", checkText, checks.tone === "normal" ? t.done : checks.tone === "failure" ? t.blocked : t.muted),
      pill(t, "workflow-chip-review", reviewText, !review ? t.muted : review.status === "completed" ? t.done : t.blocked),
      agents ? pill(t, "workflow-chip-agents", `${agents} · round ${task.round ?? 0}/${task.maxRounds ?? 2}`) : null,
      evidence ? pill(t, "workflow-chip-evidence", `${evidence} evidence`) : null,
      task.worktree?.branch ? pill(t, "workflow-chip-worktree", task.worktree.branch) : null,
    ].filter(Boolean));
  }

  overview(t, task, cx) {
    const reportedAttempt = (role) => [...(task.attempts ?? [])].reverse().find((attempt) => attempt.role === role && attempt.report);
    const implementationAttempt = reportedAttempt("executor"), reviewAttempt = reportedAttempt("reviewer");
    const implementation = implementationAttempt?.report, review = reviewAttempt?.report;
    const blocked = ["blocked", "failed"].includes(task.state);
    const primaryReport = blocked && review ? review : implementation;
    const primaryId = (blocked && review ? reviewAttempt : implementationAttempt)?.id;
    const summary = primaryReport?.summary ?? "Report available", longSummary = summary.length > SUMMARY_PREVIEW, summaryOpen = Boolean(this.expandedReports?.[primaryId]);
    const latestAttempt = task.attempts?.at(-1);
    const unresolvedAttempt = latestAttempt?.state === "running" || ["uncertain", "sending"].includes(latestAttempt?.delivery);
    const followUpAvailable = blocked && !unresolvedAttempt && ((task.round ?? 0) >= (task.maxRounds ?? 2) ||
      (task.attempts ?? []).filter((attempt) => attempt.role === "reviewer").length >= (task.maxRounds ?? 2) + 1);
    const details = this.detailsFor === task.id;
    const statusColor = task.state === "needs_you" ? t.accent : blocked ? t.blocked : task.state === "accepted" ? t.done : t.muted;
    return v_flex().w_full().min_w(0).gap(14)
      .child(v_flex().id("workflow-outcome-header").w_full().min_w(0).gap(6)
        .child(div().text_size(11).font_semibold().text_color(statusColor).child(task.state === "needs_you" ? "Ready for your review" : taskState(task.state)))
        .child(div().text_size(13).font_semibold().w_full().min_w(0).tooltip(task.title).accessibility_label(task.title).child(caption(task.title, 115)))
        .child(this.statusChips(t, task, review))
        .when(task.state !== "needs_you", (el) => el.child(row(t, this.nextStep(task)))))
      .when(Boolean(task.worktree) && task.state === "accepted", (el) => el.child(this.worktreePanel(t, task)))
      .when(Boolean(task.error), (el) => el.child(div().role("alert").text_color(t.blocked).child(task.error)))
      .when(Boolean(primaryReport), (el) => el.child(v_flex().id("workflow-summary").w_full().min_w(0).gap(6)
        .child(div().text_size(11).text_color(t.muted).child(blocked && review ? "Latest review findings" : "Summary"))
        .child(TextView.markdown(`workflow-summary-${primaryId}`, agentMarkdown(longSummary && !summaryOpen ? caption(summary, SUMMARY_PREVIEW) : summary)).selectable(true).on_link_click(() => {}).w_full().text_size(13).text_color(t.foreground))
        .when(longSummary, (el) => el.child(button(t, "workflow-summary-toggle", summaryOpen ? "Show less" : "Read full report",
          (cx) => { this.expandedReports ??= {}; this.expandedReports[primaryId] = !summaryOpen; cx.notify(); }, { kind: "ghost", size: "sm" }).self_start()))))
      .when(followUpAvailable, (el) => el
        .child(button(t, "workflow-prepare-follow-up", "Prepare follow-up", (context) => this.prepareBlockedFollowUp(task, context),
          { kind: "solid", tip: "Prefills a new task with the findings; nothing is sent until you start it" })))
      .children([this.uncertainAttempt(t, task)].filter(Boolean))
      .when(!["needs_you", "accepted", "cancelled"].includes(task.state), (el) => el.child(this.taskActions(t, task, cx)))
      .child(button(t, "workflow-details-toggle", details ? "Hide details" : "Details", (context) => {
        this.detailsFor = details ? null : task.id; context.notify();
      }, { kind: "ghost", size: "sm" }).self_start())
      .when(details, (el) => el.child(v_flex().gap(8)
        .child(row(t, task.criteria || "No acceptance criteria recorded"))
        .child(row(t, `Executor: ${task.executor?.label ?? task.executor?.address ?? "Unknown"} · Reviewer: ${task.reviewer?.label ?? task.reviewer?.address ?? "Unknown"}`))
        .child(row(t, `Rounds ${task.round ?? 0}/${task.maxRounds ?? 2} · ${task.maxMinutes ?? 20} minutes per round`))));
  }

  activity(t, task) {
    const items = (this.events ?? []).filter((event) => event.taskId === task.id);
    const attempts = task.attempts ?? [];
    return v_flex().gap(12)
      .child(div().font_semibold().child("Who did what"))
      .when(!attempts.length, (el) => el.child(row(t, "No agent assignment recorded yet.")))
      .children(attempts.map((attempt, index) => {
        const expanded = this.expandedPrompts?.includes(attempt.id);
        const delivered = attempt.delivery === "acknowledged";
        const status = attempt.delivery === "uncertain" ? "Delivery uncertain — inspect the session"
          : attempt.report ? `Report: ${taskState(attempt.report.status)}`
            : delivered ? (attempt.state === "running" ? "Assignment sent · awaiting report" : "Assignment sent")
              : attempt.delivery === "sending" ? "Sending assignment" : "Delivery not confirmed";
        return v_flex().id(`workflow-handoff-${attempt.id}`).gap(6).p(12).rounded(8).bg(t.raised)
          .child(div().font_semibold().child(`${index + 1}. Coordinator → ${attempt.role === "reviewer" ? "Reviewer" : "Implementer"}`))
          .child(row(t, `${attempt.address ?? "Unknown session"} · ${status}`))
          .when(Boolean(attempt.at), (el) => el.child(div().text_size(11).text_color(t.muted).child(attempt.at)))
          .when(Boolean(attempt.report?.summary), (el) => el.child(row(t, expanded ? attempt.report.summary : caption(attempt.report.summary, 180))))
          .child(button(t, `workflow-prompt-toggle-${attempt.id}`, expanded ? "Hide assignment & report" : "Assignment & report", (cx) => {
            this.expandedPrompts ??= []; this.expandedPrompts = expanded ? this.expandedPrompts.filter((id) => id !== attempt.id) : [...this.expandedPrompts, attempt.id]; cx.notify();
          }, { size: "sm", tip: "Read the actual instructions sent to this session and its reported result" }))
          .when(expanded, (el) => el.child(row(t, attempt.prompt ?? "No assignment text recorded.")));
      }))
      .child(v_flex().gap(5).p(12).rounded(8).border_1().border_color(t.border)
        .child(div().font_semibold().child("Your decision"))
        .child(row(t, task.state === "accepted" ? "Accepted by you" : task.state === "needs_you" ? "Waiting for your review" : task.state === "cancelled" ? "Task cancelled" : "No acceptance recorded"))
        .child(button(t, "workflow-activity-decision", "Back to result", (cx) => { this.tab = "Overview"; this.h.focus(); cx.notify(); }, { tip: "Return to the result and available decisions" })))
      .child(button(t, "workflow-event-log", this.eventLogFor === task.id ? "Hide technical log" : `Technical log · ${items.length} events`, (cx) => {
        this.eventLogFor = this.eventLogFor === task.id ? null : task.id; cx.notify();
      }, { size: "sm", tip: "Inspect coordinator checks, errors and recorded events" }))
      .when(this.eventLogFor === task.id, (el) => el.children(items.map((event) => div().w_full().min_w(0).tooltip(event.detail ?? "")
        .child(row(t, `${event.at ?? ""} · ${event.type ?? "Event"} · ${event.actor ?? "system"} · ${event.detail ?? ""}`)))));
  }

  changes(t, task) {
    const latest = ["executor", "reviewer"].map((role) => [...(task.attempts ?? [])].reverse().find((attempt) => attempt.role === role && attempt.report)).filter(Boolean);
    return v_flex().w_full().min_w(0).gap(9)
      .child(button(t, "workflow-review-diff", "Open diff", (cx) => this.openDiff(task, cx), { disabled: !task.root }))
      .child(div().font_semibold().child("Observed checks"))
      .when(!task.checksResult?.length, (el) => el.child(row(t, "No checks recorded for this task.")))
      .children((task.checksResult ?? []).map((check, index) => v_flex().w_full().min_w(0).gap(3)
        .child(row(t, (check.argv?.join(" ") ?? "Check " + (index + 1)) + " · " + (check.code === 0 ? "passed" : "failed (" + (check.code ?? "unknown") + ")")))
        .when(Boolean(this.showCheckOutput), (el) => el.child(row(t, "stdout: " + String(check.stdout ?? "").slice(-2000) + " · stderr: " + String(check.stderr ?? "").slice(-2000))))))
      .when(Boolean(task.checksResult?.length), (el) => el.child(button(t, "workflow-check-output", this.showCheckOutput ? "Hide check output" : "Show check output", (cx) => { this.showCheckOutput = !this.showCheckOutput; cx.notify(); }, { tip: "Expand recorded check output" })))
      .children(latest.map((attempt) => v_flex().w_full().min_w(0).gap(5).p(8).rounded(6).border_1().border_color(t.border)
        .child(div().font_semibold().child((attempt.role === "reviewer" ? "Independent review" : "Implementation report") + " · " + reportState(attempt.report.status)))
        .child(row(t, this.expandedReports?.[attempt.id] ? attempt.report.summary : caption(attempt.report.summary, 260)))
        .child(button(t, "workflow-report-" + attempt.id, this.expandedReports?.[attempt.id] ? "Show less" : "Read full report", (cx) => { this.expandedReports ??= {}; this.expandedReports[attempt.id] = !this.expandedReports[attempt.id]; cx.notify(); }, { tip: "Read the agent's complete report and stated limitations" }))))
;
  }

  evidence(t, task, cx) {
    const items = task.evidence ?? [];
    const adding = this.attachEvidenceFor === task.id;
    return v_flex().gap(12)
      .child(div().font_semibold().child("Evidence for this result"))
      .when(!items.length, (el) => el.child(row(t, "No evidence attached to this task yet.")))
      .children(items.map((item) => v_flex().gap(8).p(12).rounded(8).bg(t.raised).child(row(t, `${item.kind ?? "Evidence"} · ${item.label ?? item.path} · ${item.valid === false ? "Missing or altered" : task.revision && item.revision === task.revision ? "Current revision" : "Stale revision"}`))
        .child(h_flex().gap(5).child(button(t, `workflow-open-${item.id}`, "Open file", () => exec("open", [item.path]),
          { disabled: !item.path, tip: "Open this recorded local evidence file" }))
          .child(button(t, `workflow-remove-${item.id}`, "Remove", (context) => this.command({ action: "remove-artifact", taskId: task.id, artifactId: item.id }, context),
          { disabled: this.busy, size: "sm", kind: "danger", tip: "Remove this evidence record" })))))
      .child(button(t, "workflow-evidence-add", adding ? "Hide attachment form" : "+ Attach evidence", (context) => {
        this.attachEvidenceFor = adding ? null : task.id; context.notify();
      }, { size: "sm", tip: "Attach a local screenshot, video or report" }))
      .when(adding, (el) => el.child(v_flex().gap(6)
        .child(this.field(t, "path", "Local file path"))
        .child(this.field(t, "label", "Evidence label"))
        .child(h_flex().gap(5).children(["screenshot", "video", "report"].map((kind) => button(t,
          `workflow-attach-${kind}`, `Attach ${kind}`, (context) => this.command({ action: "attach", taskId: task.id,
            source: this.form.path.value().trim(), kind, label: this.form.label.value().trim() || kind }, context),
          { disabled: this.busy || !this.form.path.value().trim(), tip: `Record a local ${kind} attachment` }))))));
  }

  // The diff opens as a pane beside this one and offers Back to decision for this task.
  openDiff(task, cx) {
    cx.spawn(async (cx) => {
      try { await openReview(task.root, task.executor?.address, null, { goalId: task.goalId, taskId: task.id }); }
      catch (error) { if (!this.closed) { this.error = String(error.message ?? error); cx.notify(); } }
    });
  }

  openTools(cx) {
    this.toolsReturnTab = this.tab === "Tools" ? this.toolsReturnTab : this.tab;
    this.tab = "Tools"; this.toolPreview = null;
    this.form.toolSearch.set_value(""); this.form.toolSearch.focus(); cx.notify();
  }

  toolsPanel(t, task) {
    if (!task) return v_flex().gap(8).child(row(t, "Select a task to see its tools."));
    const navigate = (tab, cx) => { this.tab = tab; this.h.focus(); cx.notify(); };
    const entries = [
      { id: "result", label: "Review result", detail: "Inspect changes, checks and agent reports", action: (cx) => navigate("Changes", cx) },
      { id: "evidence", label: "Open evidence", detail: "Screenshots, videos and reports for this task", action: (cx) => navigate("Evidence", cx) },
      { id: "activity", label: "Who did what", detail: "See assignments and reports in order", action: (cx) => navigate("Activity", cx) },
      ...["executor", "reviewer"].filter((role) => task[role]?.address).map((role) => ({
        id: role, label: role === "executor" ? "Open implementer session" : "Open reviewer session",
        detail: `${task[role].label ?? task[role].address} · ${task[role].address}`,
        action: () => run("agent.focus", { terminal: task[role].address }),
      })),
      ...Object.entries(CONFIGURED_SKILLS).filter(([, value]) => typeof value === "string" && value.trim()).map(([name, command]) => ({
        id: `skill-${name}`, label: `Skill: ${name}`, detail: `/${command} · queue for the implementer`,
        action: (cx) => { this.toolPreview = { taskId: task.id, name, command }; cx.notify(); },
        disabled: this.busy || ["accepted", "cancelled"].includes(task.state),
      })),
      { id: "message", label: "Message the agent", detail: "Write feedback or additional context",
        disabled: ["accepted", "cancelled"].includes(task.state), action: (cx) => {
          this.messageDrafts ??= {};
          if (this.toolMessageFor) this.messageDrafts[this.toolMessageFor] = this.form.message.value();
          this.form.message.set_value(this.messageDrafts[task.id] ?? "");
          this.toolMessageFor = task.id; this.form.message.focus(); cx.notify();
        } },
      { id: "controls", label: "Task controls", detail: "Start, pause, retry or cancel this task", action: (cx) => { this.toolControlsFor = task.id; cx.notify(); } },
    ];
    const query = this.form.toolSearch.value().trim().toLowerCase();
    const visible = entries.filter((entry) => `${entry.label} ${entry.detail}`.toLowerCase().includes(query));
    const preview = this.toolPreview?.taskId === task.id ? this.toolPreview : null;
    return v_flex().w_full().min_w(0).gap(10)
      .child(h_flex().justify_between().child(div().font_semibold().child("Tools for this task"))
        .child(button(t, "workflow-tools-back", "Back to result", (cx) => navigate(this.toolsReturnTab ?? "Overview", cx), { size: "sm", tip: "Esc: leave Tools without running an action" })))
      .child(row(t, caption(task.title, 100)))
      .child(Input.new(this.form.toolSearch).id("workflow-tool-search").w_full().h(32).px(7).rounded(5).border_1().border_color(t.border).bg(t.background).accessibility_label("Find an action or skill"))
      .when(Boolean(preview), (el) => el.child(v_flex().gap(8).p(12).rounded(8).bg(t.raised)
        .child(div().font_semibold().child(`Queue /${preview.command}?`))
        .child(row(t, `Recipient: ${task.executor?.label ?? task.executor?.address ?? "Not assigned"}. Sends when the session is ready and independent review is not running.`))
        .when(task.state === "needs_you", (panel) => panel.child(row(t, "This may change the pending result. Review any new changes before accepting.")))
        .child(h_flex().gap(5)
          .child(button(t, "workflow-tool-confirm", "Queue skill", (cx) => this.command({ action: "skill", taskId: task.id, skill: preview.command, mode: "queue" }, cx, () => {
            this.toolPreview = null; this.notice = "Skill queued for the implementer's next safe turn.";
          }), { kind: "solid", disabled: this.busy || ["accepted", "cancelled"].includes(task.state), tip: "Send only this configured skill to the selected task's implementer" }))
          .child(button(t, "workflow-tool-cancel", "Cancel", (cx) => { this.toolPreview = null; cx.notify(); }, { tip: "Close the preview without sending" })))))
      .when(!visible.length, (el) => el.child(row(t, "No matching tools. Try review, evidence, session or a skill name.")))
      .children(visible.map((entry) => button(t, `workflow-tool-${entry.id}`, [v_flex().w_full().min_w(0).gap(3).text_left()
        .child(div().font_semibold().child(entry.label)).child(div().text_size(11).text_color(t.muted).child(entry.detail))], entry.action,
        { disabled: Boolean(entry.disabled), tip: entry.detail, accessibleLabel: entry.label }).w_full().h(48)))
      .when(this.toolMessageFor === task.id, (el) => el.child(this.messages(t, task)))
      .when(this.toolControlsFor === task.id, (el) => el.child(this.taskActions(t, task)));
  }

  uncertainAttempt(t, task) {
    const attempt = task.attempts?.at(-1);
    if (!attempt || attempt.delivery !== "uncertain") return null;
    const observed = agents().find((agent) => agent.address === attempt.address)?.status;
    const inspected = this.reconcileConfirmed === attempt.id;
    return v_flex().gap(5).child(row(t, `Last send is uncertain. Session status: ${observed ?? "not connected"}. Reconcile only after confirming it stopped.`))
      .child(button(t, `workflow-inspect-${attempt.id}`, "I inspected this session", (cx) => { this.reconcileConfirmed = attempt.id; cx.notify(); },
        { tip: "Inspect the matching session in Herdr before confirming it stopped" }))
      .when(inspected, (el) => el.child(button(t, `workflow-reconcile-${attempt.id}`, "Confirm stopped and unlock", (cx) => this.command({
        action: "reconcile", taskId: task.id, attemptId: attempt.id, confirmStopped: true,
      }, cx, () => { this.reconcileConfirmed = null; }), { kind: "danger", disabled: this.busy || !["idle", "done"].includes(observed),
        tip: "Unlock another attempt only when the session is idle or done" })));
  }

  messages(t, task, cx) {
    return v_flex().gap(6).child(this.field(t, "message", "Message to the workflow agent", true))
      .child(h_flex().gap(5).children([["queue", "Queue message"], ["now", "Send now"]].map(([mode, label]) => button(t,
        `workflow-message-${mode}`, label, (context) => this.command({ action: "message", taskId: task.id,
          text: this.form.message.value().trim(), mode }, context, () => {
            if (this.messageDrafts) delete this.messageDrafts[task.id];
            if (this.toolMessageFor === task.id) this.form.message.set_value("");
            this.notice = mode === "queue" ? "Message queued. Delivery status is shown below." : "Message submitted. Check its delivery status below.";
          }), { disabled: this.busy || !this.form.message.value().trim() || ["accepted", "cancelled"].includes(task.state), tip: mode === "now" && ["needs_review", "needs_you"].includes(task.state)
            ? "Send now may affect the pending review; inspect the changes again before deciding" : `${label} for the assigned agent` }))))
      .children((task.messages ?? []).map((message) => row(t, `${message.status ?? message.mode ?? "Message"} · ${message.address ?? ""} · ${message.text}`)));
  }

  preferences(t, cx) {
    const roots = new Set((this.tasks ?? []).map((task) => task.root).filter(Boolean));
    const preferences = (this.prefsData ?? []).filter((preference) => preference.scope === "goal"
      ? preference.scopeId === this.goalId : preference.scope === "project" && roots.has(preference.scopeId));
    const suggestions = this.suggestions ?? [];
    const acceptedTasks = (this.tasks ?? []).filter((task) => task.state === "accepted");
    const correctionCount = acceptedTasks.reduce((total, task) => total + Math.max(0, (task.round ?? 0) - 1), 0);
    return v_flex().gap(7).child(div().font_semibold().child("Workflow preferences"))
      .child(row(t, `Observed accepted tasks: ${acceptedTasks.length}. Accepted tasks with correction rounds: ${acceptedTasks.length ? `${correctionCount}/${acceptedTasks.length}` : "unavailable (no accepted tasks yet)"}. This is a count, not a measure of improvement.`))
      .child(row(t, `Pending and rejected guidance is never sent to agents. Accepted guidance applies to future task prompts. ${this.form.preferenceScope.value() === "project" ? `Project: ${(this.tasks ?? []).find((task) => task.id === this.selected)?.root ?? "Select a task to choose a project"}` : "Scope: this goal"}`))
      .child(this.field(t, "preference", "Preference text", true))
      .child(this.field(t, "preferenceScope", "Scope: goal or project path"))
      .child(h_flex().gap(5).children(["goal", "project"].map((scope) => button(t, `workflow-pref-scope-${scope}`, scope,
        (context) => { this.form.preferenceScope.set_value(scope); context.notify(); }, { kind: this.form.preferenceScope.value() === scope ? "solid" : "outline" }))))
      .child(button(t, "workflow-pref-propose", "Add pending preference", (context) => this.command({ action: "preference-propose", preference: {
        text: this.form.preference.value().trim(), scope: this.form.preferenceScope.value(),
        scopeId: this.form.preferenceScope.value() === "goal" ? this.goalId : (this.tasks ?? []).find((task) => task.id === this.selected)?.root,
      } }, context, () => this.form.preference.set_value("")), { disabled: this.busy || !this.form.preference.value().trim() || (this.form.preferenceScope.value() === "project" && !(this.tasks ?? []).some((task) => task.id === this.selected)), tip: "Save as pending guidance; it will not affect agents until accepted" }))
      .when(Boolean(this.preferenceEditId), (el) => el.child(button(t, "workflow-pref-save-edit", "Save preference edit", (context) => this.command({
        action: "preference-update", id: this.preferenceEditId, patch: { text: this.form.preference.value().trim() },
      }, context, () => { this.preferenceEditId = null; this.form.preference.set_value(""); }), { kind: "solid", disabled: this.busy || !this.form.preference.value().trim(), tip: "Save this edited preference" })))
      .child(button(t, "workflow-pref-suggest", "Find recurring corrections", (context) => {
        const root = (this.tasks ?? []).find((task) => task.id === this.selected)?.root;
        if (!root) { this.error = "Select a task to find preferences for its project."; context.notify(); return; }
        this.command({ action: "suggest-preferences", root }, context);
      }, { disabled: this.busy, tip: "Suggest pending preferences from repeated corrections in this project" }))
      .children(suggestions.map((suggestion) => v_flex().gap(4).child(row(t, `Suggestion: ${suggestion.text} · used in ${suggestion.sourceTaskIds?.length ?? 0} tasks`))
        .child(button(t, `workflow-pref-suggestion-${suggestion.id}`, "Add as pending", (context) => this.command({ action: "preference-propose", preference: {
          text: suggestion.text, scope: suggestion.scope, scopeId: suggestion.scopeId,
          sourceTaskId: suggestion.sourceTaskIds?.[0] ?? null, sourceDecisionId: suggestion.sourceDecisionIds?.[0] ?? null,
        } }, context), { disabled: this.busy, tip: `Save suggestion for review from ${suggestion.sourceTaskIds?.length ?? 0} corrections` }))))
      .children(preferences.map((preference) => v_flex().gap(4).child(row(t, `${preference.status} · ${preference.scope}: ${preference.text}`))
        .child(h_flex().gap(5).child(button(t, `workflow-pref-edit-${preference.id}`, "Edit", (context) => {
          this.preferenceEditId = preference.id; this.form.preference.set_value(preference.text);
          this.form.preferenceScope.set_value(preference.scope); context.notify();
        }, { disabled: this.busy, tip: "Load this preference into the edit form" }))
          .children(["pending", "accepted", "rejected"].filter((status) => status !== preference.status).map((status) => button(t,
          `workflow-pref-${preference.id}-${status}`, status, (context) => this.command({ action: "preference-update", id: preference.id, patch: { status } }, context),
          { disabled: this.busy, tip: `Mark this preference ${status}` })))
          .child(button(t, `workflow-pref-delete-${preference.id}`, "Delete", (context) => this.command({ action: "preference-delete", id: preference.id }, context),
            { disabled: this.busy, kind: "danger", tip: "Delete this preference" })))));
  }
}
