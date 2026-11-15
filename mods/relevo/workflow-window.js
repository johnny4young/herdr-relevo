import { panes, run, setShared, shared } from "herdr";

export const RUN_PANES = "relevo.runs.open";
export const RUN_REQUEST = "relevo.runs.request";
// Stamps of the one-time asks a run window already carried out, so a reloaded pane does not repeat them.
export const RUN_APPLIED = "relevo.runs.applied";
// The stamp of a change request sent to the run window as a follow-up, until the window takes it.
export const RUN_FOLLOW_UP = "relevo.runs.followup";
const KEPT = 20;

let last = 0;
const stamp = () => (last = Math.max(Date.now(), last + 1));

// True the first time a stamp is seen; an ask without one always applies.
export function takeAsk(at) {
  if (!at) return true;
  const applied = shared(RUN_APPLIED) ?? [];
  if (applied.includes(at)) return false;
  setShared(RUN_APPLIED, [...applied, at].slice(-KEPT));
  return true;
}

// Entries whose pane is gone drop out on the next write.
export const liveRunPanes = () => Object.fromEntries(
  Object.entries(shared(RUN_PANES) ?? {}).filter(([, pane]) => panes().some((p) => p.pane === pane)),
);

// A run is a pane beside the work; opening it again focuses that pane and selects the task.
// `ask` is what the panel wants shown: { tab }, { followUp: "blocked" | "changes" | "rerun", text }, { setups: true } or { setup: id }.
// An ask is stamped so it is carried out once; the stamp is returned.
export function openWorkflow(goalId, taskId = null, ask = {}) {
  const pane = liveRunPanes()[goalId], at = stamp(), once = Object.keys(ask).length > 0;
  if (pane) {
    setShared(RUN_REQUEST, { goalId, taskId, ...ask, at });
    run("pane.focus", { pane });
  } else run("pane.split", { direction: "right", mod: "relevo", props: { role: "workflow", goalId, ...(taskId ? { taskId } : {}), ...ask, ...(once ? { at } : {}) } });
  return at;
}
