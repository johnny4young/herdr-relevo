import { div } from "gpui-kit";

export const row = (t, value) => div().w_full().min_w(0).text_size(13).text_color(t.muted).child(value);
export const caption = (value, limit = 42) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
export const SUMMARY_PREVIEW = 1200;
export { reportNotes } from "./lib/run-report.js";
export { taskState, reportState, verdictLine, role, count, attemptLabel } from "./lib/run-words.js";
// A terminal title follows the agent's state; the program and a named tab stay put.
export const agentLabel = (agent) => {
  const name = agent.program?.name || agent.title || agent.app || agent.address;
  const tab = agent.tab_name && !/^\d+$/.test(agent.tab_name) ? agent.tab_name : null;
  return !tab ? name : tab.includes(name) ? tab : `${name} · ${tab}`;
};
