import { test } from "node:test";
import assert from "node:assert/strict";
import { prTurn, prReason, prName, ciRunning } from "../lib/lanes.js";

const now = new Date().toISOString(), old = "2020-01-01T00:00:00Z";
const ci = (state) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] } });
const pr = (extra = {}) => ({ repo: "acme/web", number: 7, title: "T", reasons: [], threads: 0, updatedAt: now, ...extra });

test("whose turn a PR is comes from its state, not from how its reason is worded", () => {
  assert.equal(prTurn(pr({ reasons: ["CI failing"] })), "me");
  assert.equal(prTurn(pr({ threads: 2 })), "me");
  assert.equal(prTurn(pr(), { requested: true }), "me");
  assert.equal(prTurn(pr({ ...ci("PENDING") })), "flight");
  assert.equal(prTurn(pr({ reasons: ["CI failing"] }), { busy: true }), "flight");
  assert.equal(prTurn(pr(), { ready: true }), "ready");
  assert.equal(prTurn(pr({ fresh: true, reasons: ["new, CI passed"], ...ci("SUCCESS") })), "ready");
  assert.equal(prTurn(pr({ fresh: true, reasons: ["new, CI running"], ...ci("PENDING") })), "flight");
  assert.equal(prTurn(pr({ reasons: ["CI failing"] }), { seen: true }), "open");
  assert.equal(prTurn(pr({ isDraft: true, reasons: ["draft"] })), "open");
  assert.equal(prTurn(pr({ reasons: ["CI failing"], updatedAt: old })), "old");
});

test("the reason says why a PR is here in plain words", () => {
  assert.equal(prReason(pr({ author: { login: "mlopez" }, threads: 1 }), { requested: true }), "mlopez asks for your review · 1 comment");
  assert.equal(prReason(pr({ author: { login: "ana" }, unasked: true }), { requested: true }), "ana opened a PR");
  assert.equal(prReason(pr({ reasons: ["CI failing", "changes requested"], threads: 2 })), "CI failing · changes requested · 2 comments");
  assert.equal(prReason(pr(), { ready: true }), "CI passed, ready to merge");
  assert.equal(prReason(pr({ ...ci("PENDING") })), "CI running");
  assert.equal(prName(pr()), "web #7");
  assert.equal(ciRunning("EXPECTED"), true);
});
