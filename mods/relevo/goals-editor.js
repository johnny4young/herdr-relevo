import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { agents, props, theme, openOverlay, closeOverlay, exec, readTextFile, appHome } from "herdr";
import { button } from "./ui.js";
import { newGoal, webLink, GOAL_STATES, STEP_STATES, goalState } from "./lib/goals.js";
import { readGoals, writeGoal } from "./goals-store.js";
import { projectGoalPlan } from "./lib/goal-plan.js";

async function workflowTasks() {
  const raw = await readTextFile(`${appHome()}/relevo-workflow/state.json`);
  return raw ? JSON.parse(raw).tasks ?? [] : [];
}

export function openGoal(id = null, source = null, panel = "decision") {
  openOverlay({ mod: "relevo", kind: "dialog", width: 620, height: 710,
    props: { role: "goal-editor", goalId: id, source, panel } });
}
const labels = { title: "Mission title", owner: "Human owner", decision: "Pending decision", recommendation: "Saved recommendation", criteria: "Acceptance criteria" };
const multiline = new Set(["decision", "recommendation", "criteria", "response"]);
const row = (value, t) => div().text_size(13).text_color(t.muted).child(value);

export class GoalEditor {
  init(_props, cx) {
    this.closed = false;
    this.loading = false;
    this.h = cx.focus_handle();
    this.panel = ["plan", "ownership"].includes(props()?.panel) ? props().panel : "decision";
    this.resolvePending = false;
    this.planFocusRequest = 0;
    this.fields = Object.fromEntries(Object.keys(labels).map((k) => [k, (multiline.has(k) ? TextareaState : InputState).new({ value: "", placeholder: labels[k] })]));
    this.response = TextareaState.new({ value: "", placeholder: "Decision or feedback (recorded, not sent automatically)" });
    this.link = InputState.new({ value: "", placeholder: "HTTPS link to a screenshot or video of this commit" });
    this.kind = "screenshot";
    this.steps = [];
    this.busy = false;
    const { goalId, source } = props() ?? {};
    this.loadContext = { goalId, sourceKey: source?.key };
    this.load(cx);
  }

  load(cx) {
    // Retry only an unloaded editor. Never discard a loaded human draft.
    if (this.closed || this.loading || this.goal) return;
    this.loading = true;
    this.busy = true;
    this.error = undefined;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const { doc } = await readGoals();
        if (this.closed) return;
        const { goalId, sourceKey } = this.loadContext;
        this.options = doc.goals;
        this.goal = goalId ? doc.goals.find((g) => g.id === goalId) : newGoal(`goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, "", sourceKey ? [sourceKey] : []);
        if (!this.goal) throw Error("This goal is no longer available");
        this.version = this.goal.version;
        this.steps = (this.goal.steps ?? []).map((s) => ({ ...s, input: InputState.new({ value: s.title }) }));
        for (const k of Object.keys(labels)) this.fields[k].set_value(this.goal[k]);
        this.workflowTasks = await workflowTasks().catch(() => []);
        if (this.closed) return;
      } catch (e) {
        if (this.closed) return;
        this.error = String(e.message ?? e);
      }
      this.loading = false;
      this.busy = false;
      cx.timer.after(30, () => {
        if (!this.closed && !this.busy && this.panel === "decision" && this.goal) this.fields.title.focus();
      });
      cx.notify();
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.h.release();
    for (const f of [...Object.values(this.fields), this.response, this.link, ...this.steps.map((s) => s.input)]) f.release();
  }

  focusPlanStep(input, cx) {
    const request = ++this.planFocusRequest;
    cx.timer.after(30, () => {
      if (this.closed || this.busy || this.panel !== "plan" || request !== this.planFocusRequest) return;
      if (input && this.steps.some((step) => step.input === input)) input.focus();
      else if (!input && !this.steps.length) this.fields.criteria.focus();
    });
  }

  addStep(cx) {
    if (this.closed || this.busy || !this.goal || this.panel !== "plan" || this.steps.length >= 20) return;
    const step = { id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, state: "todo", input: InputState.new({ value: "" }) };
    this.steps.push(step); this.focusPlanStep(step.input, cx); cx.notify();
  }

  removeStep(step, cx) {
    if (this.closed || this.busy || !this.goal || this.panel !== "plan") return;
    const index = this.steps.indexOf(step);
    if (index < 0) return;
    this.steps.splice(index, 1); step.input.release();
    this.focusPlanStep(this.steps[Math.min(index, this.steps.length - 1)]?.input, cx); cx.notify();
  }

  validateAll(cx) {
    if (this.closed || this.busy || !this.goal || this.panel !== "plan") return;
    this.steps.forEach((step) => { step.state = "done"; });
    cx.notify();
  }

  projectedSteps() {
    return projectGoalPlan({ ...this.goal, criteria: this.fields.criteria.value().trim(),
      steps: this.steps.map(({ id, state, input }) => ({ id, state, title: input.value().trim() })) }, this.workflowTasks);
  }

  save(cx) {
    if (this.closed || this.busy || !this.goal) return;
    this.planFocusRequest++;
    // Capture exactly what was submitted; callbacks never consume a later edit.
    const goal = { ...this.goal, ...Object.fromEntries(Object.entries(this.fields).map(([k, f]) => [k, f.value().trim()])),
      steps: this.steps.map(({ id, state, input }) => ({ id, state, title: input.value().trim() })) };
    const accepted = this.projectedSteps().filter((item) => item.source === "workflow" && item.state === "done").map((item) => item.step.id);
    goal.steps = goal.steps.map((step) => accepted.includes(step.id) ? { ...step, state: "done" } : step);
    const response = this.response.value().trim(), url = this.link.value().trim(), kind = this.kind, source = props()?.source, overlay = props()?.overlay;
    const resolved = this.resolvePending ? goal.decision : "";
    if (resolved) goal.decision = "";
    // Validate the editable draft before any read, evidence lookup or write.
    // The store remains authoritative for versions and document invariants.
    const checks = [
      { input: this.fields.title, value: goal.title, panel: "decision", label: "the goal title", limit: 240, required: "Enter a goal title before saving." },
      ...["owner", "decision", "recommendation", "criteria"].map((key) => ({ input: this.fields[key], value: goal[key],
        panel: key === "owner" ? "ownership" : key === "criteria" ? "plan" : "decision", label: labels[key], limit: 2000 })),
      ...goal.steps.map((step, index) => ({ input: this.steps[index].input, value: step.title, panel: "plan",
        label: `plan step ${index + 1}`, limit: 240, required: `Enter an expected outcome for plan step ${index + 1}.` })),
      { input: this.response, value: response, panel: "decision", label: "decision or feedback", limit: 2000 },
    ];
    const evidenceError = !url ? null
      : !webLink(url) ? "Enter an HTTPS evidence URL, or clear it to save without adding evidence."
        : typeof source?.key !== "string" || !source.key.startsWith("pr:") || !source.key.slice(3) || !/^[a-f0-9]{40,64}$/.test(source.revision)
          ? "Open this goal from a PR with a known commit before attaching evidence, or clear the URL to save other edits."
          : !goal.sources.includes(source.key) ? "Link this PR to the goal before attaching evidence, or clear the URL to save other edits."
            : goal.evidence.length >= 20 ? "This goal already has 20 evidence links. Clear this URL to save the other edits." : null;
    const unfinished = goal.steps.findIndex((step) => step.state !== "done");
    const completionError = goalState(goal) !== "completed" ? null
      : goal.decision ? { input: this.fields.decision, panel: "decision",
        message: "Resolve the pending decision before closing this goal, or choose In progress." }
        : unfinished < 0 ? null : { input: this.steps[unfinished].input, panel: "plan",
          message: `Validate plan step ${unfinished + 1} before closing this goal, or choose In progress.` };
    const invalid = checks.find((field) => (field.required && !field.value) || field.value.length > field.limit)
      ?? completionError
      ?? (evidenceError ? { input: this.link, panel: "decision", message: evidenceError } : null);
    if (invalid) {
      const message = invalid.message ?? (!invalid.value ? invalid.required : `Keep ${invalid.label} to ${invalid.limit} characters or fewer.`);
      this.error = message; this.panel = invalid.panel;
      cx.timer.after(30, () => {
        const retained = [...Object.values(this.fields), this.response, this.link, ...this.steps.map((step) => step.input)].includes(invalid.input);
        if (!this.closed && !this.busy && this.error === message && this.panel === invalid.panel && retained) invalid.input.focus();
      });
      cx.notify(); return;
    }
    this.busy = true;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        if (accepted.length) {
          const tasks = await workflowTasks();
          // Recheck the submitted outcomes against current evidence, using the
          // original manual state so an optimistic projection cannot validate itself.
          const original = { ...goal, steps: goal.steps.map((step) => accepted.includes(step.id) ? { ...step, state: "todo" } : step) };
          const validated = projectGoalPlan(original, tasks).filter((item) => item.source === "workflow" && item.state === "done").map((item) => item.step.id);
          if (accepted.some((id) => !validated.includes(id))) throw Error("An accepted workflow result changed. Reopen this goal to review current progress.");
        }
        if (url) {
          const r = await exec("gh", ["pr", "view", source.key.slice(3), "--json", "headRefOid"]);
          if (r.code !== 0 || JSON.parse(r.stdout).headRefOid !== source.revision) throw Error("The PR changed or could not be verified. Refresh Inbox before attaching evidence.");
          goal.evidence = [...goal.evidence, { source: source.key, revision: source.revision, kind, url, label: kind === "video" ? "Product demo" : "Product screenshot" }];
        }
        const record = (text, extra = {}) => ({ text, ...extra, at: new Date().toISOString(), revisions: source?.revision ? [{ source: source.key, revision: source.revision }] : [] });
        goal.decisions = [...goal.decisions, ...(resolved ? [record(resolved, { resolved: true })] : []), ...(response ? [record(response)] : [])];
        await writeGoal(goal, this.version);
        if (!this.closed) closeOverlay(overlay);
      } catch (e) { if (!this.closed) this.error = `Not saved: ${e.message ?? e}`; }
      if (this.closed) return;
      this.busy = false;
      cx.notify();
    });
  }

  linkExisting(goal, cx) {
    if (this.closed || this.busy) return;
    const source = props()?.source, overlay = props()?.overlay;
    if (!source) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        await writeGoal({ ...goal, sources: [...new Set([...goal.sources, source.key])] }, goal.version);
        if (!this.closed) closeOverlay(overlay);
      } catch (e) { if (!this.closed) this.error = String(e.message ?? e); }
      if (this.closed) return;
      this.busy = false;
      cx.notify();
    });
  }

  render() {
    const t = theme(), p = props(), goal = this.goal;
    const projected = this.projectedSteps();
    // Keep a named group as well: some host builds omit the retained editor's
    // own accessible name, even when the native frame supplies it.
    const field = (key, input, label) => v_flex().id(`goal-field-group-${key}`).role("group").accessibility_label(label).gap(4).child(row(label, t))
      .when(Boolean(goal), (el) => el.child((multiline.has(key) ? Textarea : Input).new(input).id(`goal-field-${key}`).disabled(this.busy).accessibility_label(label)
        .h(multiline.has(key) ? 76 : 32).px(8).rounded(5).border(1).border_color(t.border).bg(t.background)));
    const choice = (id, label, selected, action, tip) => button(t, id, label, action,
      { kind: selected ? "solid" : "outline", selected, disabled: this.busy, tip });
    return v_flex().id("goal-editor").role("dialog").accessibility_label("Mission details").track_focus(this.h)
      .on_key_down((e, cx) => {
        if (e.key === "s" && e.modifiers?.platform && !e.modifiers?.alt && !e.modifiers?.control) { cx.stop_propagation(); this.save(cx); }
      })
      .size_full().min_h(0).p(14).gap(10).bg(t.popover ?? t.surface).text_color(t.foreground).text_size(13)
      .child(h_flex().gap(8).items_center().child(div().flex_1().font_semibold().child(p?.goalId ? "Mission details" : "New mission"))
        .child(button(t, "goal-cancel", "Close", () => closeOverlay(p?.overlay), { tip: this.busy && !this.loading ? "Close this editor. A save already started may still complete." : "Close without saving these edits" })))
      .child(h_flex().gap(6).children([["decision", "Decision"], ["plan", "Plan"], ["ownership", "Ownership"]].map(([panel, label]) =>
        choice(`goal-panel-${panel}`, label, this.panel === panel, (cx) => { this.planFocusRequest++; this.panel = panel; cx.notify(); },
          panel === "decision" ? "Outcome, evidence and your feedback" : panel === "plan" ? "Acceptance criteria, progress and completion" : "Human owner, priority and an existing lead agent"))))
      .child(v_flex().id(`goal-editor-scroll-${this.panel}`).flex_1().min_h(0).overflow_y_scrollbar().gap(10)
        .when(this.loading, (el) => el.child(row("Loading goal context…", t).id("goal-loading").role("status")))
        .when(Boolean(this.error), (el) => el.child(div().id("goal-save-error").role("alert").text_color(t.blocked).child(this.error)))
        .when(Boolean(this.error) && !this.loading && !goal, (el) => el
          .child(row("Your saved goals have not been changed. Retry loading or close this editor.", t))
          .child(button(t, "goal-retry-load", "Retry loading", (cx) => this.load(cx),
            { tip: "Read this goal again without saving or replacing any data" })))
        .when(Boolean(p?.source), (el) => el.child(row(`Work: ${p.source.title}`, t)))
        .when(!p?.goalId && Boolean(p?.source) && Boolean(this.options?.length), (el) => el
          .child(row("Link to an existing goal", t))
          .children((this.options ?? []).map((g) => button(t, `goal-link-${g.id}`, g.title, (cx) => this.linkExisting(g, cx), { disabled: this.busy, tip: "Link this work; existing goal details stay unchanged" }))))
        .when(this.panel === "decision", (el) => el
          .children(["title", "decision", "recommendation"].map((k) => field(k, this.fields[k], labels[k])))
          .when(Boolean(p?.source?.revision) || Boolean(this.link.value()), (el) => el.child(field("evidence", this.link, "Evidence URL · exact PR commit"))
            .child(h_flex().gap(5).children([["screenshot", "Screenshot"], ["video", "Video"]].map(([kind, label]) =>
              choice(`goal-kind-${kind}`, label, this.kind === kind, (cx) => { this.kind = kind; cx.notify(); }, "The PR commit is checked again before attaching this link")))))
          .child(field("response", this.response, "Review note · saved with this goal"))
          .child(row("Keep your reasoning for the next review. Notes stay local; they do not send instructions or validate steps.", t))
          .child(choice("goal-resolve-decision", this.resolvePending ? "Decision resolved on save ✓" : "Resolve pending decision", this.resolvePending,
            (cx) => { if (!this.closed && !this.busy && this.goal) { this.resolvePending = !this.resolvePending; cx.notify(); } },
            "Save clears the pending decision and keeps its text in the history. Click again to leave it pending."))
          .child(button(t, "goal-review-steps", "Next: validate steps", (cx) => { this.panel = "plan"; cx.notify(); },
            { disabled: this.busy, tip: "Review progress before finishing the goal. Changes remain a draft until saved." }))
          .children((goal?.decisions ?? []).slice(-5).map((d) => row(`${d.at} · ${d.resolved ? "Resolved decision" : "Review note"}: ${d.text}`, t)))
          .child(row("To request changes, use Send to agent in Review or Message lead in Inbox.", t)))
        .when(this.panel === "plan", (el) => el
          .child(row(`${projected.filter((step) => step.state === "done").length}/${this.steps.length} steps validated · save to apply`, t))
          .child(row("Accepted Workflow outcomes already count. Validate remaining outcomes here; Save applies your progress.", t))
          .child(h_flex().gap(6).flex_wrap().child(button(t, "goal-validate-all", "Validate all steps", (cx) => this.validateAll(cx),
            { disabled: this.busy || !goal || !this.steps.some((step) => step.state !== "done"), tip: "Confirm you reviewed every outcome. Marks all steps Validated in this draft; Save applies it." }))
          .when(Boolean(this.fields.decision.value().trim()) && !this.resolvePending, (el) => el
            .child(button(t, "goal-plan-decision", "Resolve pending decision…", (cx) => { this.panel = "decision"; cx.notify(); },
              { disabled: this.busy, tip: "Open Decision to record the outcome and resolve the question before finishing" }))))
          .children(this.steps.map((step) => v_flex().gap(4)
            .child(field(`step-${step.id}`, step.input, "Expected outcome"))
            .when(projected.some((item) => item.step.id === step.id && item.source === "workflow" && item.state === "done"), (el) => el.child(row("Validated by your Workflow acceptance · checked again on save", t)))
            .child(h_flex().gap(4).flex_wrap().children(Object.entries(STEP_STATES).map(([state, label]) =>
              choice(`goal-step-${step.id}-${state}`, label, (projected.find((item) => item.step.id === step.id)?.state === "done" ? "done" : step.state) === state, (cx) => { step.state = state; cx.notify(); },
                state === "done" ? "Record your validation of this result" : "Record this step's current stage")))
              .child(button(t, `goal-step-remove-${step.id}`, "Remove", (cx) => this.removeStep(step, cx),
                { disabled: this.busy, tip: "Remove this plan step when you save" })))))
          .child(button(t, "goal-add-step", "+ Plan step", (cx) => this.addStep(cx),
            { disabled: this.busy || this.steps.length >= 20, tip: "Add a concrete result to validate; up to 20 steps" }))
          .child(field("criteria", this.fields.criteria, labels.criteria))
          .child(row("Goal state · closing does not approve or merge PRs", t))
          .child(h_flex().gap(5).children(Object.entries(GOAL_STATES).map(([state, label]) =>
            choice(`goal-state-${state}`, label, goal && goalState(goal) === state, (cx) => { if (this.goal) this.goal = { ...this.goal, state }; cx.notify(); },
              state === "completed" ? "Requires every step validated and no pending decision. Open work remains visible." : "Update the goal state without starting or stopping agents")))))
        .when(this.panel === "ownership", (el) => el
          .child(field("owner", this.fields.owner, labels.owner))
          .child(row("Declared priority · visible blockers appear first", t))
          .child(h_flex().gap(5).children(["Urgent", "High", "Normal", "Low"].map((label, priority) =>
            choice(`goal-priority-${priority}`, label, goal?.priority === priority, (cx) => { if (this.goal) this.goal = { ...this.goal, priority }; cx.notify(); }, "Break ties between goals with the same urgency"))))
          .child(row("Lead · link an existing agent; this does not launch one", t))
          .child(row(goal?.lead ? `Assigned: ${goal.lead}${agents().some((a) => a.address === goal.lead) ? "" : " · not connected"}` : "No lead assigned", t))
          .child(h_flex().flex_wrap().gap(5)
            .child(choice("goal-no-lead", "No lead", !goal?.lead, (cx) => { if (this.goal) this.goal = { ...this.goal, lead: "" }; cx.notify(); }, "Remove the assignment without stopping the agent"))
            .children(agents().map((a) => choice(`goal-lead-${a.address}`, a.tab_name || a.address, goal?.lead === a.address, (cx) => {
              if (this.goal) this.goal = { ...this.goal, lead: a.address }; cx.notify();
            }, "Assign this connected agent as the goal's lead"))))))
      .child(h_flex().flex_none().gap(8).flex_wrap()
        .child(button(t, "goal-save", this.loading ? "Loading…" : this.busy ? "Saving…" : "Save", (cx) => this.save(cx),
          { kind: "solid", disabled: this.busy || !goal, tip: "⌘S saves all sections. This does not send messages, approve or merge changes." }))
        .when(this.panel === "plan", (el) => el.child(button(t, "goal-finish", "Save and finish goal", (cx) => {
          if (this.closed || this.busy || !this.goal) return;
          this.goal = { ...this.goal, state: "completed" }; this.save(cx);
        }, { disabled: this.busy || !goal || this.steps.some((step) => step.state !== "done") || (Boolean(this.fields.decision.value().trim()) && !this.resolvePending),
          tip: "Requires every step validated and the pending decision resolved. Saves and closes this goal; agents and PRs keep their own workflow." }))));
  }
}
