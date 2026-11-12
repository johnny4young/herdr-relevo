import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { button } from "./ui.js";
import { createWorkflowDrafts, restoreWorkflowDraftAgents } from "./workflow-drafts.js";
import { WorkflowSetup } from "./workflow-setups.js";

const FIELDS = ["title", "root", "criteria", "checks", "maxRounds", "maxMinutes"];
export class WorkflowDraftView extends WorkflowSetup {
  initDrafts() {
    this.drafts = createWorkflowDrafts();
    this.pendingDraft = this.goalId ? this.drafts.load(this.goalId) : null;
    this.draftSnapshot = JSON.stringify(this.taskDraftSnapshot());
    for (const key of FIELDS) this.form[key].on("change", (_event, cx) => { this.persistDraft(); cx.notify(); });
  }

  taskDraftSnapshot() {
    return { ...Object.fromEntries(FIELDS.map((key) => [key, this.form[key].value()])), checkPreset: this.checkPreset ?? "none",
      executor: this.executor ?? "", reviewer: this.reviewer ?? "", dependsOn: [...(this.dependsOn ?? [])] };
  }

  persistDraft() {
    if (!this.drafts || !this.goalId || this.pendingDraft) return;
    const draft = this.taskDraftSnapshot(), serialized = JSON.stringify(draft);
    if (serialized === this.draftSnapshot) return;
    // A plan's shared setup by itself is not an unsent task brief.
    if (!draft.title.trim() && !draft.criteria.trim() && !this.draftSaved) return;
    const result = this.drafts.save(this.goalId, draft);
    if (result.ok) { this.draftSnapshot = serialized; this.draftError = null; this.draftSaved = true; }
    else this.draftError = result.reason;
  }

  resumeDraft(cx) {
    const draft = this.drafts.load(this.goalId);
    if (!draft || this.busy) return;
    for (const key of FIELDS) this.form[key].set_value(draft[key]);
    this.checkPreset = draft.checkPreset;
    const restored = restoreWorkflowDraftAgents(draft);
    this.executor = restored.executor; this.reviewer = restored.reviewer;
    const existing = new Set((this.tasks ?? []).map((task) => task.id));
    this.dependsOn = draft.dependsOn.filter((id) => existing.has(id));
    const missing = this.dependsOn.length !== draft.dependsOn.length;
    this.setupReuseWarning = [...restored.warnings, missing ? "Some prerequisites are no longer available. Review dependencies before creating." : null].filter(Boolean).join(" ");
    this.setupReuseNotice = `Draft restored · ${draft.maxRounds} rounds · ${draft.maxMinutes} min per round. Nothing has started.`;
    this.pendingDraft = null; this.draftSaved = true;
    this.explicitNew = true; this.selected = null; this.tab = "Overview"; this.compactQueueOpen = false;
    this.taskSetupOpen = Boolean(restored.warnings.length); this.taskAdvancedOpen = missing;
    this.persistDraft(); this.h.focus(); cx.notify();
  }

  discardDraft(cx) {
    if (this.busy) return;
    this.drafts.clear(this.goalId); this.pendingDraft = null;
    for (const key of ["title", "root", "criteria", "checks"]) this.form[key].set_value("");
    this.form.maxRounds.set_value("2"); this.form.maxMinutes.set_value("20");
    this.executor = ""; this.reviewer = ""; this.checkPreset = "none"; this.dependsOn = [];
    this.draftSnapshot = JSON.stringify(this.taskDraftSnapshot()); this.draftSaved = false; this.draftError = null;
    this.setupReuseNotice = null; this.setupReuseWarning = null; cx.notify();
  }

  clearSubmittedDraft(snapshot) {
    if (!this.drafts || !snapshot) return;
    if (JSON.stringify(this.drafts.load(this.goalId)) === JSON.stringify(snapshot)) this.drafts.clear(this.goalId);
  }

  draftRecovery(t) {
    const draft = this.pendingDraft;
    return v_flex().w_full().min_w(0).gap(5).p(8).rounded(6).bg(t.raised)
      .child(div().text_size(13).child(`Unsent draft · ${draft.title || "Untitled task"}`))
      .child(div().text_size(11).text_color(t.muted).child(draft.root || "Repository not selected"))
      .child(h_flex().gap(6).flex_wrap()
        .child(button(t, "workflow-resume-draft", "Resume draft", (cx) => this.resumeDraft(cx),
          { disabled: this.busy, tip: "Restore the brief and setup for this run. Check connected agents again; no work is sent." }))
        .child(button(t, "workflow-discard-saved-draft", "Discard", (cx) => this.discardDraft(cx),
          { size: "sm", disabled: this.busy, tip: "Remove only this unsent draft; existing tasks and decisions stay unchanged" })));
  }
}
