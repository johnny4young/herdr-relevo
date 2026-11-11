import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultPlanStepIds, projectGoalPlan } from "../lib/goal-plan.js";

const makeGoal = (steps = [{ id: "s1", title: "Add search", state: "todo" }]) => ({
  id: "g1", criteria: "Search results are useful", owner: "Human", steps,
});
const linked = (goal, state = "accepted", extra = {}) => ({
  id: "t1", goalId: goal.id, goalStep: { id: "s1", title: "Add search", criteria: goal.criteria }, state, ...extra,
});

test("only an exact goal, step, title, and criteria snapshot can project task state", () => {
  const goal = makeGoal();
  const accepted = projectGoalPlan(goal, [linked(goal)])[0];
  assert.deepEqual(accepted, { step: goal.steps[0], state: "done", source: "workflow", taskId: "t1", issue: null });

  for (const task of [
    { ...linked(goal), goalId: "another-goal" },
    { ...linked(goal), goalStep: { ...linked(goal).goalStep, title: "Old title" } },
    { ...linked(goal), goalStep: { ...linked(goal).goalStep, criteria: "Old criteria" } },
    { ...linked(goal), goalStep: { ...linked(goal).goalStep, id: "another-step" } },
  ]) {
    const row = projectGoalPlan(goal, [task])[0];
    assert.equal(row.state, "todo");
    assert.equal(row.source, "manual");
    assert.ok(row.issue || task.goalId !== goal.id || task.goalStep.id !== goal.steps[0].id);
  }
});

test("non-plan metadata edits preserve a valid projection", () => {
  const goal = { ...makeGoal(), owner: "Changed", priority: 0 };
  assert.equal(projectGoalPlan(goal, [linked(goal)])[0].state, "done");
});

test("manual review remains manual without a valid task and ambiguous matches fail closed", () => {
  const goal = makeGoal([{ id: "s1", title: "Add search", state: "review" }]);
  const manual = projectGoalPlan(goal, [linked(goal, "running", { goalStep: { id: "s1", title: "Old title", criteria: goal.criteria } })])[0];
  assert.equal(manual.state, "review");
  assert.equal(manual.source, "manual");

  const ambiguous = projectGoalPlan(goal, [linked(goal), linked(goal, "running", { id: "t2" })])[0];
  assert.equal(ambiguous.state, "review");
  assert.equal(ambiguous.source, "manual");
  assert.equal(ambiguous.taskId, null);
  assert.match(ambiguous.issue, /Multiple/);
});

test("manual validation remains complete even when multiple workflow tasks match", () => {
  const goal = makeGoal([{ id: "s1", title: "Add search", state: "done" }]);
  const rows = projectGoalPlan(goal, [linked(goal), linked(goal, "running", { id: "t2" })]);
  assert.equal(rows[0].state, "done");
  assert.equal(rows[0].source, "manual");
  assert.equal(rows[0].taskId, null);
  assert.match(rows[0].issue, /Multiple/);
});

test("workflow outcomes project into display states without mutating the goal", () => {
  const states = [
    ["needs_you", "review"], ["running", "working"], ["ready", "working"],
    ["needs_review", "working"], ["blocked", "blocked"], ["failed", "blocked"], ["planned", "todo"],
  ];
  for (const [taskState, projected] of states) {
    const goal = makeGoal();
    const before = JSON.stringify(goal);
    const row = projectGoalPlan(goal, [linked(goal, taskState)])[0];
    assert.equal(row.state, projected, taskState);
    assert.equal(row.source, "workflow");
    assert.equal(JSON.stringify(goal), before);
  }
});

test("accepted cannot satisfy an edited step; cancelled links do not block a new plan", () => {
  const edited = makeGoal([{ id: "s1", title: "Revised search", state: "todo" }]);
  const oldAccepted = linked(edited, "accepted", { goalStep: { id: "s1", title: "Add search", criteria: edited.criteria } });
  assert.equal(projectGoalPlan(edited, [oldAccepted])[0].state, "todo");
  assert.deepEqual(defaultPlanStepIds(edited, [oldAccepted]), []);
  assert.deepEqual(defaultPlanStepIds(edited, [linked(edited, "cancelled")]), ["s1"]);
});

test("default selection includes only unlinked todo or working steps", () => {
  const goal = makeGoal([
    { id: "todo", title: "First", state: "todo" },
    { id: "working", title: "Second", state: "working" },
    { id: "review", title: "Third", state: "review" },
    { id: "done", title: "Fourth", state: "done" },
  ]);
  assert.deepEqual(defaultPlanStepIds(goal), ["todo", "working"]);
  assert.deepEqual(defaultPlanStepIds(goal, [
    { goalId: goal.id, goalStep: { id: "working" }, state: "ready" },
  ]), ["todo"]);
});
