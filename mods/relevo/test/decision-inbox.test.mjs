import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemoItems, visibleItems, evidenceCurrent, markReviewed, advanceRevision, refreshEvidence, updateItem } from "../lib/decision-inbox.js";

function freeze(value) {
  Object.values(value).forEach((child) => { if (child && typeof child === "object") freeze(child); });
  return Object.freeze(value);
}

test("fixtures are explicitly fictional, independent and hierarchically identified", () => {
  const a = createDemoItems(), b = createDemoItems();
  assert.deepEqual(a, b);
  const ids = a.flatMap((item) => [item.id, item.goal.id, item.task.id, ...item.sessions.map((s) => s.id)]);
  assert.equal(new Set(ids).size, ids.length);
  a[0].evidence.checks[0].status = "passed";
  a[0].sessions[0].title = "changed";
  assert.notDeepEqual(a, b);
  b.forEach((item) => { assert.match(item.project, /fictional/); assert.ok(evidenceCurrent(item)); });
  assert.deepEqual(new Set(b.flatMap((i) => i.evidence.checks.map((c) => c.status))),
    new Set(["passed", "failed", "pending", "unknown", "skipped"]));
});

test("filters preserve order, do not mutate, and never infer ready from passing checks", () => {
  const items = freeze(createDemoItems());
  assert.deepEqual(visibleItems(items), items);
  for (const kind of ["blocked", "review", "ready"]) assert.deepEqual(visibleItems(items, kind), items.filter((i) => i.kind === kind));
  assert.deepEqual(visibleItems(items, "unrecognized"), []);
  assert.deepEqual(visibleItems(items, "reviewed"), []);
  assert.equal(visibleItems([markReviewed(items[0])], "reviewed").length, 1);
  assert.deepEqual(visibleItems([advanceRevision(markReviewed(items[0]))], "reviewed"), []);
});

test("evidence requires exact work identity and revision, not another item's passing results", () => {
  const [a, b] = createDemoItems();
  for (const evidence of [null, undefined, b.evidence, { ...a.evidence, revision: "r0" }, { ...a.evidence, itemId: "other" }]) {
    const stale = { ...a, evidence, reviewedRevision: a.revision };
    assert.equal(evidenceCurrent(stale), false);
    assert.equal(markReviewed(stale).reviewedRevision, null);
    if (!evidence || evidence.itemId !== a.id) assert.equal(evidenceCurrent(refreshEvidence(stale)), false);
    assert.deepEqual(visibleItems([stale], "reviewed"), []);
  }
});

test("missing, empty, malformed and unsupported results cannot be marked reviewed", () => {
  const [a] = createDemoItems();
  for (const checks of [null, [], [{}], [null], [{ label: "Check", status: "success" }], [{ label: "", status: "passed" }]]) {
    const item = { ...a, evidence: { ...a.evidence, checks } };
    assert.equal(evidenceCurrent(item), false);
    assert.equal(markReviewed(item).reviewedRevision, null);
    assert.equal(markReviewed(refreshEvidence(item)).reviewedRevision, null);
  }
  for (const criteria of [null, [], [{ label: "Criterion", status: "unsupported" }]]) {
    assert.equal(evidenceCurrent({ ...a, criteria }), false);
  }
});

test("reviewing is inspection, not approval: all five supported statuses remain distinct", () => {
  for (const status of ["passed", "failed", "pending", "unknown", "skipped"]) {
    const [a] = createDemoItems();
    a.evidence.checks[0].status = status;
    a.criteria[0].status = status;
    assert.ok(evidenceCurrent(a));
    const reviewed = markReviewed(a);
    assert.equal(reviewed.reviewedRevision, a.revision);
    assert.equal(reviewed.evidence.checks[0].status, status);
    assert.equal(reviewed.criteria[0].status, status);
  }
});

test("review and refresh are idempotent and helpers do not mutate frozen inputs", () => {
  const [a] = freeze(createDemoItems());
  const reviewed = markReviewed(a);
  assert.deepEqual(markReviewed(reviewed), reviewed);
  assert.deepEqual(refreshEvidence(reviewed), reviewed);
  const changed = advanceRevision(reviewed);
  assert.equal(changed.revision, "r2");
  assert.equal(changed.reviewedRevision, null);
  assert.equal(evidenceCurrent(changed), false);
  assert.equal(markReviewed(changed).reviewedRevision, null);
  const refreshed = refreshEvidence(changed);
  assert.ok(evidenceCurrent(refreshed));
  assert.equal(refreshed.reviewedRevision, null);
  assert.deepEqual(refreshEvidence(refreshed), refreshed);
  assert.deepEqual(refreshed.evidence.checks, a.evidence.checks);
  assert.equal(markReviewed(refreshed).reviewedRevision, "r2");
  assert.equal(advanceRevision(changed).revision, "r3");
  assert.equal(a.revision, "r1");
  assert.equal(a.reviewedRevision, null);
});

test("updates change only the selected identity even when every item shares a revision", () => {
  const items = freeze(createDemoItems());
  const next = updateItem(items, items[1].id, advanceRevision);
  assert.strictEqual(next[0], items[0]);
  assert.strictEqual(next[2], items[2]);
  assert.equal(next[1].revision, "r2");
  assert.equal(next[1].evidence.revision, "r1");
  assert.deepEqual(updateItem(items, "missing", advanceRevision), items);
  const refreshed = updateItem(next, next[1].id, refreshEvidence);
  assert.ok(evidenceCurrent(refreshed[1]));
  assert.equal(refreshed[0].revision, "r1");
  assert.equal(refreshed[2].reviewedRevision, null);
});

test("missing evidence cannot be invented by refresh and stale markers are cleared", () => {
  const [a] = createDemoItems();
  const missing = { ...a, evidence: null, reviewedRevision: a.revision };
  assert.equal(refreshEvidence(missing).reviewedRevision, null);
  assert.equal(evidenceCurrent(refreshEvidence(missing)), false);
  const stale = { ...advanceRevision(a), reviewedRevision: "r1" };
  assert.equal(refreshEvidence(stale).reviewedRevision, null);
});


test("every fixture identifies a human decision, choices and who acts next", () => {
  for (const item of createDemoItems()) {
    assert.equal(typeof item.nextActor, "string");
    assert.ok(item.nextActor.includes("fictional"));
    assert.ok(item.nextStep.length > 20);
    assert.equal(item.decisionOptions.length, 2);
    assert.equal(new Set(item.decisionOptions.map((option) => option.id)).size, 2);
    assert.ok(item.decisionOptions.every((option) => option.label.length > 10));
    assert.equal(item.reviewedRevision, null);
  }
  const [exampleA] = createDemoItems();
  assert.deepEqual(exampleA.decisionOptions.map((option) => option.id), ["reuse", "replace"]);
  assert.equal(exampleA.criteria[0].status, "failed");
  assert.equal(markReviewed(exampleA).criteria[0].status, "failed");
  assert.match(exampleA.recommendation, /does not decide the policy or authorize/);
});
