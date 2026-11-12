// Project workflow tasks onto a goal plan without changing the persisted goal.
const HUMAN_STATES = new Set(["todo", "working", "review", "done"]);
const CANCELLED = "cancelled";

const stepsOf = (goal) => Array.isArray(goal?.steps) ? goal.steps : [];
const tasksOf = (tasks) => Array.isArray(tasks) ? tasks : [];
const forStep = (goal, step, tasks) => tasksOf(tasks).filter((task) =>
  task?.goalId === goal?.id && task?.goalStep?.id === step?.id && task?.state !== CANCELLED);

function validLink(goal, step, task) {
  return task.goalId === goal.id && task.goalStep?.id === step.id &&
    task.goalStep.title === step.title && task.goalStep.criteria === goal.criteria;
}

function taskState(task) {
  switch (task.state) {
    case "accepted": return "done";
    case "needs_you": return "review";
    case "running":
    case "ready":
    case "needs_review": return "working";
    case "blocked":
    case "failed": return "blocked";
    case "planned": return "todo";
    default: return null;
  }
}

/**
 * Return one effective row per current goal step. A task only projects onto a
 * step when its goal, step id, title, and criteria snapshot still match.
 * Unrecognized task states and stale links are surfaced as issues, never
 * treated as completion. `blocked` is a display-only state.
 */
export function projectGoalPlan(goal, tasks = []) {
  return stepsOf(goal).map((step) => {
    const linked = forStep(goal, step, tasks);
    const matching = linked.filter((task) => validLink(goal, step, task));
    const stale = linked.some((task) => !validLink(goal, step, task));
    // A human validation is final even if workflow data has become ambiguous.
    if (step.state === "done") return { step, state: "done", source: "manual", taskId: null,
      issue: matching.length > 1 ? "Multiple active workflow tasks match this step." :
        stale ? "A stale workflow task is also linked to this step." : null };
    if (matching.length > 1) {
      return { step, state: step.state, source: "manual", taskId: null, issue: "Multiple active workflow tasks match this step." };
    }

    if (matching.length === 1) {
      const task = matching[0], state = taskState(task);
      if (state) {
        // The current valid task is authoritative, including manual review
        // that is still in flight.
        return { step, state, source: "workflow", taskId: task.id ?? null,
          issue: stale ? "A stale workflow task is also linked to this step." : null };
      }
    }

    const state = HUMAN_STATES.has(step.state) ? step.state : "todo";
    const issue = stale ? "A linked workflow task no longer matches this step or its criteria." :
      matching.length === 1 ? `Workflow task state “${String(matching[0].state)}” is not recognized.` : null;
    return { step, state, source: "manual", taskId: null, issue };
  });
}

/** IDs of steps safe to offer as new work: active work is excluded, as are
 * completed/review states and every non-cancelled task link (including stale
 * links that need attention). Cancelled tasks do not reserve a step. */
export function defaultPlanStepIds(goal, tasks = []) {
  return projectGoalPlan(goal, tasks)
    .filter(({ step, state }) => ["todo", "working"].includes(state) &&
      !forStep(goal, step, tasks).length)
    .map(({ step }) => step.id);
}
