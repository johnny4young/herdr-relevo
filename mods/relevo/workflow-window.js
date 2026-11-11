import { panes, run, setShared, shared } from "herdr";

export const RUN_PANES = "relevo.runs.open";
export const RUN_REQUEST = "relevo.runs.request";

// Entries whose pane is gone drop out on the next write.
export const liveRunPanes = () => Object.fromEntries(
  Object.entries(shared(RUN_PANES) ?? {}).filter(([, pane]) => panes().some((p) => p.pane === pane)),
);

// A run is a pane beside the work; opening it again focuses that pane and selects the task.
export function openWorkflow(goalId, taskId = null) {
  const pane = liveRunPanes()[goalId];
  if (pane) {
    setShared(RUN_REQUEST, { goalId, taskId, at: Date.now() });
    run("pane.focus", { pane });
    return;
  }
  run("pane.split", { direction: "right", mod: "relevo", props: { role: "workflow", goalId, ...(taskId ? { taskId } : {}) } });
}
