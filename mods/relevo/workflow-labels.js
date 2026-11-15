import { div } from "gpui-kit";

const STATES = { planned: "Planned", ready: "Ready", running: "In progress", needs_review: "Needs review", needs_you: "Needs you", accepted: "Completed", completed: "Completed", blocked: "Blocked", failed: "Failed", cancelled: "Cancelled" };
export const row = (t, value) => div().w_full().min_w(0).text_size(13).text_color(t.muted).child(value);
export const taskState = (state) => STATES[state] ?? state ?? "Unknown";
export const reportState = (state) => ({ completed: "Completed", changes_requested: "Changes requested", blocked: "Blocked" }[state] ?? taskState(state));
export const caption = (value, limit = 42) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
export const SUMMARY_PREVIEW = 1200;
export { reportNotes } from "./lib/run-report.js";
// A terminal title follows the agent's state; the program and a named tab stay put.
export const agentLabel = (agent) => {
  const name = agent.program?.name || agent.title || agent.app || agent.address;
  const tab = agent.tab_name && !/^\d+$/.test(agent.tab_name) ? agent.tab_name : null;
  return !tab ? name : tab.includes(name) ? tab : `${name} · ${tab}`;
};
