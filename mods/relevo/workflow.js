import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { agents, panes, props, theme, openOverlay, closeOverlay, exec, appHome, readTextFile, run } from "herdr";
import { button } from "./ui.js";
import { openReview } from "./review.js";
import { SKILLS as CONFIGURED_SKILLS } from "./config.js";
import { workflowBucket, workflowItems, acceptanceEffect, queueSummary } from "./lib/workflow-navigation.js";
import { readGoals } from "./goals-store.js";
import { WorkflowPlan } from "./workflow-plan.js";

export function openWorkflow(goalId) {
  // Herdr dialogs consume Escape before mod handlers. A keyed window lets
  // Workflow return focus from an input without discarding its draft.
  openOverlay({ mod: "relevo", kind: "window", key: `relevo-workflow-${goalId}`, width: 850, height: 720, props: { role: "workflow", goalId } });
}

const STATES = { planned: "Planned", ready: "Ready", running: "In progress", needs_review: "Needs review", needs_you: "Needs you", accepted: "Completed", blocked: "Blocked", failed: "Failed", cancelled: "Cancelled" };
const row = (t, value) => div().w_full().min_w(0).text_size(13).text_color(t.muted).child(value);
const taskState = (state) => STATES[state] ?? state ?? "Unknown";
const caption = (value, limit = 42) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
const TABS = ["Overview", "Changes", "Evidence", "Activity", "Preferences"];

export class Workflow extends WorkflowPlan {
  init(_props, cx) {
    this.closed = false;
    this.busy = false;
    this.tab = "Overview";
    this.filter = "Needs you";
    this.selected = null;
    this.explicitNew = false;
    this.h = cx.focus_handle();
    this.goalId = props()?.goalId;
    this.form = {
      title: InputState.new({ value: "" }), root: InputState.new({ value: "" }),
      criteria: TextareaState.new({ value: "" }), checks: InputState.new({ value: "" }),
      maxRounds: InputState.new({ value: "2" }), maxMinutes: InputState.new({ value: "20" }),
      path: InputState.new({ value: "" }), label: InputState.new({ value: "" }),
      message: TextareaState.new({ value: "" }), decision: TextareaState.new({ value: "" }),
      preference: TextareaState.new({ value: "" }), preferenceScope: InputState.new({ value: "goal" }),
    };
    this.executor = "";
    this.reviewer = "";
    this.reconcileConfirmed = null;
    this.preferenceEditId = null;
    this.load(cx);
    cx.timer.every(3000, (cx) => this.load(cx));
    cx.timer.after(30, (cx) => {
      if (this.closed) return;
      this.h.focus();
      cx.notify();
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.h.release();
    Object.values(this.form).forEach((field) => field.release());
  }

  load(cx) {
    if (this.closed) return;
    const request = this.loadVersion = (this.loadVersion ?? 0) + 1;
    cx.spawn(async (cx) => {
      try {
        const [raw, goalResult] = await Promise.all([
          readTextFile(`${appHome()}/relevo-workflow/state.json`),
          readGoals().catch((error) => ({ error: error.message ?? String(error) })),
        ]);
        if (this.closed || request !== this.loadVersion) return;
        const goalRaw = goalResult.raw ?? goalResult.error;
        if (this.loadedOnce && raw === this.lastLoadedRaw && goalRaw === this.lastGoalRaw && !this.error?.startsWith("Could not load workflow:")) return;
        this.lastGoalRaw = goalRaw;
        this.goal = goalResult.doc?.goals.find((goal) => goal.id === this.goalId) ?? null;
        this.goalError = goalResult.error ? `Could not load goal: ${goalResult.error}` : null;
        const state = raw ? JSON.parse(raw) : { tasks: [], events: [] };
        const initial = !this.loadedOnce;
        this.loadedOnce = true; this.lastLoadedRaw = raw;
        this.applyState(state);
        if (initial && this.goal && !this.tasks.length) this.openPlan(cx);
        if (this.error?.startsWith("Could not load workflow:")) this.error = null;
      } catch (error) {
        if (!this.closed && request === this.loadVersion) this.error = `Could not load workflow: ${error.message ?? error}`;
      }
      if (!this.closed && request === this.loadVersion) cx.notify();
    });
  }

  applyState(state, advance = false) {
    const previous = this.tasks?.find((task) => task.id === this.selected);
    this.tasks = (state.tasks ?? []).filter((task) => task.goalId === this.goalId);
    this.plans = (state.plans ?? []).filter((plan) => plan.goalId === this.goalId);
    this.events = (state.events ?? []).filter((event) => event.goalId === this.goalId);
    this.prefsData = state.preferences ?? [];
    this.engine = state.engine ?? { enabled: false };
    if (this.explicitNew) return;
    const selected = this.tasks.find((task) => task.id === this.selected);
    const finished = selected?.state === "accepted" && previous && previous.state !== "accepted";
    if (advance || finished) {
      this.filter = "Needs you"; this.tab = "Overview";
      this.selected = workflowItems(this.tasks, this.filter)[0]?.id ?? null;
    } else if (!this.navigationInitialized) {
      const initial = workflowItems(this.tasks, "Needs you")[0] ?? workflowItems(this.tasks, "In progress")[0];
      this.selected = initial?.id ?? null; this.filter = initial ? workflowBucket(initial) : "Needs you";
    } else if (!selected) {
      this.selected = workflowItems(this.tasks, this.filter)[0]?.id ?? null;
    }
    this.navigationInitialized = true;
  }

  selectFilter(filter, cx) {
    this.filter = filter; this.explicitNew = false; this.tab = "Overview";
    this.selected = workflowItems(this.tasks ?? [], filter)[0]?.id ?? null;
    this.h.focus(); cx.notify();
  }

  command(payload, sourceCx, afterSuccess = null) {
    const cx = sourceCx;
    if (this.closed || this.busy) return;
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
    try {
      const result = await exec("node", [`${appHome()}/mods/relevo/runtime/cli.mjs`, "--home", appHome(), "command", JSON.stringify(payload)]);
      let response = {};
      try { response = JSON.parse(result.stdout || "{}"); }
      catch (parseError) {
        try { response = JSON.parse(result.stderr || "{}"); }
        catch { if (result.code !== 0) throw Error(result.stderr || parseError.message); throw parseError; }
      }
      if (response.error) throw Error(response.error);
      if (result.code !== 0) throw Error(result.stderr || "Workflow command failed");
      if (this.closed) return;
      const accepted = payload.outcome === "accept" && (payload.action === "decide" || (payload.action === "batch" && payload.preview === false));
      const changed = payload.action === "decide" && payload.outcome === "changes";
      if (response.doc?.tasks) { this.loadVersion = (this.loadVersion ?? 0) + 1; this.applyState(response.doc, accepted || changed); }
      if (accepted || changed) {
        this.notice = accepted ? "Acceptance saved. The queue has advanced." : "Feedback saved. The next result will return for your review.";
        this.tab = "Overview"; this.h.focus();
      }
      afterSuccess?.(response, cx);
      if (response.suggestions) this.suggestions = response.suggestions;
      if (response.preview) this.batchPreview = response.preview;
      if (payload.action === "batch" && payload.preview === false) this.batchPreview = null;
      this.error = null;
      await this.load(cx);
    } catch (error) {
      if (!this.closed) this.error = `Action needs attention: ${error.message ?? error}`;
    }
    if (!this.closed) {
      this.busy = false;
      cx.notify();
    }
    });
  }

  create(cx) {
    const title = this.form.title.value().trim();
    const root = this.form.root.value().trim();
    const executor = agents().find((agent) => agent.address === this.executor);
    const reviewer = agents().find((agent) => agent.address === this.reviewer);
    const criteria = this.form.criteria.value().trim();
    const maxRounds = Number(this.form.maxRounds.value()), maxMinutes = Number(this.form.maxMinutes.value());
    const dependsOn = [...(this.dependsOn ?? [])];
    if (!title || !root || !/^\/(?:[^\0]*)$/.test(root) || !criteria || !executor || !reviewer || executor.address === reviewer.address) {
      this.error = "Enter a task title, absolute repository path, expected outcome, and two different connected agents.";
      cx.notify();
      return;
    }
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5 || !Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 120) {
      this.error = "Use 1–5 rounds and a 1–120 minute limit."; cx.notify(); return;
    }
    let checks = [];
    try {
      checks = this.form.checks.value().trim() ? JSON.parse(this.form.checks.value()) : [];
      if (!Array.isArray(checks) || checks.some((args) => !Array.isArray(args) || !args.length || args.some((arg) => typeof arg !== "string"))) throw Error();
    } catch {
      this.error = 'Checks must be JSON argv lists, such as [["npm","test"]]. Leave empty to record no checks.';
      cx.notify();
      return;
    }
    this.command({ action: "create", task: {
      goalId: this.goalId, title, root, criteria,
      executor: { address: executor.address, label: executor.title || executor.address },
      reviewer: { address: reviewer.address, label: reviewer.title || reviewer.address },
      checks, dependsOn, maxRounds, maxMinutes,
    } }, cx, (response) => {
      for (const key of ["title", "root", "criteria", "checks"]) this.form[key].set_value("");
      this.form.maxRounds.set_value("2"); this.form.maxMinutes.set_value("20"); this.dependsOn = [];
      this.executor = "";
      this.reviewer = "";
      this.explicitNew = false;
      this.selected = response.result?.taskId ?? null;
      this.filter = "In progress";
    });
  }

  taskList(t, cx) {
    const visible = workflowItems(this.tasks ?? [], this.filter);
    const batchable = visible.filter((task) => task.state === "needs_you");
    return v_flex().w(190).flex_none().h_full().min_h(0).min_w(0).gap(8).p(10).rounded(8).bg(t.chrome)
      .child(div().text_size(11).text_color(t.muted).child("WORK QUEUE"))
      .child(v_flex().gap(4).children(["Needs you", "In progress", "Completed"].map((filter) => button(t, `workflow-filter-${filter}`,
        `${filter === "Completed" ? "History" : filter} (${workflowItems(this.tasks ?? [], filter).length})`,
        (context) => this.selectFilter(filter, context), { selected: this.tab !== "Plan" && this.filter === filter })
        .when(this.tab !== "Plan" && this.filter === filter, (el) => el.bg(t.selected).border_color(t.accent).text_color(t.foreground)))))
      .child(v_flex().w_full().min_w(0).flex_1().min_h(0).overflow_y_scrollbar().gap(5).children(visible.map((task) => button(t, `workflow-task-${task.id}`,
        [v_flex().w_full().min_w(0).gap(3).text_left().child(div().w_full().min_w(0).truncate().child(task.title))
          .child(div().text_size(11).child(taskState(task.state)))],
        (context) => { this.explicitNew = false; this.selected = task.id; this.tab = "Overview"; this.h.focus(); context.notify(); },
        { selected: this.selected === task.id, tip: task.title, accessibleLabel: `${task.title}. ${taskState(task.state)}` }).w_full().min_w(0).h(56).overflow_hidden()
        .when(this.selected === task.id && this.tab !== "Plan", (el) => el.bg(t.selected).border_color(t.accent)))))
      .child(button(t, "workflow-goal-plan", "Goal plan", (context) => this.openPlan(context), { selected: this.tab === "Plan", tip: "P: connect goal outcomes to one executable plan and track accepted results" }))
      .child(button(t, "workflow-new-task", "+ New task", (context) => { this.explicitNew = true; this.selected = null; this.tab = "Overview"; this.h.focus(); context.notify(); }, { size: "sm", tip: "Clear selection and create a goal task" }))
      .when(this.filter === "Needs you" && batchable.length > 1, (el) => el.child(this.batchPanel(t, batchable)));
  }

  batchPanel(t, tasks) {
    const picked = tasks.filter((task) => this.batchIds?.includes(task.id));
    return v_flex().gap(4).child(div().font_semibold().child("Bulk accept"))
      .children(tasks.map((task) => button(t, `workflow-batch-select-${task.id}`, `${this.batchIds?.includes(task.id) ? "☑" : "☐"} ${caption(task.title, 36)}`,
        (cx) => { this.batchIds ??= []; this.batchIds = this.batchIds.includes(task.id) ? this.batchIds.filter((id) => id !== task.id) : [...this.batchIds, task.id]; this.batchPreview = null; this.batchSnapshot = null; cx.notify(); },
        { tip: "Select this task for a same-project batch" })))
      .child(button(t, "workflow-batch-preview", "Preview acceptance", (cx) => {
        const ids = picked.map((task) => task.id), revisions = Object.fromEntries(picked.map((task) => [task.id, task.revision]));
        this.command({ action: "batch", ids, outcome: "accept", revisions, preview: true }, cx, (response) => {
          this.batchSnapshot = { ids, revisions, preview: response.preview ?? [] };
        });
      },
        { disabled: this.busy || picked.length < 2 || new Set(picked.map((task) => task.root)).size > 1 || new Set(picked.map((task) => task.goalId)).size > 1, tip: "Preview explicit task ids and revisions before accepting" }))
      .when(Boolean(this.batchSnapshot?.preview.length), (el) => el.child(v_flex().gap(3)
        .children(this.batchSnapshot.preview.map((item) => row(t, `${item.title}: ${item.nextEffect}`)))
        .child(button(t, "workflow-batch-confirm", "Apply bulk acceptance", (cx) => this.command({ action: "batch", ids: this.batchSnapshot.ids, outcome: "accept", revisions: this.batchSnapshot.revisions, preview: false }, cx,
          () => { this.batchSnapshot = null; this.batchIds = []; }),
          { kind: "solid", disabled: this.busy, tip: "Record acceptance for only the previewed tasks" }))));
  }

  field(t, key, label, multiline = false) {
    const Component = multiline ? Textarea : Input;
    return v_flex().w_full().min_w(0).gap(4).child(row(t, label)).child(Component.new(this.form[key]).id(`workflow-${key}`)
      .w_full().min_w(0).accessibility_label(label).h(multiline ? 64 : 30).px(7).rounded(5).border(1).border_color(t.border).bg(t.background));
  }

  agentPicker(t, key, label) {
    const byPane = new Map(panes().map((pane) => [pane.pane, pane]));
    const selectedRoot = this.form.root.value().trim();
    const options = agents().map((agent) => {
      const pane = byPane.get(agent.pane);
      const cwd = agent.cwd ?? pane?.cwd;
      const shortPath = cwd && cwd.length > 32 ? `…${cwd.slice(-30)}` : cwd;
      const cwdLabel = shortPath ? ` · ${shortPath}` : " · cwd unknown (server will check)";
      const detail = `${agent.title || agent.address} · ${agent.address}${agent.tab_name ? ` · ${agent.tab_name}` : ""}${cwd ? ` · ${cwd}` : " · cwd unknown; server will check"}`;
      const fullCaption = `${agent.title || agent.address} · ${agent.address}${agent.tab_name ? ` · ${agent.tab_name}` : ""}${cwdLabel}`;
      return { agent, cwd, caption: caption(fullCaption), detail };
    }).filter(({ cwd }) => !selectedRoot || !cwd || cwd === selectedRoot);
    return v_flex().w_full().min_w(0).gap(4).child(row(t, label)).children(options.map(({ agent, caption, detail }) => button(t,
      `workflow-${key}-${agent.address}`, caption, (cx) => { this[key] = agent.address; cx.notify(); },
      { kind: this[key] === agent.address ? "solid" : "outline", tip: `Choose connected agent · ${detail}` })));
  }

  repositoryPicker(t) {
    const roots = [...new Set(panes().map((pane) => pane.cwd).filter((cwd) => typeof cwd === "string" && cwd.startsWith("/")))];
    if (!roots.length) return v_flex().child(row(t, "No connected pane has a repository path. Enter one above."));
    return v_flex().gap(4).child(row(t, "Choose a connected repository path"))
      .children(roots.map((root, index) => button(t, `workflow-repository-${index}`, `Use ${caption(root.split("/").filter(Boolean).at(-1) || root, 32)}`,
        (cx) => { this.form.root.set_value(root); this.executor = ""; this.reviewer = ""; cx.notify(); },
        { kind: this.form.root.value().trim() === root ? "solid" : "outline", tip: `Set repository path to ${root}` })));
  }

  taskForm(t, cx) {
    return v_flex().w_full().min_w(0).gap(7).child(div().font_semibold().w_full().min_w(0).child("Create task"))
      .child(this.field(t, "title", "Task title"))
      .child(this.field(t, "root", "Repository path"))
      .child(this.repositoryPicker(t))
      .child(this.field(t, "criteria", "Acceptance criteria", true))
      .child(row(t, "Dictation and speech-to-text are supported in this field. Text is saved only when you choose Create task."))
      .child(this.agentPicker(t, "executor", "Executor agent"))
      .child(this.agentPicker(t, "reviewer", "Reviewer agent"))
      .child(h_flex().gap(6).child(this.field(t, "maxRounds", "Maximum rounds (1–5)"))
        .child(this.field(t, "maxMinutes", "Minutes per round (1–120)")))
      .child(div().font_semibold().pt(4).child("Dependencies"))
      .child(row(t, "Choose earlier tasks that must be accepted first; no dependency is selected automatically."))
      .children((this.tasks ?? []).filter((task) => task.id !== this.selected && task.goalId === this.goalId && !["cancelled", "failed"].includes(task.state))
        .map((task) => button(t, `workflow-dependency-${task.id}`, `${this.dependsOn?.includes(task.id) ? "☑" : "☐"} ${task.title} · ${taskState(task.state)}`,
          (context) => { this.dependsOn ??= []; this.dependsOn = this.dependsOn.includes(task.id) ? this.dependsOn.filter((id) => id !== task.id) : [...this.dependsOn, task.id]; context.notify(); },
          { tip: "Select this prerequisite task" })))
      .child(div().font_semibold().pt(4).child("Advanced checks"))
      .child(row(t, "Optional JSON argv lists. Empty means no checks; no command is guessed."))
      .child(this.field(t, "checks", "Checks JSON"))
      .child(button(t, "workflow-create", this.busy ? "Creating…" : "Create task", (context) => this.create(context), {
        kind: "solid", disabled: this.busy, tip: "Create a planned task; this does not launch an agent session",
      }));
  }

  taskActions(t, task, cx) {
    const action = (label, name, tip) => button(t, `workflow-action-${name}`, label,
      (context) => this.command({ action: name, taskId: task.id }, context), { disabled: this.busy, tip });
    const actions = [];
    const planDraft = task.planId && (this.plans ?? []).some((plan) => plan.id === task.planId && plan.state === "planned");
    const cancelledDependency = (task.dependsOn ?? []).some((id) => this.tasks?.find((item) => item.id === id)?.state === "cancelled");
    if (planDraft) actions.push(button(t, "workflow-action-plan", "View plan", (context) => this.openPlan(context), { tip: "Start all planned tasks together from Goal plan" }));
    if (!planDraft && !cancelledDependency && (task.state === "planned" || (task.state === "ready" && !this.engine?.enabled)) && !task.paused) actions.push(action("Start", "start", "Start the chosen existing sessions"));
    const last = task.attempts?.at(-1);
    if (task.state === "blocked" && last?.role === "reviewer" && last.state === "reported") {
      actions.push(action("Retry review", "retry-review", "Ask the independent reviewer to reassess the same checked revision; the coordinator verifies it is unchanged"));
    }
    if (["blocked", "failed"].includes(task.state) && !task.paused) actions.push(action("Retry", "start", "Start a new bounded attempt after reviewing the reported issue"));
    if (!planDraft && task.paused && !["needs_you", "accepted", "cancelled"].includes(task.state)) actions.push(action("Resume", "resume", "Resume dispatches for this task"));
    else if (!task.paused && ["running", "ready", "planned", "needs_review", "needs_you", "blocked"].includes(task.state)) actions.push(action("Pause", "pause", "Pause new dispatches; an active agent may finish"));
    if (!["accepted", "cancelled"].includes(task.state)) actions.push(action("Cancel", "cancel", "Cancel task and request an interrupt if an agent is running"));
    actions.push(action("Refresh", "refresh", "Refresh checkout and evidence status"));
    return h_flex().gap(5).children(actions);
  }

  editDecisionNote(task, changes, cx) {
    this.decisionDrafts ??= {};
    if (this.decisionNoteFor) this.decisionDrafts[this.decisionNoteFor] = this.form.decision.value();
    this.form.decision.set_value(this.decisionDrafts[task.id] ?? "");
    this.decisionNoteFor = task.id; this.requestChangesFor = changes ? task.id : null; cx.notify();
  }

  prepareFollowUp(task, cx) {
    this.form.title.set_value(`Follow up: ${task.title}`.slice(0, 240));
    this.form.root.set_value(task.root ?? "");
    this.form.criteria.set_value(`${task.criteria ?? ""}\nRequested changes: ${this.form.decision.value().trim()}`);
    this.form.checks.set_value(JSON.stringify(task.checks ?? []));
    this.form.maxRounds.set_value(String(task.maxRounds ?? 2));
    this.form.maxMinutes.set_value(String(task.maxMinutes ?? 20));
    this.executor = task.executor?.address ?? ""; this.reviewer = task.reviewer?.address ?? "";
    this.dependsOn = []; this.selected = null; this.explicitNew = true; this.tab = "Overview";
    this.form.decision.set_value(""); this.decisionNoteFor = null; this.requestChangesFor = null;
    cx.notify();
  }

  decisions(t, task) {
    if (task.state !== "needs_you") return null;
    const editing = this.decisionNoteFor === task.id;
    const changes = this.requestChangesFor === task.id;
    const submit = (outcome, cx) => this.command({ action: "decide", taskId: task.id,
      outcome, text: editing ? this.form.decision.value() : "", revision: task.revision ?? "" }, cx, () => {
      if (this.decisionDrafts) delete this.decisionDrafts[task.id];
      this.form.decision.set_value(""); this.decisionNoteFor = null; this.requestChangesFor = null;
    });
    return v_flex().id("workflow-decision-card").w_full().min_w(0).gap(10).p(14).rounded(8).bg(t.raised)
      .child(div().text_size(11).text_color(t.muted).child("YOUR DECISION"))
      .child(h_flex().gap(5)
        .child(button(t, "workflow-decide-accept", "Accept result", (cx) => submit("accept", cx),
          { kind: "solid", size: "lg", disabled: this.busy || changes, tip: "Accept this revision and allow dependent tasks to proceed. Does not approve or merge a PR." })
          .when(!this.busy && !changes, (el) => el.bg(t.accent).text_color(t.accent_foreground)))
        .child(button(t, "workflow-decide-changes", "Request changes", (cx) => this.editDecisionNote(task, true, cx),
          { size: "lg", disabled: this.busy, tip: "Describe what needs to change before sending it to the executor" }))
        .child(button(t, "workflow-decide-defer", "Decide later", (cx) => submit("defer", cx),
          { size: "sm", disabled: this.busy, tip: "Keep the result pending and pause further work" })))
      .child(div().text_size(11).text_color(t.muted).child(acceptanceEffect(task, this.tasks ?? [], this.engine)))
      .when(!editing, (el) => el.child(button(t, "workflow-decision-note-toggle", "Add a note (optional)", (cx) => this.editDecisionNote(task, false, cx),
        { size: "sm", tip: "Record your reasoning with your decision" })))
      .when(editing, (el) => el.child(this.field(t, "decision", changes ? "What should change?" : "Optional decision note", true))
        .when(changes, (panel) => panel.child(row(t, task.round >= task.maxRounds
          ? "This task reached its round limit. Prepare a follow-up with your feedback and review its settings. Nothing runs until you create and start it. The current result stays pending."
          : "Sending feedback starts another implementation and review round. The result will return here for your decision.")))
        .child(h_flex().gap(5).children([
          changes ? button(t, "workflow-send-changes", task.round >= task.maxRounds ? "Prepare follow-up" : "Send feedback",
            (cx) => task.round >= task.maxRounds ? this.prepareFollowUp(task, cx) : submit("changes", cx),
            { kind: "solid", disabled: this.busy || !this.form.decision.value().trim(), tip: task.round >= task.maxRounds ? "Prefill a new task without starting or sending anything" : "Send these changes to the assigned executor" }) : null,
          button(t, "workflow-decision-note-cancel", changes ? "Cancel request" : "Remove note", (cx) => {
            if (this.decisionDrafts) delete this.decisionDrafts[task.id];
            this.form.decision.set_value(""); this.decisionNoteFor = null; this.requestChangesFor = null; cx.notify();
          }, { disabled: this.busy, tip: "Discard this unsent note" }),
        ].filter(Boolean))));
  }

  nextStep(task) {
    if (task.state === "needs_you") return "The agents have finished. Review the result below, then accept it or request changes. You do not need to open their sessions.";
    if (task.state === "accepted") return "Accepted and saved in History. This task no longer needs your attention.";
    if (task.state === "cancelled") return "This task was cancelled. No more work will be assigned. Create a new task if you want to continue.";
    if (task.state === "blocked" || task.state === "failed") return "This task needs attention. Read the issue below, inspect the activity if needed, then retry when it is resolved.";
    if (task.state === "ready") {
      const pending = (task.dependsOn ?? []).map((id) => this.tasks?.find((item) => item.id === id)).filter((item) => !item || item.state !== "accepted");
      const continuation = this.engine?.enabled && !task.paused ? "This task continues automatically once its prerequisite is accepted." : "After the prerequisite is accepted, resume this task or start automation to continue.";
      const cancelled = pending.find((item) => item?.state === "cancelled");
      if (cancelled) return `The prerequisite “${cancelled.title}” was cancelled. This task cannot start automatically. Cancel this task and prepare an updated plan, or create a separate task with the prerequisites you need.`;
      const blocked = pending.find((item) => ["blocked", "failed"].includes(item?.state));
      if (blocked) return `Waiting for “${blocked.title}” to be resolved and accepted. Open that task in Needs you to inspect the issue. ${continuation}`;
      if (pending.length) return `Waiting for your acceptance of ${pending.map((item) => item?.title ?? "a prerequisite task").join(", ")}. ${continuation}`;
    }
    if (task.paused) return "This task is paused. Choose Resume when you want the coordinator to continue.";
    if (task.state === "planned" && task.planId) return "This task belongs to a saved plan. Open Goal plan and choose Start plan once for the whole sequence.";
    if (task.state === "ready" && this.engine?.enabled) return "Queued for an available agent. The plan is already started; no further action is needed. Checks and independent review will follow automatically.";
    if (task.state === "planned" || task.state === "ready") return "Choose Start to assign this task. The coordinator will run checks, request independent review and bring the result back here.";
    if (task.state === "needs_review") return "Independent review is in progress. You can leave this screen; the result will appear in Needs you when it is ready.";
    return "Work is in progress. You can leave this screen; checks and independent review will follow automatically.";
  }

  overview(t, task, cx) {
    const focusAgent = (role, person) => person?.address ? button(t, `workflow-focus-${role}`, `Open ${role} session`,
      () => { const overlay = props()?.overlay; run("agent.focus", { terminal: person.address }); closeOverlay(overlay); }, { tip: `Optional: inspect the existing ${role} session` }) : null;
    const latest = (role) => [...(task.attempts ?? [])].reverse().find((attempt) => attempt.role === role && attempt.report)?.report;
    const implementation = latest("executor"), review = latest("reviewer");
    const checks = task.checksResult ?? [];
    const details = this.detailsFor === task.id;
    const metric = (label, value, color) => v_flex().flex_1().min_w(0).gap(5).p(10).rounded(6).bg(t.raised)
      .child(div().text_size(11).text_color(t.muted).child(label))
      .child(div().text_size(13).font_semibold().text_color(color ?? t.foreground).child(value));
    return v_flex().w_full().min_w(0).gap(16)
      .child(v_flex().id("workflow-outcome-header").w_full().min_w(0).gap(8).pl(12).border_l(3).border_color(task.state === "needs_you" ? t.accent : t.border)
        .child(div().text_size(11).text_color(t.accent).font_semibold().child(task.state === "needs_you" ? "READY FOR YOUR REVIEW" : taskState(task.state).toUpperCase()))
        .child(div().font_semibold().w_full().min_w(0).tooltip(task.title).accessibility_label(task.title).child(caption(task.title, 115)))
        .when(task.state !== "needs_you", (el) => el.child(row(t, this.nextStep(task))))
        .when(task.state === "needs_you", (el) => el.child(row(t, "Review the evidence, then decide."))))
      .when(Boolean(task.error), (el) => el.child(div().role("alert").text_color(t.blocked).child(task.error)))
      .child(h_flex().w_full().gap(8).items_start().children([
        metric("CHECKS", checks.length ? `${checks.filter((check) => check.code === 0).length}/${checks.length} passed` : "Not recorded",
          checks.some((check) => check.code !== 0) ? t.blocked : t.foreground),
        metric("INDEPENDENT REVIEW", review ? (review.status === "completed" ? "Completed" : taskState(review.status)) : "Not reported",
          review && review.status !== "completed" ? t.blocked : t.foreground),
        metric("EVIDENCE", `${task.evidence?.length ?? 0} attached`),
      ]))
      .when(this.decisionNoteFor !== task.id && Boolean(implementation), (el) => el.child(v_flex().gap(5)
        .child(div().text_size(11).text_color(t.muted).child("AGENT SUMMARY"))
        .child(row(t, caption(implementation.summary ?? "Implementation report available", 160)))))
      .child(h_flex().gap(5)
        .child(button(t, "workflow-inspect-result", "Review result", (context) => { this.tab = "Changes"; this.h.focus(); context.notify(); },
          { size: "lg", tip: "2: inspect the diff, recorded checks and full agent reports before deciding" }))
        .child(button(t, "workflow-inspect-evidence", "Open evidence", (context) => { this.tab = "Evidence"; this.h.focus(); context.notify(); },
          { tip: "3: inspect attached screenshots, videos and reports" })))
      .children([this.decisions(t, task), this.uncertainAttempt(t, task)].filter(Boolean))
      .when(!["needs_you", "accepted", "cancelled"].includes(task.state), (el) => el.child(this.taskActions(t, task, cx)))
      .child(button(t, "workflow-details-toggle", details ? "Hide details" : "Details, agents & skills", (context) => {
        this.detailsFor = details ? null : task.id; context.notify();
      }, { size: "sm", tip: "Optional: expected outcome, sessions, limits, messages and skills" }))
      .when(details, (el) => el.child(v_flex().gap(8)
        .child(div().font_semibold().child(task.title))
        .child(row(t, task.criteria || "No acceptance criteria recorded"))
        .child(row(t, `Executor: ${task.executor?.label ?? task.executor?.address ?? "Unknown"} · Reviewer: ${task.reviewer?.label ?? task.reviewer?.address ?? "Unknown"}`))
        .child(row(t, `Rounds ${task.round ?? 0}/${task.maxRounds ?? 2} · time limit ${task.maxMinutes ?? 20} minutes · spend unavailable`))
        .child(h_flex().gap(5).children([focusAgent("executor", task.executor), focusAgent("reviewer", task.reviewer)].filter(Boolean)))
        .when(["needs_you", "accepted", "cancelled"].includes(task.state), (panel) => panel.child(this.taskActions(t, task, cx)))
        .child(this.messages(t, task, cx)).child(this.skillActions(t, task))));
  }

  activity(t, task) {
    const items = (this.events ?? []).filter((event) => event.taskId === task.id);
    const attempts = (task.attempts ?? []).filter((attempt) => attempt.prompt);
    return v_flex().gap(6)
      .when(!items.length && !attempts.length, (el) => el.child(row(t, "No activity recorded yet.")))
      .children(items.map((event) => div().w_full().min_w(0).tooltip(event.detail ?? "")
        .child(row(t, `${event.at ?? ""} · ${event.type ?? "Event"} · ${event.actor ?? "system"} · ${caption(event.detail ?? "", 180)}`))))
      .children(attempts.map((attempt) => v_flex().w_full().min_w(0).gap(3)
        .child(h_flex().w_full().min_w(0).justify_between().items_center()
          .child(row(t, `${attempt.role ?? "Agent"} assignment · ${attempt.address ?? ""}`))
          .child(button(t, `workflow-prompt-toggle-${attempt.id}`, this.expandedPrompts?.includes(attempt.id) ? "Hide assignment" : "Show assignment",
            (cx) => { this.expandedPrompts ??= []; this.expandedPrompts = this.expandedPrompts.includes(attempt.id) ? this.expandedPrompts.filter((id) => id !== attempt.id) : [...this.expandedPrompts, attempt.id]; cx.notify(); },
            { tip: "Expand the recorded assignment instructions" })))
        .when(this.expandedPrompts?.includes(attempt.id), (el) => el.child(div().w_full().min_w(0).max_h(180).overflow_y_scrollbar().child(attempt.prompt)))));
  }

  changes(t, task) {
    const latest = ["executor", "reviewer"].map((role) => [...(task.attempts ?? [])].reverse().find((attempt) => attempt.role === role && attempt.report)).filter(Boolean);
    return v_flex().w_full().min_w(0).gap(9)
      .child(button(t, "workflow-review-diff", "Open native diff review", (cx) => {
        const overlay = props()?.overlay;
        cx.spawn(async (cx) => { try { await openReview(task.root, task.executor?.address); closeOverlay(overlay); }
          catch (error) { if (!this.closed) { this.error = String(error.message ?? error); cx.notify(); } } });
      }, { disabled: !task.root, tip: "Review changes in this task checkout" }))
      .child(div().font_semibold().child("Observed checks"))
      .when(!task.checksResult?.length, (el) => el.child(row(t, "No checks recorded for this task.")))
      .children((task.checksResult ?? []).map((check, index) => v_flex().w_full().min_w(0).gap(3)
        .child(row(t, (check.argv?.join(" ") ?? "Check " + (index + 1)) + " · " + (check.code === 0 ? "passed" : "failed (" + (check.code ?? "unknown") + ")")))
        .when(Boolean(this.showCheckOutput), (el) => el.child(row(t, "stdout: " + String(check.stdout ?? "").slice(0, 2000) + " · stderr: " + String(check.stderr ?? "").slice(0, 2000))))))
      .when(Boolean(task.checksResult?.length), (el) => el.child(button(t, "workflow-check-output", this.showCheckOutput ? "Hide check output" : "Show check output", (cx) => { this.showCheckOutput = !this.showCheckOutput; cx.notify(); }, { tip: "Expand recorded check output" })))
      .children(latest.map((attempt) => v_flex().w_full().min_w(0).gap(5).p(8).rounded(6).border_1().border_color(t.border)
        .child(div().font_semibold().child((attempt.role === "reviewer" ? "Independent review" : "Implementation report") + " · " + attempt.report.status))
        .child(row(t, this.expandedReports?.[attempt.id] ? attempt.report.summary : caption(attempt.report.summary, 260)))
        .child(button(t, "workflow-report-" + attempt.id, this.expandedReports?.[attempt.id] ? "Show less" : "Read full report", (cx) => { this.expandedReports ??= {}; this.expandedReports[attempt.id] = !this.expandedReports[attempt.id]; cx.notify(); }, { tip: "Read the agent's complete report and stated limitations" }))))
      .child(row(t, "Agent reports do not establish human acceptance. Earlier attempts remain in Activity."))
      .children([this.decisions(t, task)].filter(Boolean));
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

  skillActions(t, task) {
    const skills = Object.entries(CONFIGURED_SKILLS).filter(([, value]) => typeof value === "string" && value.trim());
    if (!skills.length) return v_flex().child(row(t, "No workflow skills are configured."));
    return v_flex().gap(5).child(div().font_semibold().child("Configured skills"))
      .children(skills.map(([name, command]) => button(t, `workflow-skill-${name}`, `Run ${name}`,
        (cx) => this.command({ action: "skill", taskId: task.id, skill: command, mode: "queue" }, cx),
        { disabled: this.busy || ["accepted", "cancelled"].includes(task.state), tip: `Queue configured skill ${name} for the executor` })));
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
          text: this.form.message.value().trim(), mode }, context), { disabled: this.busy || !this.form.message.value().trim(), tip: mode === "now" && ["needs_review", "needs_you"].includes(task.state)
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

  emptyQueue(t) {
    if (this.explicitNew || !(this.tasks ?? []).length) return v_flex().gap(6)
      .child(div().font_semibold().child("Plan a task"))
      .child(row(t, "Define the result once. After Start, implementation, checks and review run automatically until a decision is needed."));
    const summary = queueSummary(this.tasks ?? [], this.engine);
    const active = workflowItems(this.tasks ?? [], "In progress");
    const history = workflowItems(this.tasks ?? [], "Completed");
    return v_flex().w_full().gap(12).p(16)
      .child(div().font_semibold().child(this.filter === "Needs you" ? summary.title : this.filter === "In progress" ? "No work in progress" : "No completed tasks yet"))
      .child(row(t, this.filter === "Needs you" ? summary.detail : "Choose another list to see your tasks."))
      .when(this.filter === "Needs you" && active.length > 0, (el) => el
        .children(active.slice(0, 4).map((task) => row(t, `${task.title} · ${task.paused ? "Paused" : taskState(task.state)}`)))
        .child(button(t, "workflow-view-active", "View ongoing work", (cx) => this.selectFilter("In progress", cx), { tip: "Inspect progress without starting anything" })))
      .when(Boolean(this.goal?.steps?.some((step) => step.state !== "done")), (el) => el.child(button(t, "workflow-continue-goal", "Continue goal plan", (cx) => this.openPlan(cx), { kind: "solid", tip: "Review remaining outcomes and prepare their execution together" })))
      .child(button(t, "workflow-back-goal", "Back to goal", () => closeOverlay(props()?.overlay), { kind: this.goal?.steps?.some((step) => step.state !== "done") ? "outline" : "solid", tip: "Return to Inbox; your acceptance is already saved" }))
      .when(history.length > 0, (el) => el.child(button(t, "workflow-view-history", "View accepted results & history", (cx) => this.selectFilter("Completed", cx), { tip: "Inspect previous results without changing their decisions" })))
      .child(row(t, "Goal criteria and GitHub reviews remain available in Inbox."));
  }

  render() {
    const t = theme();
    const overlay = props()?.overlay;
    const task = this.tasks?.find((item) => item.id === this.selected);
    const panel = this.tab === "Plan" ? this.planPanel(t) : this.tab === "Preferences" ? this.preferences(t)
      : task ? this.tab === "Activity" ? this.activity(t, task)
      : this.tab === "Changes" ? this.changes(t, task)
        : this.tab === "Evidence" ? this.evidence(t, task)
          : this.overview(t, task)
      : this.emptyQueue(t);
    return v_flex().id("workflow-dialog").role("dialog").accessibility_label("Goal workflow").track_focus(this.h)
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .on_key_down((event, cx) => {
        if (event.key === "escape") {
          cx.stop_propagation();
          if (!this.h.is_focused()) {
            this.h.focus(); cx.notify(); return;
          }
          closeOverlay(overlay); return;
        }
        if (!this.h.is_focused() || event.modifiers?.platform || event.modifiers?.alt || event.modifiers?.control) return;
        if (event.key === "?") { this.showHelp = !this.showHelp; cx.notify(); }
        else if (event.key === "n") { this.selected = null; this.explicitNew = true; this.tab = "Overview"; this.showHelp = false; cx.notify(); }
        else if (event.key === "p") { this.openPlan(cx); }
        else if (["1", "2", "3", "4", "5"].includes(event.key)) { this.tab = TABS[Number(event.key) - 1]; cx.notify(); }
        else if (["arrowdown", "arrowup"].includes(event.key)) {
          const tasks = workflowItems(this.tasks ?? [], this.filter);
          const index = tasks.findIndex((item) => item.id === this.selected);
          const next = Math.max(0, Math.min(tasks.length - 1, index + (event.key === "arrowdown" ? 1 : -1)));
          if (tasks.length) { this.selected = tasks[next].id; cx.notify(); }
        }
      })
      .size_full().min_h(0).p(16).gap(14).bg(t.popover ?? t.surface).text_color(t.foreground)
      .child(h_flex().w_full().min_w(0).justify_between().items_center()
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().font_semibold().child("Workflow"))
          .child(div().text_size(11).text_color(t.muted).truncate().child(this.goal?.title ?? "Work for this goal")))
        .child(h_flex().gap(5)
          .child(button(t, "workflow-focus-queue", "?", (cx) => { this.showHelp = !this.showHelp; this.h.focus(); cx.notify(); }, { tip: "Keyboard help: show shortcuts and focus the queue", accessibleLabel: "Keyboard help" }))
          .child(button(t, "workflow-tools-toggle", this.showTools ? "Hide controls" : "Controls", (cx) => { this.showTools = !this.showTools; cx.notify(); }, { tip: "Automation controls and saved preferences", selected: Boolean(this.showTools) }))
          .child(button(t, "workflow-close", "Close", () => closeOverlay(overlay), { tip: "Close workflow" }))))
      .when(this.showTools, (el) => el.child(h_flex().gap(6)
        .child(button(t, "workflow-tab-Preferences", "Preferences", (cx) => { this.tab = "Preferences"; this.h.focus(); cx.notify(); }, { tip: "5: manage guidance for future work" }))
        .when(Boolean(this.engine?.enabled), (controls) => controls.child(button(t, "workflow-engine-stop", "Pause automation", (cx) => this.command({ action: "stop" }, cx), { disabled: this.busy, tip: "Stop future dispatches across every goal; current agent sessions keep running" })))))
      .when(Boolean(this.notice), (el) => el.child(div().role("status").child(row(t, this.notice))))
      .when(Boolean(this.error), (el) => el.child(div().id("workflow-error").role("alert").text_color(t.blocked).child(this.error)))
      .when(this.showHelp, (el) => el.child(row(t, "Keyboard: 1 decision · 2 result · 3 evidence · 4 activity · 5 preferences · P plan · ↑/↓ tasks · N new · Esc returns focus to the queue; Esc again closes. Typing never triggers shortcuts.")))
      .child(h_flex().items_start().h_full().flex_1().min_h(0).min_w(0).gap(20).child(this.taskList(t))
        .child(v_flex().flex_1().h_full().min_h(0).min_w(0).gap(16)
          .when(Boolean(task) && !["Plan", "Preferences"].includes(this.tab), (el) => el.child(h_flex().gap(6).children(TABS.slice(0, 4).map((tab, index) => button(t,
            `workflow-tab-${tab}`, tab === "Overview" ? (task.state === "needs_you" ? "Decision" : "Summary") : tab === "Changes" ? "Result" : tab,
            (cx) => { this.tab = tab; this.h.focus(); cx.notify(); }, { size: "sm", selected: this.tab === tab, tip: `${index + 1}: open ${tab.toLowerCase()}` })
            .when(this.tab === tab, (item) => item.border_color(t.accent).text_color(t.accent))))))
          .child(v_flex().id(`workflow-panel-${this.tab}-${this.selected ?? "queue"}`).flex_1().w_full().min_h(0).min_w(0).overflow_y_scrollbar().gap(10)
            .child(panel).when(!this.selected && !["Preferences", "Plan"].includes(this.tab) && (this.explicitNew || !(this.tasks ?? []).length), (el) => el.child(this.taskForm(t))))));
  }
}
