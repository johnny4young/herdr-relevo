import { openOverlay } from "herdr";

// A keyed window, not a dialog: Herdr dialogs consume Escape before mod handlers.
// It fits its content because the host's fixed-height cache path omits AX nodes.
export function openWorkflow(goalId, taskId = null) {
  openOverlay({ mod: "relevo", kind: "window", key: `relevo-workflow-${goalId}${taskId ? `-${taskId}` : ""}`, width: 0.6, props: { role: "workflow", goalId, ...(taskId ? { taskId } : {}) } });
}
