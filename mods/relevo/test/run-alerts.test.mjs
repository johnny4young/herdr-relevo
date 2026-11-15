import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake } from "./fake/herdr.mjs";

const { newResults, resultMark } = await import("../lib/run-alerts.js");
const { runResultAlerts, batchAlert } = await import("../alerts.js");
beforeEach(resetFake);

const task = (id, state, over = {}) => ({ id, state, title: `Task ${id}`, revision: "r1", round: 1, root: "/home/test/code/billing", ...over });
const reviewed = (status) => ({ reviewer: { label: "Haiku" }, attempts: [{ role: "reviewer", report: { status } }] });

test("a result is new once per revision and attempt, and the first look only learns what is there", () => {
  assert.deepEqual(newResults(null, [task("a", "needs_you")]).fresh, []);
  const known = [resultMark(task("a", "needs_you"))];
  assert.deepEqual(newResults(known, [task("a", "needs_you")]).fresh, []);
  assert.deepEqual(newResults(known, [task("a", "needs_you", { round: 2 })]).fresh.map((t) => t.id), ["a"]);
  assert.deepEqual(newResults(known, [task("b", "running")]).fresh, []);
});

test("Result ready names the task and the reviewer's verdict, selects its row and opens Reviews", () => {
  const selected = [];
  runResultAlerts([task("a", "needs_you", reviewed("completed"))], (id) => selected.push(id));
  assert.equal(fake.notices.length, 0, "the first read only records what already waits");
  runResultAlerts([task("a", "needs_you", reviewed("completed")), task("b", "needs_you", reviewed("completed"))], (id) => selected.push(id));
  assert.equal(fake.notices.length, 1);
  assert.equal(fake.notices[0].title, "Result ready · Task b");
  assert.equal(fake.notices[0].body, "Haiku approved · click to review");
  assert.equal(fake.notices[0].level, "success");
  assert.deepEqual(fake.notices[0].action, { name: "relevo.panel-reviews" });
  assert.deepEqual(selected, ["result-b"]);
  runResultAlerts([task("a", "needs_you"), task("b", "needs_you")], () => {});
  assert.equal(fake.notices.length, 1, "the same result is not announced twice");
});

test("Batch accepted counts the results, names their repository and opens the run", () => {
  batchAlert([task("a", "accepted"), task("b", "accepted"), task("c", "accepted")], "g1");
  const [n] = fake.notices;
  assert.equal(n.title, "Batch accepted · 3 results");
  assert.match(n.body, /^billing · Task a · Task b · Task c$/);
  assert.equal(n.timeout, 6000);
  assert.deepEqual(n.action, { name: "relevo.workflow-g1" });
});
