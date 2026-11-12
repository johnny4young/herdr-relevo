import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { agents, panes, props, theme, exec, appHome, readTextFile, run, focused, shared, setShared, closeOverlay } from "herdr";
import { button, onSubmitChord, tabButton } from "./ui.js";
import { focusedCwd } from "./panelbar.js";
import { workflowBucket, workflowItems, queueSummary } from "./lib/workflow-navigation.js";
import { readGoals } from "./goals-store.js";
import { batchScope } from "./lib/workflow-preferences.js";
import { ShortcutHelp } from "./shortcut-help.js";
import { RUN_PANES, RUN_REQUEST, liveRunPanes } from "./workflow-window.js";
import { accountOf } from "./accounts.js";
import { WorkflowDetail } from "./workflow-detail.js";
import { row, taskState, caption, agentLabel } from "./workflow-labels.js";

const RUN_MODE = "relevo.runs.mode";
export { openWorkflow } from "./workflow-window.js";
export { runAgentArgs } from "./workflow-runs.js";

const TABS = ["Overview", "Changes", "Evidence", "Activity", "Preferences"];
const WINDOW_SHORTCUTS = [
  ...TABS.map((tab, index) => ({ id: `view-${tab}`, label: ["Decision / summary", "Result / findings", "Evidence", "Activity", "Preferences"][index], fixedShortcut: String(index + 1), section: "Run window" })),
  ...[["accept", "Prepare acceptance (Enter confirms)", "a"], ["changes", "Write change request", "r"], ["new", "New task", "n"], ["plan", "Plan work", "p"], ["tools", "Task actions and skills", "t"], ["next", "Next task", "down"], ["previous", "Previous task", "up"], ["help", "Keyboard help", "?"], ["close", "Return to queue focus, then close window", "escape"]]
    .map(([id, label, fixedShortcut]) => ({ id, label, fixedShortcut, section: "Run window" })),
];

export class Workflow extends WorkflowDetail {
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
    this.lastRequest = shared(RUN_REQUEST)?.at ?? 0;
    // A reloaded view keeps its registered pane; a new split is focused, which is how it learns its id.
    cx.timer.after(300, () => {
      const pane = liveRunPanes()[this.goalId] ?? focused()?.pane;
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
    this.loadQuotas(cx);
    cx.timer.every(60000, (cx) => this.loadQuotas(cx));
    cx.timer.every(1000, (cx) => this.launchTick(cx));
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
        const [rev, goalResult] = await Promise.all([
          readTextFile(`${appHome()}/relevo-workflow/state.rev`).catch(() => null),
          readGoals().catch((error) => ({ error: error.message ?? String(error) })),
        ]);
        if (this.closed || request !== this.loadVersion) return;
        this.polls = (this.polls ?? 0) + 1;
        const fresh = this.loadedOnce && rev != null && rev === this.lastRev && this.polls % 10 !== 0;
        const raw = fresh ? this.lastLoadedRaw : await readTextFile(`${appHome()}/relevo-workflow/state.json`);
        if (this.closed || request !== this.loadVersion) return;
        this.lastRev = rev;
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
    } else if (selected && previous && workflowBucket(previous) === this.filter && workflowBucket(selected) !== this.filter) {
      // The list follows the shown task when its state moves it to another list.
      this.filter = workflowBucket(selected);
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
      // A worktree run stays in view after acceptance: its branch has a commit to propose or remove.
      if (accepted && payload.action === "decide" && this.tasks?.find((task) => task.id === payload.taskId)?.worktree) {
        this.selected = payload.taskId; this.filter = "Completed"; delete this.worktreeInfo?.[payload.taskId];
        this.notice = "Accepted and committed to its run branch.";
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
    if (this.launch?.stage === "stalled") { Object.assign(this.launch, { stage: "waiting", at: Date.now() }); this.busy = true; this.error = null; cx.notify(); return; }
    if (this.pendingDraft) { this.error = "Resume or discard the saved draft before creating another task."; cx.notify(); return; }
    const submittedFields = JSON.stringify(this.taskDraftSnapshot());
    const title = this.form.title.value().trim();
    const root = this.form.root.value().trim();
    const isolated = this.runMode() === "worktree";
    const executor = agents().find((agent) => agent.address === this.executor);
    const reviewer = agents().find((agent) => agent.address === this.reviewer);
    const criteria = this.form.criteria.value().trim();
    const maxRounds = Number(this.form.maxRounds.value()), maxMinutes = Number(this.form.maxMinutes.value());
    const dependsOn = [...(this.dependsOn ?? [])];
    if (!title || !root || !/^\/(?:[^\0]*)$/.test(root) || !criteria || (!isolated && (!executor || !reviewer || executor.address === reviewer.address))) {
      this.taskSetupOpen = true;
      this.error = isolated ? "Enter a title, repository and prompt." : "Enter a task title, absolute repository path, expected outcome, and two different connected agents.";
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
    if (isolated) { this.launchWorktreeRun({ goalId: this.goalId, title, root, criteria, checks, dependsOn, maxRounds, maxMinutes }, cx); return; }
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

  runMode() { return shared(RUN_MODE) ?? "worktree"; }

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
    return v_flex().id("workflow-queue").when(!this.compact, (el) => el.w(200).flex_none().border_r(1).border_color(t.border)).when(this.compact, (el) => el.w_full().flex_1()).h_full().min_h(0).min_w(0).gap(2).p(8).bg(t.chrome)
      .children(["Needs you", "In progress", "Completed"].map((filter) => button(t, `workflow-filter-${filter}`,
        [div().flex_1().child(filter === "Completed" ? "History" : filter), div().text_color(t.dim).child(String(workflowItems(this.tasks ?? [], filter).length))],
        (context) => this.selectFilter(filter, context), { kind: "ghost", size: "sm", selected: this.tab !== "Plan" && this.filter === filter }).w_full()))
      .child(div().h(1).my(6).bg(t.border))
      .child(v_flex().w_full().min_w(0).flex_1().min_h(0).overflow_y_scrollbar().gap(5).children((selecting ? batchable : visible).map((task) => selecting ? button(t,
        `workflow-batch-select-${task.id}`, `${this.batchIds?.includes(task.id) ? "☑" : "☐"} ${caption(task.title, 36)}`,
        (cx) => { this.batchIds ??= []; this.batchIds = this.batchIds.includes(task.id) ? this.batchIds.filter((id) => id !== task.id) : [...this.batchIds, task.id]; this.batchPreview = null; this.batchSnapshot = null; cx.notify(); },
        { selected: Boolean(this.batchIds?.includes(task.id)), tip: `Select ${task.title} for a same-project batch` }).w_full().min_w(0).h(56).overflow_hidden()
        : button(t, `workflow-task-${task.id}`,
        [v_flex().w_full().min_w(0).gap(2).text_left().child(div().w_full().min_w(0).truncate().text_color(t.foreground).child(task.title))
          .child(div().text_size(11).text_color(task.state === "needs_you" ? t.accent : ["blocked", "failed"].includes(task.state) ? t.blocked : t.muted).child(taskState(task.state)))],
        (context) => { this.compactQueueOpen = false; this.explicitNew = false; this.selected = task.id; this.tab = "Overview"; this.h.focus(); context.notify(); },
        { kind: "ghost", selected: this.selected === task.id && this.tab !== "Plan", tip: task.title, accessibleLabel: `${task.title}. ${taskState(task.state)}` }).w_full().min_w(0).h(46).overflow_hidden())))
      .child(button(t, "workflow-new-task", "+ New task", (context) => { this.compactQueueOpen = false; this.explicitNew = true; this.selected = null; this.tab = "Overview"; this.h.focus(); context.notify(); }, { kind: "ghost", size: "sm", tip: "N" }).w_full())
      .child(button(t, "workflow-goal-plan", "Plan work", (context) => { this.compactQueueOpen = false; this.openPlan(context); }, { kind: "ghost", size: "sm", selected: this.tab === "Plan", tip: "P" }).w_full())
      .when(this.filter === "Needs you" && batchable.length > 1, (el) => el.child(button(t, "workflow-batch-toggle", selecting ? "Cancel selection" : "Review a batch", (cx) => {
        this.batchMode = !selecting; this.batchIds = []; this.batchSnapshot = null; this.batchPreview = null; cx.notify();
      }, { kind: "ghost", size: "sm", selected: Boolean(selecting) }).w_full()))
      .when(selecting, (el) => el.child(this.batchPanel(t, batchable)))
      .when(this.filter === "Completed" && visible.length > 0, (el) => el.child(button(t, "workflow-archive", "Archive older than 7 days", (cx) =>
        this.command({ action: "archive", olderThanDays: 7, goalId: this.goalId }, cx, (response) => {
          const count = response.result?.archived ?? 0;
          this.notice = count ? `${count} finished ${count === 1 ? "task" : "tasks"} archived.` : "Nothing older than 7 days to archive.";
        }), { kind: "ghost", size: "sm", disabled: this.busy, tip: "Moves this run's finished tasks idle for a week out of the queue; open worktrees stay" }).w_full()));
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
        { disabled: this.busy || picked.length < 2 || new Set(picked.map(batchScope)).size > 1 || new Set(picked.map((task) => task.goalId)).size > 1, tip: "Preview explicit task ids and revisions before accepting" }))
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
    const isolated = this.runMode() === "worktree", accounts = this.runAccounts();
    const setupLabel = isolated ? [rootName, "own worktree", `${accountOf(accounts.executor).label} → ${accountOf(accounts.reviewer).label}`].filter(Boolean).join(" · ") : chosen === 2 ? [rootName, `${agentName(this.executor)} → ${agentName(this.reviewer)}`].filter(Boolean).join(" · ") : `Repository & agents · ${chosen}/2 selected`;
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
          { disabled: this.busy, tip: `Copy setup from ${previousSetup.title} in this run: ${previousSetup.root}; ${previousSetup.maxRounds ?? 2} rounds; ${previousSetup.maxMinutes ?? 20} minutes; ${previousCheckLabel} (${JSON.stringify(previousChecks)}). Title and outcome stay as drafted; nothing starts.` }))))
      .when(Boolean(this.setupReuseNotice), (el) => el.child(row(t, this.setupReuseNotice)))
      .when(Boolean(this.setupReuseWarning), (el) => el.child(row(t, this.setupReuseWarning)))
      .child(button(t, "workflow-task-setup", setupLabel, (context) => {
        this.taskSetupOpen = !this.taskSetupOpen; context.notify();
      }, { selected: Boolean(this.taskSetupOpen), tip: "Repository, implementer and independent reviewer" }))
      .when(this.taskSetupOpen, (el) => el.child(v_flex().gap(8).p(10).rounded(6).bg(t.raised)
        .child(this.setupLibrary(t))
        .child(this.field(t, "root", "Repository path"))
        .child(this.repositoryPicker(t))
        .child(h_flex().gap(4)
          .child(button(t, "workflow-mode-worktree", "Own worktree", (cx) => { setShared(RUN_MODE, "worktree"); cx.notify(); }, { kind: "ghost", size: "sm", selected: isolated }))
          .child(button(t, "workflow-mode-sessions", "Existing sessions", (cx) => { setShared(RUN_MODE, "sessions"); cx.notify(); }, { kind: "ghost", size: "sm", selected: !isolated })))
        .when(isolated, (panel) => panel.child(this.accountPicker(t, "executor", "Implements")).child(this.accountPicker(t, "reviewer", "Reviews")))
        .when(!isolated, (panel) => panel.child(this.agentPicker(t, "executor", "Implementer")).child(this.agentPicker(t, "reviewer", "Independent reviewer")))))
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
      .child(h_flex().gap(6).items_center()
        .child(button(t, "workflow-start-new", this.busy ? "Starting…" : "Start", (context) => this.create(context, { start: true }),
          { kind: "solid", disabled: this.busy, tip: "⌘Enter" }))
        .when(!isolated, (bar) => bar.child(button(t, "workflow-create", "Save for later", (context) => this.create(context), { disabled: this.busy })))
        .when(Boolean(this.launch), (bar) => bar.child(div().id("workflow-launch-status").text_size(11).text_color(t.muted)
          .child(this.launchNotice ?? (this.launch?.stage === "preparing" ? "Creating worktree…" : "Opening agents…")))));
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
      .size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(h_flex().id("workflow-header").w_full().min_w(0).flex_none().gap(2).items_center().px(10).pt(8).pb(4)
        .child(div().flex_1().min_w(0).px(4).truncate().text_size(11).text_color(t.muted).tooltip(this.goal?.title ?? "Run").child(this.goal?.title ?? "Run"))
        .child(button(t, "workflow-focus-queue", "?", (cx) => this.toggleHelp(cx), { kind: "ghost", size: "sm", tip: "Keyboard shortcuts", accessibleLabel: "Keyboard help" }))
        .when(Boolean(task), (el) => el.child(button(t, "workflow-task-tools", "Tools", (cx) => this.openTools(cx), { kind: "ghost", size: "sm", selected: this.tab === "Tools", tip: "T" })))
        .child(button(t, "workflow-tools-toggle", "Settings", (cx) => { this.showTools = !this.showTools; cx.notify(); }, { kind: "ghost", size: "sm", selected: Boolean(this.showTools) }))
        .when(Boolean(this.pane || props()?.overlay), (el) => el.child(button(t, "workflow-close", "Close", () => this.pane ? run("pane.close", { pane: this.pane }) : closeOverlay(props().overlay), { kind: "ghost", size: "sm" }))))
      .child(v_flex().w_full().min_w(0).flex_none().px(14).gap(6)
        .when(this.showTools, (el) => el.child(h_flex().gap(6).pb(4)
          .child(button(t, "workflow-tab-Preferences", "Preferences", (cx) => { this.tab = "Preferences"; this.h.focus(); cx.notify(); }, { kind: "ghost", size: "sm", tip: "5" }))
          .when(Boolean(this.engine?.enabled), (controls) => controls.child(button(t, "workflow-engine-stop", "Pause automation", (cx) => this.command({ action: "stop" }, cx), { kind: "ghost", size: "sm", disabled: this.busy, tip: "Stops new dispatches; running sessions continue" })))))
        .when(Boolean(this.notice), (el) => el.child(div().role("status").child(row(t, this.notice))))
        .when(Boolean(this.error), (el) => el.child(div().id("workflow-error").role("alert").text_color(t.blocked).child(this.error)))
        .when(Boolean(this.pendingDraft), (el) => el.child(this.draftRecovery(t)))
        .when(this.showHelp && Boolean(this.shortcutHelp), (el) => el.child(this.shortcutHelp.render(t)))
        .when(this.compact && Boolean(this.tasks?.length || this.goal?.steps?.length), (el) => el.child(button(t, "workflow-queue-toggle", this.compactQueueOpen ? "← Back to work" : `Tasks · ${this.filter === "Completed" ? "History" : this.filter} ${workflowItems(this.tasks ?? [], this.filter).length}`, (cx) => {
          this.compactQueueOpen = !this.compactQueueOpen; this.h.focus(); cx.notify();
        }, { kind: "ghost", size: "sm", selected: Boolean(this.compactQueueOpen) }).self_start())))
      .child(h_flex().items_start().flex_1().min_h(0).min_w(0)
        .when((!this.compact || this.compactQueueOpen) && Boolean(this.tasks?.length || this.goal?.steps?.length), (el) => el.child(this.taskList(t)))
        .when(!this.compact || !this.compactQueueOpen, (el) => el.child(v_flex().flex_1().h_full().min_h(0).min_w(0)
          .when(Boolean(task) && !["Plan", "Preferences", "Tools"].includes(this.tab), (el) => el.child(h_flex().id("workflow-tabs").w_full().flex_none().px(10).gap(2).border_b(1).border_color(t.border)
            .children(TABS.slice(0, 4).map((tab, index) => tabButton(t, `workflow-tab-${tab}`,
              tab === "Overview" ? "Summary" : tab === "Changes" ? (["blocked", "failed"].includes(task.state) ? "Findings" : "Result") : tab,
              this.tab === tab, (cx) => { this.tab = tab; this.h.focus(); cx.notify(); }, String(index + 1))))))
          .child(v_flex().id(`workflow-panel-${this.tab}-${this.selected ?? "queue"}`).flex_1().w_full().min_h(0).min_w(0).overflow_y_scrollbar().px(14).py(12).gap(10)
            .child(panel).when(!this.selected && !["Preferences", "Plan"].includes(this.tab) && (this.explicitNew || !(this.tasks ?? []).length), (el) => el.child(this.taskForm(t))))
          .when(Boolean(task) && !["Plan", "Preferences", "Tools"].includes(this.tab), (el) => el.children([this.decisions(t, task)].filter(Boolean))))));
  }
}
