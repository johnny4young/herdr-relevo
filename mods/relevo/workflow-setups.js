import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, shared, setShared } from "herdr";
import { button } from "./ui.js";
import { WorkflowPlan } from "./workflow-plan.js";

export const SETUPS_KEY = "relevo.workflow.setups.v1";
const LIMIT = 20;
const row = (t, value) => div().w_full().min_w(0).text_size(12).text_color(t.muted).child(value);

export function validSetup(value) {
  return value && typeof value.id === "string" && typeof value.name === "string" && value.name.trim() && value.name.length <= 60 &&
    typeof value.purpose === "string" && value.purpose.length <= 240 && typeof value.root === "string" && value.root.startsWith("/") && !value.root.includes("\0") &&
    typeof value.executor?.address === "string" && typeof value.reviewer?.address === "string" && value.executor.address !== value.reviewer.address &&
    Number.isInteger(value.maxRounds) && value.maxRounds >= 1 && value.maxRounds <= 5 &&
    Number.isInteger(value.maxMinutes) && value.maxMinutes >= 1 && value.maxMinutes <= 120 &&
    Array.isArray(value.checks) && value.checks.every((args) => Array.isArray(args) && args.length && args.every((arg) => typeof arg === "string"));
}

export const savedSetups = () => {
  const stored = shared(SETUPS_KEY);
  return stored?.version === 1 && Array.isArray(stored.items) ? stored.items.filter(validSetup).slice(0, LIMIT) : [];
};

export class WorkflowSetup extends WorkflowPlan {
  saveSetup(cx) {
    if (this.busy) return;
    const name = this.form.setupName.value().trim(), purpose = this.form.setupPurpose.value().trim();
    const root = this.form.root.value().trim();
    const executor = agents().find((agent) => agent.address === this.executor);
    const reviewer = agents().find((agent) => agent.address === this.reviewer);
    let checks;
    try { checks = this.checkPreset === "npm-test" ? [["npm", "test"]] : this.checkPreset === "custom" ? JSON.parse(this.form.checks.value() || "[]") : []; }
    catch { this.setupError = "Fix the custom checks before saving this setup."; cx.notify(); return; }
    const setup = { id: `setup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, purpose, root,
      executor: executor && { address: executor.address, label: executor.title || executor.address },
      reviewer: reviewer && { address: reviewer.address, label: reviewer.title || reviewer.address },
      checks, maxRounds: Number(this.form.maxRounds.value()), maxMinutes: Number(this.form.maxMinutes.value()) };
    if (!validSetup(setup)) {
      this.setupError = "Enter a name (up to 60 characters), purpose (up to 240), repository, two connected agents and valid limits.";
      cx.notify(); return;
    }
    const items = savedSetups();
    if (items.some((item) => item.root === root && item.name.toLowerCase() === name.toLowerCase())) {
      this.setupError = "That name already exists for this repository. Choose another name or remove the old setup.";
      cx.notify(); return;
    }
    if (items.length >= LIMIT) { this.setupError = "You have 20 saved setups. Remove one before saving another."; cx.notify(); return; }
    setShared(SETUPS_KEY, { version: 1, items: [...items, setup] });
    this.form.setupName.set_value(""); this.form.setupPurpose.set_value("");
    this.setupSaveOpen = false; this.setupError = null; this.setupNotice = "Setup saved locally. Your task is unchanged."; cx.notify();
  }

  applySavedSetup(id, cx) {
    const setup = savedSetups().find((item) => item.id === id);
    if (!setup || this.busy) return;
    // Re-read at click time; the selected repository is a scope, not a default to replace.
    const root = this.form.root.value().trim();
    if (root && root !== setup.root) { this.setupError = "This setup belongs to another repository."; cx.notify(); return; }
    this.applySetup(setup, cx);
    this.setupReuseNotice = `“${setup.name}” applied · ${setup.maxRounds} ${setup.maxRounds === 1 ? "round" : "rounds"} · ${setup.maxMinutes} min per round. Review agents before creating.`;
    this.setupError = null; this.setupNotice = null;
  }

  setupLibrary(t) {
    const root = this.form.root.value().trim();
    const items = savedSetups().filter((item) => !root || item.root === root);
    return v_flex().w_full().min_w(0).gap(6)
      .child(button(t, "workflow-saved-setups", `${this.setupsOpen ? "▾" : "▸"} Saved setups${items.length ? ` · ${items.length}` : ""}`, (cx) => {
        this.setupsOpen = !this.setupsOpen; this.setupError = null; cx.notify();
      }, { size: "sm", selected: Boolean(this.setupsOpen), tip: "Reuse repository, agent and check choices. Selecting a setup never starts work." }).w_full().justify_start())
      .when(this.setupsOpen, (el) => el.child(v_flex().w_full().min_w(0).gap(8)
        .when(!items.length, (list) => list.child(row(t, "No saved setups for this repository.")))
        .child(v_flex().max_h(200).overflow_y_scrollbar().gap(8).children(items.map((item) => v_flex().w_full().min_w(0).gap(3)
          .child(div().font_semibold().child(item.name))
          .when(Boolean(item.purpose), (entry) => entry.child(row(t, item.purpose)))
          .child(row(t, `${item.root} · ${item.maxRounds} ${item.maxRounds === 1 ? "round" : "rounds"} · ${item.maxMinutes} min · ${item.checks.length} ${item.checks.length === 1 ? "check" : "checks"}`))
          .child(h_flex().gap(6).flex_wrap()
            .child(button(t, `workflow-apply-setup-${item.id}`, "Use setup", (cx) => this.applySavedSetup(item.id, cx),
              { disabled: this.busy, tip: `${item.executor.label ?? item.executor.address} + ${item.reviewer.label ?? item.reviewer.address}. Checks: ${JSON.stringify(item.checks)}. Your title and outcome stay unchanged.` }))
            .child(button(t, `workflow-remove-setup-${item.id}`, "Remove", (cx) => {
              setShared(SETUPS_KEY, { version: 1, items: savedSetups().filter((value) => value.id !== item.id) });
              this.setupNotice = "Saved setup removed. Existing tasks are unchanged."; cx.notify();
            }, { size: "sm", tip: "Remove only this reusable setup; keep tasks, sessions and the current draft" }))))))
        .child(button(t, "workflow-save-setup-toggle", this.setupSaveOpen ? "Cancel saving setup" : "Save current setup…", (cx) => {
          this.setupSaveOpen = !this.setupSaveOpen; this.setupError = null; cx.notify();
        }, { size: "sm", tip: "Save these repository, agent, check and limit choices for later tasks" }))
        .when(this.setupSaveOpen, (form) => form
          .child(this.field(t, "setupName", "Setup name"))
          .child(this.field(t, "setupPurpose", "When to use it"))
          .child(button(t, "workflow-save-setup", "Save setup", (cx) => this.saveSetup(cx), { disabled: this.busy, tip: "Save settings locally without creating a task or launching agents" })))
        .when(Boolean(this.setupError), (status) => status.child(div().role("alert").text_color(t.blocked).child(this.setupError)))
        .when(Boolean(this.setupNotice), (status) => status.child(div().role("status").child(row(t, this.setupNotice))))));
  }
}
