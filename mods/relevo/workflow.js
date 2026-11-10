import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { agents, panes, props, theme, exec, appHome, readTextFile, run, focused, shared, setShared, closeOverlay } from "herdr";
import { button, onSubmitChord } from "./ui.js";
import { openReview } from "./review.js";
import { focusedCwd } from "./panelbar.js";
import { SKILLS as CONFIGURED_SKILLS } from "./config.js";
import { workflowBucket, workflowItems, acceptanceEffect, queueSummary, workflowCheckSummary } from "./lib/workflow-navigation.js";
import { linkedDecision } from "./lib/goal-workflow.js";
import { readGoals } from "./goals-store.js";
import { WorkflowDraftView } from "./workflow-draft-view.js";
import { ShortcutHelp } from "./shortcut-help.js";
import { RUN_PANES, RUN_REQUEST, liveRunPanes } from "./workflow-window.js";
export { openWorkflow } from "./workflow-window.js";

const STATES = { planned: "Planned", ready: "Ready", running: "In progress", needs_review: "Needs review", needs_you: "Needs you", accepted: "Completed", completed: "Completed", blocked: "Blocked", failed: "Failed", cancelled: "Cancelled" };
const row = (t, value) => div().w_full().min_w(0).text_size(13).text_color(t.muted).child(value);
const taskState = (state) => STATES[state] ?? state ?? "Unknown";
const reportState = (state) => ({ completed: "Completed", changes_requested: "Changes requested", blocked: "Blocked" }[state] ?? taskState(state));
const caption = (value, limit = 42) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
const SUMMARY_PREVIEW = 1200;
// A terminal title follows the agent's state; the program and a named tab stay put.
const agentLabel = (agent) => {
  const name = agent.program?.name || agent.title || agent.app || agent.address;
  const tab = agent.tab_name && !/^\d+$/.test(agent.tab_name) ? agent.tab_name : null;
  return !tab ? name : tab.includes(name) ? tab : `${name} · ${tab}`;
};
const TABS = ["Overview", "Changes", "Evidence", "Activity", "Preferences"];
const WINDOW_SHORTCUTS = [
  ...TABS.map((tab, index) => ({ id: `view-${tab}`, label: ["Decision / summary", "Result / findings", "Evidence", "Activity", "Preferences"][index], fixedShortcut: String(index + 1), section: "Run window" })),
  ...[["accept", "Prepare acceptance (Enter confirms)", "a"], ["changes", "Write change request", "r"], ["new", "New task", "n"], ["plan", "Plan work", "p"], ["tools", "Task actions and skills", "t"], ["next", "Next task", "down"], ["previous", "Previous task", "up"], ["help", "Keyboard help", "?"], ["close", "Return to queue focus, then close window", "escape"]]
    .map(([id, label, fixedShortcut]) => ({ id, label, fixedShortcut, section: "Run window" })),
];

export class Workflow extends WorkflowDraftView {
  init(_props, cx) {
    this.closed = false;
    this.busy = false;
    this.tab = "Overview";
    this.filter = "Needs you";
    this.selected = null;
    this.explicitNew = false;
    this.h = cx.focus_handle();
    this.goalId = props()?.goalId;
    this.requestedTaskId = props()?.taskId;
    this.lastRequest = Date.now();
    // The split focuses the new pane, which is how this view learns its own id.
    cx.timer.after(300, () => {
      const pane = focused()?.pane;
      if (this.closed || !pane || panes().find((item) => item.pane === pane)?.mod !== "relevo") return;
      this.pane = pane;
      setShared(RUN_PANES, { ...liveRunPanes(), [this.goalId]: pane });
    });
    this.form = {
      title: InputState.new({ value: "" }), root: InputState.new({ value: "" }),
      criteria: TextareaState.new({ value: "" }), checks: InputState.new({ value: "" }),
      maxRounds: InputState.new({ value: "2" }), maxMinutes: InputState.new({ value: "20" }),
      path: InputState.new({ value: "" }), label: InputState.new({ value: "" }),
      message: TextareaState.new({ value: "" }), decision: TextareaState.new({ value: "" }),
      preference: TextareaState.new({ value: "" }), preferenceScope: InputState.new({ value: "goal" }),
      toolSearch: InputState.new({ value: "", placeholder: "Find an action or skill…" }),
      executorSearch: InputState.new({ value: "", placeholder: "Find an executor…" }),
      reviewerSearch: InputState.new({ value: "", placeholder: "Find a reviewer…" }),
      setupName: InputState.new({ value: "" }), setupPurpose: InputState.new({ value: "" }),
    };
    this.form.toolSearch.on("change", (_event, cx) => cx.notify());
    this.form.executorSearch.on("change", (_event, cx) => cx.notify());
    this.form.reviewerSearch.on("change", (_event, cx) => cx.notify());
    this.form.root.on("change", (_event, cx) => {
      this.executor = ""; this.reviewer = "";
      this.form.executorSearch.set_value(""); this.form.reviewerSearch.set_value("");
      this.setupReuseNotice = null; this.setupReuseWarning = null; cx.notify();
    });
    for (const key of ["title", "criteria"]) onSubmitChord(this.form[key], (cx) => { if (this.composing() && !this.busy) this.create(cx, { start: true }); });
    onSubmitChord(this.form.decision, (cx) => { const task = this.tasks?.find((item) => item.id === this.requestChangesFor); if (task) this.sendChanges(task, cx); });
    this.executor = "";
    this.reviewer = "";
    this.checkPreset = "none";
    this.reconcileConfirmed = null;
    this.preferenceEditId = null;
    this.initDrafts();
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
    this.persistDraft();
    this.closed = true;
    this.shortcutHelp?.close();
    this.h.release();
    Object.values(this.form).forEach((field) => field.release());
    if (this.pane && shared(RUN_PANES)?.[this.goalId] === this.pane) {
      const { [this.goalId]: _, ...rest } = liveRunPanes();
      setShared(RUN_PANES, rest);
    }
  }

  // Opening a run that already has a pane focuses it and asks it to show one task.
  takeRequest() {
    const request = shared(RUN_REQUEST);
    if (request?.goalId !== this.goalId || !(request.at > this.lastRequest)) return;
    this.lastRequest = request.at;
    const task = this.tasks?.find((item) => item.id === request.taskId);
    if (task) { this.selected = task.id; this.filter = workflowBucket(task); this.explicitNew = false; this.tab = "Overview"; }
    this.h.focus();
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
        if (initial && this.requestedTaskId) {
          const requested = this.tasks.find((task) => task.id === this.requestedTaskId);
          if (requested) { this.selected = requested.id; this.filter = workflowBucket(requested); }
        }
        if (initial && this.goal && !this.tasks.length) {
          if (this.goal.steps?.length) this.openPlan(cx);
          else if (!this.pendingDraft) {
            this.form.title.set_value(this.goal.title);
            this.form.criteria.set_value(this.goal.criteria ?? "");
            const root = focusedCwd() ?? "";
            this.form.root.set_value(root);
            this.explicitNew = true; this.taskSetupOpen = true; this.tab = "Overview";
            const setup = this.lastSetupFor(root);
            if (setup) this.applySetup(setup, cx, { quiet: true });
          }
        }
        if (this.error?.startsWith("Could not load workflow:")) this.error = null;
      } catch (error) {
        if (!this.closed && request === this.loadVersion) this.error = `Could not load workflow: ${error.message ?? error}`;
      }
      if (!this.closed && request === this.loadVersion) cx.notify();
    });
  }

  applyState(state, advance = false) {
    const previous = this.tasks?.find((task) => task.id === this.selected);
    this.allTasks = state.tasks ?? [];
    this.tasks = this.allTasks.filter((task) => task.goalId === this.goalId);
    this.plans = (state.plans ?? []).filter((plan) => plan.goalId === this.goalId);
    this.events = (state.events ?? []).filter((event) => event.goalId === this.goalId);
    this.prefsData = state.preferences ?? [];
    this.engine = state.engine ?? { enabled: false };
    if (this.batchMode && this.tasks.filter((task) => task.state === "needs_you").length < 2) {
      this.batchMode = false; this.batchIds = []; this.batchSnapshot = null; this.batchPreview = null;
    }
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
    this.batchMode = false;
    this.filter = filter; this.explicitNew = false; this.tab = "Overview";
    this.selected = workflowItems(this.tasks ?? [], filter)[0]?.id ?? null;
    this.h.focus(); cx.notify();
  }

  command(payload, sourceCx, afterSuccess = null) {
    const cx = sourceCx;
    if (this.closed || this.busy) return;
    const submittedDraft = payload.action === "create" ? this.taskDraftSnapshot() : null;
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
      this.clearSubmittedDraft(submittedDraft);
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

  create(cx, { start = false } = {}) {
    if (this.pendingDraft) { this.error = "Resume or discard the saved draft before creating another task."; cx.notify(); return; }
    const submittedFields = JSON.stringify(this.taskDraftSnapshot());
    const title = this.form.title.value().trim();
    const root = this.form.root.value().trim();
    const executor = agents().find((agent) => agent.address === this.executor);
    const reviewer = agents().find((agent) => agent.address === this.reviewer);
    const criteria = this.form.criteria.value().trim();
    const maxRounds = Number(this.form.maxRounds.value()), maxMinutes = Number(this.form.maxMinutes.value());
    const dependsOn = [...(this.dependsOn ?? [])];
    if (!title || !root || !/^\/(?:[^\0]*)$/.test(root) || !criteria || !executor || !reviewer || executor.address === reviewer.address) {
      this.taskSetupOpen = true;
      this.error = "Enter a task title, absolute repository path, expected outcome, and two different connected agents.";
      cx.notify();
      return;
    }
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5 || !Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 120) {
      this.taskAdvancedOpen = true;
      this.error = "Use 1–5 rounds and a 1–120 minute limit."; cx.notify(); return;
    }
    let checks = [];
    try {
      checks = this.checkPreset === "npm-test" ? [["npm", "test"]]
        : this.checkPreset === "custom" ? (this.form.checks.value().trim() ? JSON.parse(this.form.checks.value()) : []) : [];
      if (!Array.isArray(checks) || checks.some((args) => !Array.isArray(args) || !args.length || args.some((arg) => typeof arg !== "string"))) throw Error();
    } catch {
      this.taskAdvancedOpen = true;
      this.error = 'Checks must be JSON argv lists, such as [["npm","test"]]. Leave empty to record no checks.';
      cx.notify();
      return;
    }
    this.command({ action: "create", task: {
      goalId: this.goalId, title, root, criteria,
      executor: { address: executor.address, label: agentLabel(executor) },
      reviewer: { address: reviewer.address, label: agentLabel(reviewer) },
      checks, dependsOn, maxRounds, maxMinutes,
    }, ...(start ? { start: true } : {}) }, cx, (response) => {
      if (JSON.stringify(this.taskDraftSnapshot()) !== submittedFields) {
        this.explicitNew = true; this.selected = null;
        this.notice = "Task created. Your newer draft edits are still here.";
        return;
      }
      for (const key of ["title", "root", "criteria", "checks"]) this.form[key].set_value("");
      this.checkPreset = "none";
      this.form.maxRounds.set_value("2"); this.form.maxMinutes.set_value("20"); this.dependsOn = [];
      this.setupReuseNotice = null; this.setupReuseWarning = null;
      this.executor = "";
      this.reviewer = "";
      this.draftSnapshot = JSON.stringify(this.taskDraftSnapshot()); this.draftSaved = false;
      this.explicitNew = false;
      this.selected = response.result?.taskId ?? null;
      this.filter = "In progress";
    });
  }

  previousSuccessfulSetup() {
    const isSuccessful = (task) => {
      if (task.state === "accepted") return true;
      if (task.state !== "needs_you") return false;
      const reviewer = [...(task.attempts ?? [])].reverse().find((attempt) => attempt.role === "reviewer");
      const checks = task.checks ?? [], results = task.checksResult ?? [];
      return reviewer?.state === "reported" && reviewer.report?.status === "completed" &&
        reviewer.revision === task.revision && (!checks.length || (results.length === checks.length && results.every((check) => check.code === 0)));
    };
    return [...(this.tasks ?? [])].reverse().find((task) => task.goalId === this.goalId && isSuccessful(task)) ?? null;
  }

  usePreviousSetup(cx) {
    const task = this.previousSuccessfulSetup();
    this.applySetup(task, cx);
  }

  // The run's own last success first, else the latest task in the same repository from any run.
  lastSetupFor(root) {
    return this.previousSuccessfulSetup() ?? [...(this.allTasks ?? [])].reverse().find((task) => task.root === root && task.state !== "cancelled") ?? null;
  }

  applySetup(task, cx, { quiet = false } = {}) {
    if (!task || this.closed || this.busy) return;
    const root = task.root ?? "";
    this.form.root.set_value(root);
    this.form.executorSearch.set_value(""); this.form.reviewerSearch.set_value("");
    const available = (address) => {
      const agent = agents().find((item) => item.address === address);
      if (!agent) return null;
      const pane = panes().find((item) => item.pane === agent.pane);
      const cwd = agent.cwd ?? pane?.cwd;
      return !cwd || cwd === root ? { agent, verifyRoot: !cwd } : null;
    };
    const executorChoice = available(task.executor?.address), reviewerChoice = available(task.reviewer?.address);
    const executor = executorChoice?.agent, reviewer = reviewerChoice?.agent;
    this.executor = executor?.address ?? "";
    this.reviewer = reviewer && reviewer.address !== this.executor ? reviewer.address : "";
    this.setupReuseWarning = [!executor ? `Implementer “${task.executor?.label ?? task.executor?.address ?? "unknown"}” is unavailable` : executorChoice.verifyRoot ? `Verify implementer repository for ${agentLabel(executor)}` : null,
      !reviewer || reviewer.address === this.executor ? `Reviewer “${task.reviewer?.label ?? task.reviewer?.address ?? "unknown"}” is unavailable` : reviewerChoice.verifyRoot ? `Verify reviewer repository for ${agentLabel(reviewer)}` : null]
      .filter(Boolean).join(". ");
    this.form.maxRounds.set_value(String(task.maxRounds ?? 2));
    this.form.maxMinutes.set_value(String(task.maxMinutes ?? 20));
    const checks = task.checks ?? [];
    if (!checks.length) { this.checkPreset = "none"; this.form.checks.set_value(""); }
    else if (checks.length === 1 && checks[0]?.length === 2 && checks[0][0] === "npm" && checks[0][1] === "test") { this.checkPreset = "npm-test"; this.form.checks.set_value(""); }
    else { this.checkPreset = "custom"; this.form.checks.set_value(JSON.stringify(checks)); }
    this.taskSetupOpen = !quiet || !this.executor || !this.reviewer; this.taskAdvancedOpen = !quiet && this.checkPreset === "custom";
    this.setupReuseNotice = quiet ? null : "Previous setup applied. Review repository and agents before creating.";
    cx.notify();
  }

  taskList(t) {
    const visible = workflowItems(this.tasks ?? [], this.filter);
    const batchable = visible.filter((task) => task.state === "needs_you");
    const selecting = this.batchMode && this.filter === "Needs you" && batchable.length > 1;
    return v_flex().when(!this.compact, (el) => el.w(190).flex_none()).when(this.compact, (el) => el.w_full().flex_1()).h_full().min_h(0).min_w(0).gap(8).p(10).rounded(8).bg(t.chrome)
      .child(div().text_size(11).text_color(t.muted).child("WORK QUEUE"))
      .child(v_flex().gap(4).children(["Needs you", "In progress", "Completed"].map((filter) => button(t, `workflow-filter-${filter}`,
        `${filter === "Completed" ? "History" : filter} (${workflowItems(this.tasks ?? [], filter).length})`,
        (context) => this.selectFilter(filter, context), { selected: this.tab !== "Plan" && this.filter === filter })
        .when(this.tab !== "Plan" && this.filter === filter, (el) => el.bg(t.selected).border_color(t.accent).text_color(t.foreground)))))
      .child(v_flex().w_full().min_w(0).flex_1().min_h(0).overflow_y_scrollbar().gap(5).children((selecting ? batchable : visible).map((task) => selecting ? button(t,
        `workflow-batch-select-${task.id}`, `${this.batchIds?.includes(task.id) ? "☑" : "☐"} ${caption(task.title, 36)}`,
        (cx) => { this.batchIds ??= []; this.batchIds = this.batchIds.includes(task.id) ? this.batchIds.filter((id) => id !== task.id) : [...this.batchIds, task.id]; this.batchPreview = null; this.batchSnapshot = null; cx.notify(); },
        { selected: Boolean(this.batchIds?.includes(task.id)), tip: `Select ${task.title} for a same-project batch` }).w_full().min_w(0).h(56).overflow_hidden()
        : button(t, `workflow-task-${task.id}`,
        [v_flex().w_full().min_w(0).gap(3).text_left().child(div().w_full().min_w(0).truncate().child(task.title))
          .child(div().text_size(11).child(taskState(task.state)))],
        (context) => { this.compactQueueOpen = false; this.explicitNew = false; this.selected = task.id; this.tab = "Overview"; this.h.focus(); context.notify(); },
        { selected: this.selected === task.id, tip: task.title, accessibleLabel: `${task.title}. ${taskState(task.state)}` }).w_full().min_w(0).h(56).overflow_hidden()
        .when(this.selected === task.id && this.tab !== "Plan", (el) => el.bg(t.selected).border_color(t.accent)))))
      .child(button(t, "workflow-goal-plan", "Plan work", (context) => { this.compactQueueOpen = false; this.openPlan(context); }, { selected: this.tab === "Plan", tip: "P: connect goal outcomes to one executable plan and track accepted results" }))
      .child(button(t, "workflow-new-task", "+ New task", (context) => { this.compactQueueOpen = false; this.explicitNew = true; this.selected = null; this.tab = "Overview"; this.h.focus(); context.notify(); }, { size: "sm", tip: "Clear selection and create a goal task" }))
      .when(this.filter === "Needs you" && batchable.length > 1, (el) => el.child(button(t, "workflow-batch-toggle", selecting ? "Cancel selection" : "Review a batch", (cx) => {
        this.batchMode = !selecting; this.batchIds = []; this.batchSnapshot = null; this.batchPreview = null; cx.notify();
      }, { size: "sm", selected: Boolean(selecting), tip: "Select ready results in this list and preview their acceptance together" })))
      .when(selecting, (el) => el.child(this.batchPanel(t, batchable)));
  }

  toggleHelp(cx) {
    if (this.showHelp) { this.showHelp = false; this.h.focus(); cx.notify(); return; }
    if (!this.shortcutHelp) {
      this.shortcutHelp = new ShortcutHelp();
      this.shortcutHelp.init({ actions: WINDOW_SHORTCUTS, onClose: (context) => {
        this.showHelp = false; this.h.focus(); context.notify();
      } }, cx);
    }
    this.showHelp = true; this.shortcutHelp.focus(); cx.notify();
  }

  batchPanel(t, tasks) {
    const picked = tasks.filter((task) => this.batchIds?.includes(task.id));
    return v_flex().max_h(160).overflow_y_scrollbar().gap(4).child(row(t, `${picked.length} selected`))
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
          () => { this.batchSnapshot = null; this.batchIds = []; this.batchMode = false; }),
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
    const search = this.form[`${key}Search`], query = search.value().trim().toLowerCase();
    const other = this[key === "executor" ? "reviewer" : "executor"];
    const options = agents().map((agent) => {
      const pane = byPane.get(agent.pane);
      const cwd = agent.cwd ?? pane?.cwd;
      const shortPath = cwd && cwd.length > 32 ? `…${cwd.slice(-30)}` : cwd;
      const cwdLabel = shortPath ? ` · ${shortPath}` : " · cwd unknown (server will check)";
      const detail = `${agent.title || agent.address} · ${agent.address}${agent.tab_name ? ` · ${agent.tab_name}` : ""}${cwd ? ` · ${cwd}` : " · cwd unknown; server will check"}`;
      const fullCaption = `${agentLabel(agent)}${cwdLabel}`;
      return { agent, cwd, caption: caption(fullCaption), detail };
    }).filter(({ cwd, detail }) => (!selectedRoot || !cwd || cwd === selectedRoot) && (!query || detail.toLowerCase().includes(query)));
    return v_flex().w_full().min_w(0).gap(4).child(row(t, label))
      .child(Input.new(search).id(`workflow-${key}-search`).accessibility_label(`Find ${label.toLowerCase()}`).w_full().h(30).px(7).rounded(5).border_1().border_color(t.border).bg(t.background))
      .when(options.length === 0, (el) => el.child(row(t, query ? "No matching agents. Try another search." : "No connected agents in this repository. Open an agent there, then return here.")))
      .child(v_flex().w_full().max_h(140).overflow_y_scrollbar().gap(4).children(options.map(({ agent, caption, detail }) => button(t,
      `workflow-${key}-${agent.address}`, caption, (cx) => { this[key] = agent.address; cx.notify(); },
      { kind: this[key] === agent.address ? "solid" : "outline", disabled: agent.address === other,
        tip: agent.address === other ? `Already selected for the other role. Choose a different agent. ${detail}` : `Choose connected agent · ${detail}` }))));
  }

  repositoryPicker(t) {
    const roots = [...new Set(panes().map((pane) => pane.cwd).filter((cwd) => typeof cwd === "string" && cwd.startsWith("/")))];
    if (!roots.length) return v_flex().child(row(t, "No connected pane has a repository path. Enter one above."));
    if (this.form.root.value().trim() && !this.chooseRepository) return button(t, "workflow-change-repository", "Change repository…", (cx) => { this.chooseRepository = true; cx.notify(); }, { size: "sm", tip: "Choose another connected repository; changing it clears the selected agents" });
    return v_flex().gap(4).child(row(t, "Choose a connected repository path"))
      .child(v_flex().max_h(120).overflow_y_scrollbar().gap(4).children(roots.map((root, index) => button(t, `workflow-repository-${index}`, `Use ${caption(root.split("/").filter(Boolean).slice(-2).join("/") || root, 42)}`,
        (cx) => { this.form.root.set_value(root); this.executor = ""; this.reviewer = "";
          this.form.executorSearch.set_value(""); this.form.reviewerSearch.set_value("");
          this.setupReuseNotice = null; this.setupReuseWarning = null; this.chooseRepository = false; cx.notify(); },
        { kind: this.form.root.value().trim() === root ? "solid" : "outline", tip: `Set repository path to ${root}` }))));
  }

  taskForm(t, cx) {
    if (this.pendingDraft) return row(t, "Resume or discard the saved draft above to continue.");
    const chosen = [this.executor, this.reviewer].filter(Boolean).length;
    const fromPrompt = Boolean(this.goal && !this.goal.steps?.length && !this.tasks?.length && this.form.criteria.value().trim());
    const previousSetup = this.previousSuccessfulSetup();
    const previousChecks = previousSetup?.checks ?? [];
    const previousCheckLabel = !previousChecks.length ? "No automated checks"
      : previousChecks.length === 1 && previousChecks[0]?.length === 2 && previousChecks[0][0] === "npm" && previousChecks[0][1] === "test" ? "npm test" : "Custom checks";
    const previousRootName = previousSetup?.root?.split("/").filter(Boolean).at(-1) || "Unknown repository";
    const agentName = (address) => { const agent = agents().find((item) => item.address === address); return agent ? agentLabel(agent) : null; };
    const rootName = this.form.root.value().trim().split("/").filter(Boolean).at(-1);
    const setupLabel = chosen === 2 ? [rootName, `${agentName(this.executor)} → ${agentName(this.reviewer)}`].filter(Boolean).join(" · ") : `Repository & agents · ${chosen}/2 selected`;
    return v_flex().w_full().min_w(0).gap(12)
      .child(div().font_semibold().child(fromPrompt ? "Start run" : "New task"))
      .when(fromPrompt && !this.editRunPrompt, (el) => el.child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(13).tooltip(this.form.criteria.value()).child(this.form.criteria.value().split("\n")[0]))
        .child(button(t, "workflow-edit-prompt", "Edit prompt", (context) => { this.editRunPrompt = true; context.notify(); }, { size: "sm", tip: "Edit the prompt before creating this task" }))))
      .when(!fromPrompt || this.editRunPrompt, (el) => el
        .child(this.field(t, "title", "Task name"))
        .child(this.field(t, "criteria", "Prompt", true)))
      .when(this.draftSaved, (el) => el.child(h_flex().gap(6).items_center()
        .child(row(t, "Draft saved on this device"))
        .child(button(t, "workflow-discard-draft", "Discard draft", (context) => this.discardDraft(context), { size: "sm", disabled: this.busy, tip: "Clear this unsent task draft without changing existing work" }))))
      .when(Boolean(this.draftError), (el) => el.child(div().role("alert").text_color(t.blocked).child(`Draft not saved: ${this.draftError}`)))
      .when(Boolean(previousSetup), (el) => el.child(v_flex().gap(4).id("workflow-previous-setup")
        .child(row(t, `Previous setup · ${previousRootName} · ${previousSetup.executor?.label ?? previousSetup.executor?.address ?? "Implementer unavailable"} + ${previousSetup.reviewer?.label ?? previousSetup.reviewer?.address ?? "Reviewer unavailable"}`))
        .child(button(t, "workflow-use-previous-setup", "Use previous setup", (context) => this.usePreviousSetup(context),
          { disabled: this.busy, tip: `Copy setup from ${previousSetup.title} in this mission: ${previousSetup.root}; ${previousSetup.maxRounds ?? 2} rounds; ${previousSetup.maxMinutes ?? 20} minutes; ${previousCheckLabel} (${JSON.stringify(previousChecks)}). Title and outcome stay as drafted; nothing starts.` }))))
      .when(Boolean(this.setupReuseNotice), (el) => el.child(row(t, this.setupReuseNotice)))
      .when(Boolean(this.setupReuseWarning), (el) => el.child(row(t, this.setupReuseWarning)))
      .child(button(t, "workflow-task-setup", setupLabel, (context) => {
        this.taskSetupOpen = !this.taskSetupOpen; context.notify();
      }, { selected: Boolean(this.taskSetupOpen), tip: "Repository, implementer and independent reviewer" }))
      .when(this.taskSetupOpen, (el) => el.child(v_flex().gap(8).p(10).rounded(6).bg(t.raised)
        .child(this.setupLibrary(t))
        .child(this.field(t, "root", "Repository path"))
        .child(this.repositoryPicker(t))
        .child(this.agentPicker(t, "executor", "Implementer"))
        .child(this.agentPicker(t, "reviewer", "Independent reviewer"))))
      .child(button(t, "workflow-task-advanced", `Checks, limits & dependencies · ${this.form.maxRounds.value()} rounds · ${this.form.maxMinutes.value()} min`, (context) => {
        this.taskAdvancedOpen = !this.taskAdvancedOpen; context.notify();
      }, { size: "sm", selected: Boolean(this.taskAdvancedOpen), tip: "Optional checks and prerequisites; limits always apply" }))
      .when(this.taskAdvancedOpen, (el) => el.child(v_flex().gap(8).p(10).rounded(6).bg(t.raised)
        .child(h_flex().gap(6).child(this.field(t, "maxRounds", "Maximum rounds (1–5)"))
          .child(this.field(t, "maxMinutes", "Minutes per round (1–120)")))
        .children([["none", "No automated checks"], ["npm-test", "npm test"], ["custom", "Custom"]].map(([value, label]) => button(t, `workflow-check-preset-${value}`, label,
          (context) => { this.checkPreset = value; context.notify(); }, { selected: this.checkPreset === value, tip: value === "custom" ? "Enter custom checks as JSON argv lists" : `Use ${label}` })))
        .when(this.checkPreset === "custom", (el) => el.child(row(t, "Advanced: enter JSON argument lists, for example [[\"npm\",\"test\"]]."))
          .child(this.field(t, "checks", "Custom checks JSON")))
        .child(div().font_semibold().child("Wait for earlier tasks"))
        .child(row(t, "Only selected prerequisites must be accepted before this task can start."))
        .children((this.tasks ?? []).filter((task) => task.goalId === this.goalId && !["cancelled", "failed"].includes(task.state))
          .map((task) => button(t, `workflow-dependency-${task.id}`, `${this.dependsOn?.includes(task.id) ? "☑" : "☐"} ${caption(task.title, 50)}`,
            (context) => { this.dependsOn ??= []; this.dependsOn = this.dependsOn.includes(task.id) ? this.dependsOn.filter((id) => id !== task.id) : [...this.dependsOn, task.id]; context.notify(); },
            { tip: `Wait for acceptance of ${task.title}` })))))
      .child(h_flex().gap(6)
        .child(button(t, "workflow-start-new", this.busy ? "Starting…" : "Start", (context) => this.create(context, { start: true }),
          { kind: "solid", disabled: this.busy, tip: "⌘Enter" }))
        .child(button(t, "workflow-create", "Save for later", (context) => this.create(context), { disabled: this.busy })));
  }

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

  decisions(t, task) {
    if (task.state !== "needs_you") return null;
    const editing = this.decisionNoteFor === task.id;
    const changes = this.requestChangesFor === task.id;
    const submit = (outcome, cx) => this.submitDecision(task, outcome, cx);
    return v_flex().id("workflow-decision-card").w_full().min_w(0).gap(10).p(14).rounded(8).bg(t.raised)
      .child(div().text_size(11).text_color(t.muted).child("YOUR DECISION"))
      .when(Boolean(this.goal && linkedDecision(this.goal, this.tasks ?? []).task?.id === task.id), (el) => el.child(row(t, `Also resolves: ${this.goal.decision}`)))
      .child(h_flex().gap(5).flex_wrap()
        .child(button(t, "workflow-decide-accept", this.acceptIntent?.id === task.id && this.acceptIntent?.revision === task.revision ? "Confirm acceptance ↵" : "Accept result", (cx) => submit("accept", cx),
          { kind: "solid", size: "lg", disabled: this.busy || changes, tip: "A then Enter: accept this revision and allow eligible dependent tasks to proceed. Does not approve or merge a PR." })
          .when(!this.busy && !changes, (el) => el.bg(t.accent).text_color(t.accent_foreground)))
        .child(button(t, "workflow-decide-changes", "Request changes", (cx) => this.editDecisionNote(task, true, cx),
          { size: "lg", disabled: this.busy, tip: "R: describe what needs to change. Command/Ctrl+Enter sends the feedback." }))
        .child(button(t, "workflow-decision-diff", "Open diff", (cx) => this.openDiff(task, cx), { size: "sm", disabled: this.busy || !task.root }))
        .child(button(t, "workflow-decide-defer", "Decide later", (cx) => submit("defer", cx),
          { size: "sm", disabled: this.busy, tip: "Keep the result pending and pause further work" })))
      .child(div().text_size(11).text_color(t.muted).child(acceptanceEffect(task, this.tasks ?? [], this.engine)))
      .when(!editing, (el) => el.child(button(t, "workflow-decision-note-toggle", "Add a note (optional)", (cx) => this.editDecisionNote(task, false, cx),
        { size: "sm", tip: "Record your reasoning with your decision" })))
      .when(editing, (el) => el.child(this.field(t, "decision", changes ? "What should change?" : "Optional decision note", true).id("workflow-decision-editor")
        .on_key_down((event, cx) => {
          if (event.key !== "enter" || !(event.modifiers?.platform || event.modifiers?.control) || event.modifiers?.alt || !changes) return;
          cx.stop_propagation();
          this.sendChanges(task, cx);
        }))
        .when(changes, (panel) => panel.child(row(t, task.round >= task.maxRounds
          ? "This task reached its round limit. Prepare a follow-up with your feedback and review its settings. Nothing runs until you create and start it. The current result stays pending."
          : "Sending feedback starts another implementation and review round. The result will return here for your decision.")))
        .child(h_flex().gap(5).children([
          changes ? button(t, "workflow-send-changes", task.round >= task.maxRounds ? "Prepare follow-up" : "Send feedback",
            (cx) => task.round >= task.maxRounds ? this.prepareFollowUp(task, cx) : submit("changes", cx),
            { kind: "solid", disabled: this.busy || !this.form.decision.value().trim(), tip: task.round >= task.maxRounds ? "Prefill a new task without starting or sending anything" : "Send these changes to the assigned executor" }) : null,
          button(t, "workflow-decision-note-cancel", changes ? "Cancel request" : "Remove note", (cx) => {
            if (this.decisionDrafts) delete this.decisionDrafts[task.id];
            this.form.decision.set_value(""); this.decisionNoteFor = null; this.requestChangesFor = null; this.h.focus(); cx.notify();
          }, { disabled: this.busy, tip: "Discard this unsent note" }),
        ].filter(Boolean))));
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
    const checkSummary = workflowCheckSummary(task);
    const details = this.detailsFor === task.id;
    const metric = (label, value, color) => v_flex().flex_1().min_w(0).gap(5).p(10).rounded(6).bg(t.raised)
      .child(div().text_size(11).text_color(t.muted).child(label))
      .child(div().text_size(13).font_semibold().text_color(color ?? t.foreground).child(value));
    return v_flex().w_full().min_w(0).gap(16)
      .child(v_flex().id("workflow-outcome-header").w_full().min_w(0).gap(8).p(12).rounded(8).bg(task.state === "needs_you" ? t.selected : t.raised)
        .child(div().text_size(11).text_color(t.accent).font_semibold().child(task.state === "needs_you" ? "READY FOR YOUR REVIEW" : taskState(task.state).toUpperCase()))
        .child(div().font_semibold().w_full().min_w(0).tooltip(task.title).accessibility_label(task.title).child(caption(task.title, 115)))
        .when(task.state !== "needs_you", (el) => el.child(row(t, this.nextStep(task))))
)
      .when(Boolean(task.error), (el) => el.child(div().role("alert").text_color(t.blocked).child(task.error)))
      .child(h_flex().w_full().gap(8).items_start().children([
        metric("CHECKS", checkSummary.label,
          checkSummary.tone === "failure" ? t.blocked : checkSummary.tone === "muted" ? t.muted : t.foreground),
        metric("INDEPENDENT REVIEW", review ? reportState(review.status) : "Not reported",
          review && review.status !== "completed" ? t.blocked : t.foreground),
        metric("EVIDENCE", `${task.evidence?.length ?? 0} attached`),
      ]))
      .when(this.decisionNoteFor !== task.id && Boolean(primaryReport), (el) => el.child(v_flex().gap(5)
        .child(div().text_size(11).text_color(t.muted).child(blocked && review ? "LATEST REVIEW FINDINGS" : "AGENT SUMMARY"))
        .child(row(t, longSummary && !summaryOpen ? caption(summary, SUMMARY_PREVIEW) : summary))
        .when(longSummary, (el) => el.child(button(t, "workflow-summary-toggle", summaryOpen ? "Show less" : "Read full report",
          (cx) => { this.expandedReports ??= {}; this.expandedReports[primaryId] = !summaryOpen; cx.notify(); }, { size: "sm" })))))
      .when(followUpAvailable, (el) => el
        .child(button(t, "workflow-prepare-follow-up", "Prepare follow-up", (context) => this.prepareBlockedFollowUp(task, context),
          { kind: "solid", tip: "Prefill a new task with current findings and bounded settings; nothing is sent until you create and start it" })))
      .children([this.decisions(t, task), this.uncertainAttempt(t, task)].filter(Boolean))
      .when(!["needs_you", "accepted", "cancelled"].includes(task.state), (el) => el.child(this.taskActions(t, task, cx)))
      .child(button(t, "workflow-details-toggle", details ? "Hide task details" : "Task details", (context) => {
        this.detailsFor = details ? null : task.id; context.notify();
      }, { size: "sm", tip: "Expected outcome, assigned agents and limits. Actions are available in Tools." }))
      .when(details, (el) => el.child(v_flex().gap(8)
        .child(div().font_semibold().child(task.title))
        .child(row(t, task.criteria || "No acceptance criteria recorded"))
        .child(row(t, `Executor: ${task.executor?.label ?? task.executor?.address ?? "Unknown"} · Reviewer: ${task.reviewer?.label ?? task.reviewer?.address ?? "Unknown"}`))
        .child(row(t, `Rounds ${task.round ?? 0}/${task.maxRounds ?? 2} · time limit ${task.maxMinutes ?? 20} minutes · spend unavailable`))));
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

  emptyQueue(t) {
    if (this.explicitNew || !(this.tasks ?? []).length) return v_flex();
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
      .when(history.length > 0, (el) => el.child(button(t, "workflow-view-history", "View accepted results & history", (cx) => this.selectFilter("Completed", cx), { tip: "Inspect previous results without changing their decisions" })))
      .child(row(t, "Goal criteria and GitHub reviews remain available in Inbox."));
  }

  render() {
    this.persistDraft();
    this.takeRequest();
    const t = theme();
    const task = this.tasks?.find((item) => item.id === this.selected);
    const panel = this.tab === "Tools" ? this.toolsPanel(t, task) : this.tab === "Plan" ? this.planPanel(t) : this.tab === "Preferences" ? this.preferences(t)
      : task ? this.tab === "Activity" ? this.activity(t, task)
      : this.tab === "Changes" ? this.changes(t, task)
        : this.tab === "Evidence" ? this.evidence(t, task)
          : this.overview(t, task)
      : this.emptyQueue(t);
    return v_flex().id("workflow-dialog").accessibility_label("Run").track_focus(this.h)
      .on_size_change((size, cx) => {
        const compact = size.width < 700;
        if (this.compact !== compact) { this.compact = compact; cx.notify(); }
      })
      .on_key_down((event, cx) => {
        if (event.key === "escape") {
          if (this.acceptIntent) { this.acceptIntent = null; this.h.focus(); cx.stop_propagation(); cx.notify(); return; }
          if (this.showHelp && this.shortcutHelp) { this.shortcutHelp.key(event, cx); return; }
          cx.stop_propagation();
          if (this.compact && this.compactQueueOpen) { this.compactQueueOpen = false; this.h.focus(); cx.notify(); return; }
          if (this.tab === "Tools") { this.tab = this.toolsReturnTab ?? "Overview"; this.toolPreview = null; this.h.focus(); cx.notify(); return; }
          if (!this.h.is_focused()) { this.h.focus(); cx.notify(); }
          return;
        }
        if (this.composing() && !this.busy && event.key === "enter" && event.modifiers?.platform && !event.modifiers?.alt && !event.modifiers?.control) {
          cx.stop_propagation(); this.create(cx, { start: true }); return;
        }
        if (!this.h.is_focused() || event.modifiers?.platform || event.modifiers?.alt || event.modifiers?.control) return;
        if (task?.state === "needs_you" && !this.busy && this.tab === "Overview" && !this.showHelp) {
          if (event.key === "a" && this.requestChangesFor !== task.id) {
            this.acceptIntent = { id: task.id, revision: task.revision }; cx.stop_propagation(); cx.notify(); return;
          }
          if (event.key === "enter" && this.acceptIntent?.id === task.id && this.acceptIntent.revision === task.revision) {
            this.submitDecision(task, "accept", cx); cx.stop_propagation(); return;
          }
          if (event.key === "r") { this.editDecisionNote(task, true, cx); cx.stop_propagation(); return; }
        }
        this.acceptIntent = null;
        if (["?", "n", "p", "t", "1", "2", "3", "4", "5", "down", "up"].includes(event.key)) cx.stop_propagation();
        if (event.key === "?") this.toggleHelp(cx);
        else if (event.key === "n") { this.compactQueueOpen = false; this.selected = null; this.explicitNew = true; this.tab = "Overview"; this.showHelp = false; cx.notify(); }
        else if (event.key === "p") { this.compactQueueOpen = false; this.openPlan(cx); }
        else if (event.key === "t" && task) { this.compactQueueOpen = false; this.openTools(cx); }
        else if (["1", "2", "3", "4", "5"].includes(event.key)) { this.compactQueueOpen = false; this.tab = TABS[Number(event.key) - 1]; cx.notify(); }
        else if (["down", "up"].includes(event.key)) {
          const tasks = workflowItems(this.tasks ?? [], this.filter);
          const index = tasks.findIndex((item) => item.id === this.selected);
          const next = Math.max(0, Math.min(tasks.length - 1, index + (event.key === "down" ? 1 : -1)));
          if (tasks.length) { this.compactQueueOpen = false; this.explicitNew = false; this.selected = tasks[next].id; this.tab = "Overview"; cx.notify(); }
        }
      })
      .size_full().min_h(0).p(16).gap(14).bg(t.background).text_color(t.foreground)
      .child((this.compact ? v_flex().items_start().gap(8) : h_flex().justify_between().items_center()).w_full().min_w(0)
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().font_semibold().child("Run details"))
          .child(div().text_size(11).text_color(t.muted).truncate().child(this.goal?.title ?? "Work for this goal")))
        .child(h_flex().gap(5).flex_wrap()
          .child(button(t, "workflow-focus-queue", "?", (cx) => this.toggleHelp(cx), { tip: "Search keyboard shortcuts for this window", accessibleLabel: "Keyboard help" }))
          .when(Boolean(task), (el) => el.child(button(t, "workflow-task-tools", "Tools", (cx) => this.openTools(cx), { selected: this.tab === "Tools", tip: "T: find a skill, session or task action" })))
          .child(button(t, "workflow-tools-toggle", this.showTools ? "Hide settings" : "Settings", (cx) => { this.showTools = !this.showTools; cx.notify(); }, { tip: "Automation controls and saved preferences", selected: Boolean(this.showTools) }))
          .when(Boolean(this.pane || props()?.overlay), (el) => el.child(button(t, "workflow-close", "Close", () => this.pane ? run("pane.close", { pane: this.pane }) : closeOverlay(props().overlay))))))
      .when(this.showTools, (el) => el.child(h_flex().gap(6)
        .child(button(t, "workflow-tab-Preferences", "Preferences", (cx) => { this.tab = "Preferences"; this.h.focus(); cx.notify(); }, { tip: "5: manage guidance for future work" }))
        .when(Boolean(this.engine?.enabled), (controls) => controls.child(button(t, "workflow-engine-stop", "Pause automation", (cx) => this.command({ action: "stop" }, cx), { disabled: this.busy, tip: "Stop future dispatches across every goal; current agent sessions keep running" })))))
      .when(Boolean(this.notice), (el) => el.child(div().role("status").child(row(t, this.notice))))
      .when(Boolean(this.error), (el) => el.child(div().id("workflow-error").role("alert").text_color(t.blocked).child(this.error)))
      .when(Boolean(this.pendingDraft), (el) => el.child(this.draftRecovery(t)))
      .when(this.showHelp && Boolean(this.shortcutHelp), (el) => el.child(this.shortcutHelp.render(t)))
      .when(this.compact && Boolean(this.tasks?.length || this.goal?.steps?.length), (el) => el.child(button(t, "workflow-queue-toggle", this.compactQueueOpen ? "Back to work" : `Tasks · ${this.filter === "Completed" ? "History" : this.filter} (${workflowItems(this.tasks ?? [], this.filter).length})`, (cx) => {
        this.compactQueueOpen = !this.compactQueueOpen; this.h.focus(); cx.notify();
      }, { tip: "Switch between the task list and the current work. Drafts stay in place.", selected: Boolean(this.compactQueueOpen) })))
      .child(h_flex().items_start().h_full().flex_1().min_h(0).min_w(0).gap(20)
        .when((!this.compact || this.compactQueueOpen) && Boolean(this.tasks?.length || this.goal?.steps?.length), (el) => el.child(this.taskList(t)))
        .when(!this.compact || !this.compactQueueOpen, (el) => el.child(v_flex().flex_1().h_full().min_h(0).min_w(0).gap(16)
          .when(Boolean(task) && !["Plan", "Preferences", "Tools"].includes(this.tab), (el) => el.child(h_flex().gap(6).flex_wrap().children(TABS.slice(0, 4).map((tab, index) => button(t,
            `workflow-tab-${tab}`, tab === "Overview" ? (task.state === "needs_you" ? "Decision" : "Summary") : tab === "Changes" ? (["blocked", "failed"].includes(task.state) ? "Findings" : "Result") : tab,
            (cx) => { this.tab = tab; this.h.focus(); cx.notify(); }, { size: "sm", selected: this.tab === tab, tip: `${index + 1}: open ${tab.toLowerCase()}` })
            .when(this.tab === tab, (item) => item.border_color(t.accent).text_color(t.accent))))))
          .child(v_flex().id(`workflow-panel-${this.tab}-${this.selected ?? "queue"}`).flex_1().w_full().min_h(0).min_w(0).overflow_y_scrollbar().gap(10)
            .child(panel).when(!this.selected && !["Preferences", "Plan"].includes(this.tab) && (this.explicitNew || !(this.tasks ?? []).length), (el) => el.child(this.taskForm(t)))))));
  }
}
