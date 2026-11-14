import { test } from "node:test";
import { setTimeout, clearTimeout } from "node:timers";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRuntime } from "../runtime/coordinator.mjs";
import { linkedDecision } from "../lib/goal-workflow.js";
import { transaction } from "../runtime/store.mjs";
import { runChecks } from "../runtime/evidence.mjs";

async function fixture({ sendCode = 0, checkCode = 0, maxRounds = 3, checksImpl: injectedChecks, fingerprintImpl: injectedFingerprint, onSend, wake } = {}) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "relevo-runtime-"));
  const home = path.join(base, "home"), root = path.join(base, "repo");
  fs.mkdirSync(home); fs.mkdirSync(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: root }); execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
  fs.writeFileSync(path.join(home, "relevo-goals.json"), JSON.stringify({ goals: [{ id: "g1", state: "open" }] }));
  const sends = [], interrupts = [];
  const actorStatuses = new Map();
  const runCommand = async ([, ...args]) => {
    if (args[0] === "get") return { code: 0, stdout: JSON.stringify({ state: "live", status: { app: "codex", state: actorStatuses.get(args[2]) ?? "idle" }, cwd: root, turn: 1 }) };
    if (args[0] === "send") { sends.push(args); await onSend?.(args); return { code: sendCode, stdout: "", stderr: sendCode ? "offline" : "" }; }
    if (args[0] === "interrupt") { interrupts.push(args[1]); return { code: 0, stdout: "" }; }
    throw new Error(`unexpected hc ${args[0]}`);
  };
  let now = Date.parse("2026-01-02T03:04:05Z");
  let revision = "checkout-r1";
  const runtime = createRuntime({ home, runCommand, wake, clock: () => now++, fingerprintImpl: injectedFingerprint ?? (async () => revision),
    checksImpl: injectedChecks ?? (async () => [{ argv: ["npm", "test"], code: checkCode, stdout: "", stderr: "" }]) });
  const task = { goalId: "g1", title: "Example task", criteria: "Expected behavior", root,
    executor: { address: "exec-agent", label: "Executor" }, reviewer: { address: "review-agent", label: "Reviewer" },
    checks: [["npm", "test"]], maxRounds, maxMinutes: 10 };
  const created = await runtime.command({ action: "create", task });
  const taskId = created.result.taskId;
  // The state keeps only a hash; the token travels in the prompt sent to the agent.
  const tokenFor = (attempt) => sends.map((args) => args.at(-1)).find((text) => text.includes(attempt.id))?.match(/"token":"([^"]+)"/)?.[1] ?? attempt.token;
  const report = (role, status, summary, attemptOverride, extra = {}) => {
    const current = runtime.read().tasks.find((t) => t.id === taskId), attempt = attemptOverride ?? current.attempts.at(-1);
    const reports = path.join(home, "relevo-workflow", "reports"); fs.mkdirSync(reports, { recursive: true });
    fs.writeFileSync(path.join(reports, `${attempt.id}.json`), JSON.stringify({ attemptId: attempt.id, token: tokenFor(attempt), status, summary, ...extra }));
    return attempt;
  };
  return { base, home, root, runtime, taskId, report, tokenFor, sends, interrupts, setActorStatus(address, status) { actorStatuses.set(address, status); }, setRevision(value) { revision = value; }, setNow(value) { now = value; }, get now() { return now; } };
}

test("executor checks reviewer and explicit human acceptance complete the task", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  assert.equal(f.runtime.read().tasks[0].state, "running"); assert.equal(f.sends.length, 1);
  f.report("executor", "completed", "Implementation complete"); await f.runtime.tick();
  assert.equal(f.runtime.read().tasks[0].state, "running");
  await f.runtime.tick(); assert.equal(f.runtime.read().tasks[0].attempts.at(-1).role, "reviewer");
  f.report("reviewer", "completed", "Reviewed; criteria met"); await f.runtime.tick();
  let current = f.runtime.read().tasks[0]; assert.equal(current.state, "needs_you");
  await f.runtime.command({ action: "decide", taskId: f.taskId, outcome: "accept", revision: current.revision });
  assert.equal(f.runtime.read().tasks[0].state, "accepted");
  const question = { id: "g1", decision: "Accept the result?", decisionLink: { taskId: f.taskId, question: "Accept the result?" } };
  assert.equal(linkedDecision(question, f.runtime.read().tasks).state, "resolved");
});

test("accepting a prerequisite automatically dispatches its already-started dependent task", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const definition = { goalId: 'g1', title: 'Follow-up', criteria: 'Expected follow-up', root: f.root,
    executor: { address: 'exec-agent' }, reviewer: { address: 'review-agent' }, dependsOn: [f.taskId] };
  const child = (await f.runtime.command({ action: 'create', task: definition })).result.taskId;
  const unstarted = (await f.runtime.command({ action: 'create', task: { ...definition, title: 'Later unstarted work' } })).result.taskId;
  await f.runtime.command({ action: 'start', taskId: child });
  await f.runtime.tick(); assert.equal(f.sends.length, 0, 'waits for acceptance');
  await f.runtime.command({ action: 'start', taskId: f.taskId }); await f.runtime.tick();
  f.report('executor', 'completed', 'Implemented'); await f.runtime.tick();
  f.report('reviewer', 'completed', 'Reviewed'); await f.runtime.tick();
  const parent = f.runtime.read().tasks.find((task) => task.id === f.taskId);
  const before = f.sends.length;
  await f.runtime.command({ action: 'decide', taskId: f.taskId, outcome: 'accept', revision: parent.revision });
  await f.runtime.tick();
  assert.equal(f.sends.length, before + 1);
  assert.equal(f.runtime.read().tasks.find((task) => task.id === child).state, 'running');
  assert.equal(f.runtime.read().tasks.find((task) => task.id === unstarted).state, 'planned');
});

test("nested Codex done status is eligible and uses hc's idle send guard", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  f.setActorStatus("exec-agent", "done");
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  assert.equal(f.runtime.read().tasks[0].state, "running");
  assert.equal(f.sends[0].includes("--if"), false, "hc rejects --if done; normal send uses its permission-prompt guard");
});

test("send uncertainty blocks automatic redispatch and restart reconciliation prevents duplicates", async (t) => {
  const f = await fixture({ sendCode: 1 }); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  assert.equal(f.runtime.read().tasks[0].state, "blocked"); assert.equal(f.sends.length, 1);
  await assert.rejects(f.runtime.command({ action: "resume", taskId: f.taskId }), /uncertain/);
  f.runtime.recover(); await f.runtime.tick();
  assert.equal(f.sends.length, 1);
  assert.equal(f.runtime.read().tasks[0].attempts.length, 1);
});

test("uncertain follow-up delivery is never automatically resent", async (t) => {
  const f = await fixture({ sendCode: 1 }); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "message", taskId: f.taskId, text: "One-shot update", mode: "now" });
  assert.equal(f.runtime.read().tasks[0].messages[0].status, "uncertain");
  await f.runtime.tick(); await f.runtime.tick();
  assert.equal(f.sends.length, 1);
  assert.equal(f.runtime.read().tasks[0].messages[0].status, "uncertain");
});

test("an uncertain attempt reserves its checkout and agent from another task", async (t) => {
  const f = await fixture({ sendCode: 1 }); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const task = { goalId: "g1", title: "Second task", criteria: "Expected outcome", root: f.root,
    executor: { address: "exec-agent" }, reviewer: { address: "review-agent" }, checks: [["npm", "test"]] };
  const second = (await f.runtime.command({ action: "create", task })).result.taskId;
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  await f.runtime.command({ action: "start", taskId: second }); await f.runtime.tick();
  const doc = f.runtime.read();
  assert.equal(f.sends.length, 1);
  assert.equal(doc.tasks.find((item) => item.id === second).state, "ready", "waits instead of being blocked");
  assert.equal(doc.tasks.find((item) => item.id === second).error, null);
});

test("configured skills queue bounded prompts and reject unknown skill names", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await assert.rejects(f.runtime.command({ action: "skill", taskId: f.taskId, skill: "unknown-skill" }), /configured skill/);
  await f.runtime.command({ action: "skill", taskId: f.taskId, skill: "fix-ci", mode: "queue" });
  const message = f.runtime.read().tasks[0].messages[0];
  assert.equal(message.status, "queued");
  assert.match(message.text, /configured skill "fix-ci"/);
  assert.match(message.text, /grants no tools or permissions/);
});

test("queued follow-up cannot starve a ready reviewer", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  f.report("executor", "completed", "Implementation complete");
  f.setActorStatus("review-agent", "working"); await f.runtime.tick();
  assert.equal(f.runtime.read().tasks[0].state, "needs_review");
  await f.runtime.command({ action: "message", taskId: f.taskId, text: "Please note the follow-up", mode: "queue" });
  f.setActorStatus("review-agent", "idle"); await f.runtime.tick();
  assert.equal(f.runtime.read().tasks[0].attempts.at(-1).role, "reviewer");
});

test("send-now follow-up cannot run the executor during an active reviewer attempt", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  f.report("executor", "completed", "Implementation complete"); await f.runtime.tick();
  assert.equal(f.runtime.read().tasks[0].attempts.at(-1).role, "reviewer");
  const sendsBeforeFollowup = f.sends.length;
  await f.runtime.command({ action: "message", taskId: f.taskId, text: "Change it now", mode: "now" });
  assert.equal(f.sends.length, sendsBeforeFollowup);
  assert.equal(f.runtime.read().tasks[0].messages[0].status, "queued");
});

test("stale checkout revision prevents human acceptance", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  f.report("executor", "completed", "Done"); await f.runtime.tick(); await f.runtime.tick();
  f.report("reviewer", "completed", "Looks good"); await f.runtime.tick();
  const pending = f.runtime.read().tasks[0];
  f.setRevision("checkout-r2");
  await assert.rejects(f.runtime.command({ action: "decide", taskId: f.taskId, outcome: "accept", revision: pending.revision }), /stale/);
  assert.equal(f.runtime.read().tasks[0].state, "needs_you");
});

test("reviewer findings at the attempt cap block further correction dispatch", async (t) => {
  const f = await fixture({ maxRounds: 1 }); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  f.report("executor", "completed", "Done"); await f.runtime.tick();
  f.report("reviewer", "changes_requested", "The empty state needs an explanation"); await f.runtime.tick();
  const task = f.runtime.read().tasks[0];
  assert.equal(task.state, "blocked");
  assert.match(task.error, /Correction budget exhausted/);
  assert.equal(task.round, 1);
  assert.equal(f.sends.length, 2);
});

test("reviewer corrections get one bounded executor retry and require the current revision", async (t) => {
  const f = await fixture({ maxRounds: 2 }); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  f.report("executor", "completed", "Initial work"); await f.runtime.tick();
  f.report("reviewer", "changes_requested", "Fix the empty state"); await f.runtime.tick();
  assert.equal(f.runtime.read().tasks[0].state, "running");
  assert.equal(f.runtime.read().tasks[0].attempts.at(-1).role, "executor");
  f.report("executor", "completed", "Correction applied");
  f.setActorStatus("review-agent", "working"); await f.runtime.tick();
  assert.equal(f.runtime.read().tasks[0].state, "needs_review");
  f.setRevision("changed-before-review"); f.setActorStatus("review-agent", "idle"); await f.runtime.tick();
  assert.equal(f.runtime.read().tasks[0].state, "blocked");
  assert.match(f.runtime.read().tasks[0].error, /Checkout changed after checks/);
});

test("a second reviewer correction exhausts the bounded retry budget", async (t) => {
  const f = await fixture({ maxRounds: 2 }); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  f.report("executor", "completed", "Initial work"); await f.runtime.tick();
  f.report("reviewer", "changes_requested", "First finding"); await f.runtime.tick();
  f.report("executor", "completed", "First correction"); await f.runtime.tick();
  f.report("reviewer", "changes_requested", "Second finding"); await f.runtime.tick();
  const task = f.runtime.read().tasks[0];
  assert.equal(task.state, "blocked");
  assert.match(task.error, /Correction budget exhausted/);
  assert.equal(task.round, 2);
});

test("a failed required check at the attempt cap blocks acceptance and further dispatch", async (t) => {
  const f = await fixture({ checkCode: 1, maxRounds: 1 }); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  f.report("executor", "completed", "Done"); await f.runtime.tick();
  const task = f.runtime.read().tasks[0];
  assert.equal(task.state, "blocked");
  assert.match(task.error, /Correction budget exhausted/);
  assert.equal(task.checksResult[0].code, 1);
  assert.equal(task.attempts.length, 1);
});

test("human requested changes route the next attempt to the executor", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  f.report("executor", "completed", "Done"); await f.runtime.tick();
  f.report("reviewer", "completed", "Reviewed"); await f.runtime.tick();
  const pending = f.runtime.read().tasks[0];
  await f.runtime.command({ action: "decide", taskId: f.taskId, outcome: "changes", text: "Clarify empty state", revision: pending.revision });
  await f.runtime.tick();
  assert.equal(f.runtime.read().tasks[0].attempts.at(-1).role, "executor");
  assert.match(f.sends.at(-1).at(-1), /Requested corrections: Clarify empty state/);
});

test("a stale member makes a decision batch leave every selected task untouched", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const second = (await f.runtime.command({ action: "create", task: { goalId: "g1", title: "Second task", criteria: "Expected outcome", root: f.root,
    executor: { address: "exec-agent" }, reviewer: { address: "review-agent" } } })).result.taskId;
  transaction(f.home, (doc) => {
    doc.tasks[0].state = "needs_you"; doc.tasks[0].revision = "checkout-r1";
    const other = doc.tasks.find((item) => item.id === second); other.state = "needs_you"; other.revision = "stale-revision";
  });
  await assert.rejects(f.runtime.command({ action: "batch", ids: [f.taskId, second], outcome: "accept", preview: false,
    revisions: { [f.taskId]: "checkout-r1", [second]: "stale-revision" } }), /stale/);
  const tasks = f.runtime.read().tasks;
  assert.deepEqual(tasks.map((item) => item.state), ["needs_you", "needs_you"]);
  assert.deepEqual(tasks.map((item) => item.decisions), [[], []]);
});

test("timeout interrupts once, requires explicit reconciliation, and ignores a late old report", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  const old = f.runtime.read().tasks[0].attempts.at(-1);
  f.setActorStatus("exec-agent", "working");
  f.setNow(Date.parse(old.at) + 11 * 60_000); await f.runtime.tick(); await f.runtime.tick();
  assert.deepEqual(f.interrupts, ["exec-agent"]);
  assert.equal(f.runtime.read().tasks[0].attempts.at(-1).timedOut, true);
  await assert.rejects(f.runtime.command({ action: "resume", taskId: f.taskId }), /uncertain/);
  await assert.rejects(f.runtime.command({ action: "reconcile", taskId: f.taskId, attemptId: old.id, confirmStopped: false }), /explicitly confirm/);
  f.setActorStatus("exec-agent", "idle");
  await f.runtime.command({ action: "reconcile", taskId: f.taskId, attemptId: old.id, confirmStopped: true });
  await f.runtime.command({ action: "resume", taskId: f.taskId }); await f.runtime.tick();
  const next = f.runtime.read().tasks[0].attempts.at(-1); assert.notEqual(next.id, old.id);
  f.report("executor", "completed", "Late report", old);
  await f.runtime.tick();
  assert.equal(f.runtime.read().tasks[0].attempts.at(-1).id, next.id);
  assert.equal(f.runtime.read().tasks[0].state, "running");
  assert.equal(f.sends.length, 2);
});

for (const action of ['pause', 'stop']) test(`${action} during dispatch preparation preserves the task without sending or consuming a round`, async (t) => {
  let started, release, armed = false;
  const preparing = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture({ fingerprintImpl: async () => { if (armed) { started(); await gate; } return 'checkout-r1'; } });
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: 'start', taskId: f.taskId });
  armed = true;
  const dispatching = f.runtime.tick(); await preparing;

  await f.runtime.command({ action, taskId: f.taskId });
  release(); await dispatching;

  const task = f.runtime.read().tasks[0];
  assert.equal(task.state, 'ready');
  assert.equal(task.paused, true);
  assert.equal(task.error, null);
  assert.equal(task.round, 0);
  assert.equal(task.attempts.length, 0);
  assert.equal(f.sends.length, 0);
  await f.runtime.command({ action: 'resume', taskId: f.taskId }); await f.runtime.tick();
  assert.equal(f.sends.length, 1);
  assert.equal(f.runtime.read().tasks[0].round, 1);
});

test('stopping required checks preserves the report and resumes validation without another implementation round', async (t) => {
  let started, runs = 0;
  const checking = new Promise((resolve) => { started = resolve; });
  const f = await fixture({ maxRounds: 1, checksImpl: async (_root, _checks, { signal }) => {
    runs++;
    if (runs > 1) return [{ code: 0, stdout: '', stderr: '' }];
    started();
    return await new Promise((resolve) => signal.addEventListener('abort', () => resolve([{ code: 'cancelled' }]), { once: true }));
  } });
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: 'start', taskId: f.taskId }); await f.runtime.tick();
  const attempt = f.report('executor', 'completed', 'Implementation complete');
  const collecting = f.runtime.tick(); await checking;

  await f.runtime.command({ action: 'stop' }); await collecting;

  const task = f.runtime.read().tasks[0];
  assert.equal(task.state, 'running');
  assert.equal(task.paused, true);
  assert.equal(task.error, null);
  assert.deepEqual(task.checksResult, []);
  assert.equal(task.attempts[0].state, 'running');
  assert.equal(task.attempts[0].id, attempt.id);
  await f.runtime.command({ action: 'resume', taskId: f.taskId }); await f.runtime.tick();
  const resumed = f.runtime.read().tasks[0];
  assert.equal(runs, 2);
  assert.equal(resumed.round, 1);
  assert.equal(resumed.attempts[0].id, attempt.id);
  assert.equal(resumed.attempts[0].state, 'reported');
  assert.equal(resumed.attempts.at(-1).role, 'reviewer');
  assert.equal(f.sends.length, 2, 'one executor and one reviewer, with no implementation retry');
});

test("cancelling while required checks run aborts the in-flight check work", async (t) => {
  let started;
  const hasStarted = new Promise((resolve) => { started = resolve; });
  let releaseChecks, observedSignal;
  const checksImpl = async (_root, _checks, options) => {
    observedSignal = options.signal;
    started();
    await new Promise((resolve) => { releaseChecks = resolve; });
    return [{ code: 0, stdout: "", stderr: "" }];
  };
  const f = await fixture({ checksImpl }); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  f.report("executor", "completed", "Implementation complete");
  const collecting = f.runtime.tick(); await hasStarted;
  await f.runtime.command({ action: "cancel", taskId: f.taskId });
  // The serving process learns of the cancel from the state file.
  await new Promise((resolve) => observedSignal.aborted ? resolve() : observedSignal.addEventListener("abort", resolve));
  const cancelled = observedSignal.aborted;
  releaseChecks(); await collecting;
  assert.equal(f.runtime.read().tasks[0].state, "cancelled");
  assert.ok(cancelled, "cancel should abort the active check sequence");
});

test("a separate runtime instance cancels checks through the shared state file", { timeout: 5000 }, async (t) => {
  const originalWatch = fs.watch, originalRename = fs.renameSync;
  const stateWatchers = new Set();
  fs.watch = (directory, listener) => {
    if (path.basename(directory) !== "relevo-workflow") return originalWatch(directory, listener);
    const watcher = { listener, close: () => stateWatchers.delete(watcher), on() { return watcher; } };
    stateWatchers.add(watcher); return watcher;
  };
  fs.renameSync = (from, to) => {
    const result = originalRename(from, to);
    if (path.basename(to) === "state.json") for (const watcher of [...stateWatchers]) watcher.listener("rename", "state.json");
    return result;
  };
  let markStarted, markAborted;
  const hasStarted = new Promise((resolve) => { markStarted = resolve; });
  const wasAborted = new Promise((resolve) => { markAborted = resolve; });
  const checksImpl = async (_root, _checks, { signal }) => {
    markStarted();
    return await new Promise((resolve) => {
      const timer = setTimeout(() => { markAborted(false); resolve([{ code: 'no-abort' }]); }, 4200);
      signal.addEventListener('abort', () => { clearTimeout(timer); markAborted(true); resolve([{ code: 'cancelled' }]); }, { once: true });
    });
  };
  let f;
  try {
    f = await fixture({ checksImpl }); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
    const otherRuntime = createRuntime({ home: f.home, runCommand: async () => ({ code: 0, stdout: "" }), fingerprintImpl: async () => "checkout-r1" });
    await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
    f.report("executor", "completed", "Implementation complete");
    const collecting = f.runtime.tick(); await hasStarted;
    await otherRuntime.command({ action: "cancel", taskId: f.taskId });
    const aborted = await wasAborted;
    await collecting;
    assert.equal(aborted, true, "the first runtime must observe cancellation written by another runtime");
    assert.equal(f.runtime.read().tasks[0].state, "cancelled");
  } finally {
    fs.watch = originalWatch; fs.renameSync = originalRename; stateWatchers.clear();
  }
});

test("the configured attempt budget caps total time across all check commands", async () => {
  let elapsed = 0;
  await runChecks("/repo", Array.from({ length: 10 }, (_, n) => ["check", String(n)]), {
    timeoutMs: 60_000,
    run: async (_argv, { timeout }) => { elapsed += timeout; return { code: 124 }; },
  });
  assert.ok(elapsed <= 60_000, `check commands consumed ${elapsed}ms despite a 60000ms total budget`);
});

test("invalid dependencies, cwd mismatch, pause and cancellation fail closed", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await assert.rejects(f.runtime.command({ action: "create", task: { goalId: "g1", title: "bad", criteria: "x", root: f.root,
    executor: { address: "exec-agent" }, reviewer: { address: "review-agent" }, dependsOn: ["missing"] } }), /Dependencies/);
  const wrongHome = path.join(f.base, "wrong"); fs.mkdirSync(wrongHome); execFileSync("git", ["init", "-q"], { cwd: wrongHome });
  // A separate runtime answers agent lookup with another checkout.
  const foreign = createRuntime({ home: f.home, clock: () => 0, fingerprintImpl: async () => "checkout-r1", checksImpl: async () => [],
    runCommand: async () => ({ code: 0, stdout: JSON.stringify({ state: "live", status: "idle", cwd: wrongHome }) }) });
  await assert.rejects(foreign.command({ action: "create", task: { goalId: "g1", title: "bad cwd", criteria: "x", root: f.root,
    executor: { address: "exec-agent" }, reviewer: { address: "review-agent" } } }), /different checkout/);
  await f.runtime.command({ action: "create", task: { goalId: "g1", title: "dependent", criteria: "x", root: f.root,
    executor: { address: "exec-agent" }, reviewer: { address: "review-agent" }, dependsOn: [f.taskId] } });
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.command({ action: "pause", taskId: f.taskId }); await f.runtime.tick();
  assert.equal(f.sends.length, 0); assert.equal(f.runtime.read().tasks[0].paused, true);
  await f.runtime.command({ action: "cancel", taskId: f.taskId });
  assert.equal(f.runtime.read().tasks[0].state, "cancelled"); assert.deepEqual(f.interrupts, []);
});

test("Refresh after a later edit keeps an accepted result accepted", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  f.report("executor", "completed", "Implemented"); await f.runtime.tick(); await f.runtime.tick();
  f.report("reviewer", "completed", "Reviewed"); await f.runtime.tick();
  await f.runtime.command({ action: "decide", taskId: f.taskId, outcome: "accept", revision: f.runtime.read().tasks[0].revision });
  f.setRevision("checkout-r2");
  await f.runtime.command({ action: "refresh", taskId: f.taskId });
  assert.equal(f.runtime.read().tasks[0].state, "accepted");
});

test("sends end options before the terminal so text starting with a dash is delivered", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  const args = f.sends[0];
  assert.equal(args[args.indexOf("--") + 1], "exec-agent");
});

test("cancelling during a send leaves the attempt reconcilable and frees the checkout after reconcile", async (t) => {
  let runtime, taskId;
  const f = await fixture({ onSend: async () => { await runtime.command({ action: "cancel", taskId }); } });
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  runtime = f.runtime; taskId = f.taskId;
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  const attempt = f.runtime.read().tasks[0].attempts.at(-1);
  assert.equal(f.runtime.read().tasks[0].state, "cancelled");
  assert.equal(attempt.delivery, "uncertain");
  await f.runtime.command({ action: "reconcile", taskId: f.taskId, attemptId: attempt.id, confirmStopped: true });
  assert.equal(f.runtime.read().tasks[0].attempts.at(-1).state, "abandoned");
});

test("a half-written report still lets the attempt time out", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  const attempt = f.runtime.read().tasks[0].attempts.at(-1);
  fs.writeFileSync(path.join(f.home, "relevo-workflow", "reports", `${attempt.id}.json`), '{"attemptId":');
  f.setNow(f.now + 11 * 60000); await f.runtime.tick();
  const task = f.runtime.read().tasks[0];
  assert.equal(task.attempts.at(-1).timedOut, true);
  assert.equal(task.state, "blocked");
});

test("failed check output is bounded in feedback and in the stored prompt", async (t) => {
  const noisy = "x".repeat(60000);
  const f = await fixture({ checksImpl: async () => Array.from({ length: 10 }, () => ({ argv: ["npm", "test"], code: 1, stdout: noisy, stderr: noisy })) });
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  f.report("executor", "completed", "Implemented"); await f.runtime.tick(); await f.runtime.tick();
  const task = f.runtime.read().tasks[0];
  assert.ok(task.feedback.length <= 8000);
  assert.ok(task.attempts.at(-1).prompt.length <= 12001);
  assert.ok(f.sends.at(-1).at(-1).includes("Checks failed"));
});

test("a busy store during a tick never stops the coordinator", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  const attempt = f.runtime.read().tasks[0].attempts.at(-1);
  fs.mkdirSync(path.join(f.home, "relevo-workflow", "reports", `${attempt.id}.json`));
  const lock = path.join(f.home, "relevo-workflow", "write.lock");
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token: "other-writer" }));
  await assert.doesNotReject(f.runtime.tick());
  fs.rmSync(lock, { recursive: true });
  await f.runtime.tick();
  assert.equal(f.runtime.read().tasks[0].state, "blocked");
});

test("create with start makes the task ready and enables automation in one write", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const created = await f.runtime.command({ action: "create", start: true, task: { goalId: "g1", title: "Started at once", criteria: "Works", root: f.root,
    executor: { address: "exec-2" }, reviewer: { address: "review-2" } } });
  const doc = f.runtime.read(), task = doc.tasks.find((item) => item.id === created.result.taskId);
  assert.equal(task.state, "ready"); assert.equal(doc.engine.enabled, true);
  await f.runtime.tick();
  assert.equal(f.sends.at(-1)[f.sends.at(-1).indexOf("--") + 1], "exec-2");
});

test("a task created in a run worktree records its branch and base", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const created = await f.runtime.command({ action: "create", task: { goalId: "g1", title: "Isolated", criteria: "Works", root: f.root,
    executor: { address: "exec-3" }, reviewer: { address: "review-3" }, worktree: { branch: "run/isolated-abc123", base: f.root } } });
  const task = f.runtime.read().tasks.find((item) => item.id === created.result.taskId);
  assert.deepEqual(task.worktree, { path: f.root, branch: "run/isolated-abc123", base: f.root });
  await assert.rejects(f.runtime.command({ action: "create", task: { goalId: "g1", title: "Bad", criteria: "c", root: f.root, executor: { address: "e" }, reviewer: { address: "r" },
    worktree: { branch: "--upload-pack=x", base: f.root } } }), /run\/ branch/);
  await assert.rejects(f.runtime.command({ action: "create", task: { goalId: "g1", title: "Bad", criteria: "c", root: f.root, executor: { address: "-x" }, reviewer: { address: "r" } } }), /different executor and reviewer/);
});

test("accepting a worktree run commits exactly the reviewed tree to its branch", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  execFileSync("git", ["-C", f.root, "checkout", "-q", "-b", "run/notes-1"]);
  const created = await f.runtime.command({ action: "create", start: true, task: { goalId: "g1", title: "Add notes", criteria: "Notes exist", root: f.root,
    executor: { address: "exec-4" }, reviewer: { address: "review-4" }, worktree: { branch: "run/notes-1", base: f.root } } });
  const id = created.result.taskId, current = () => f.runtime.read().tasks.find((item) => item.id === id);
  await f.runtime.tick();
  f.report("executor", "completed", "Done", current().attempts.at(-1)); await f.runtime.tick(); await f.runtime.tick();
  fs.writeFileSync(path.join(f.root, "NOTES.md"), "notes\n");
  f.report("reviewer", "completed", "Fine", current().attempts.at(-1)); await f.runtime.tick();
  assert.equal(current().state, "needs_you");
  assert.equal(current().worktree.reviewedRevision, current().revision, "the tree is stored with the revision it was read for");
  fs.writeFileSync(path.join(f.root, "LATE.md"), "late\n");
  await f.runtime.command({ action: "decide", taskId: id, outcome: "accept", revision: current().revision });
  assert.equal(current().state, "accepted");
  assert.match(current().worktree.commit, /^[0-9a-f]{40}$/);
  assert.equal(execFileSync("git", ["-C", f.root, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim(), "Add notes");
  const committed = execFileSync("git", ["-C", f.root, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" });
  assert.match(committed, /NOTES\.md/); assert.doesNotMatch(committed, /LATE\.md/, "an edit after review stays out");
  assert.equal(execFileSync("git", ["-C", f.root, "status", "--porcelain"], { encoding: "utf8" }), "?? LATE.md\n");
  assert.doesNotMatch(JSON.stringify(f.runtime.read()), new RegExp(f.sends[0].at(-1).match(/"token":"([^"]+)"/)[1]), "no report token in state");
});

test("a batch acceptance of worktree runs from one repo commits each run branch", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const ids = [], paths = {};
  for (const name of ["one", "two"]) {
    const wt = path.join(f.base, `wt-${name}`);
    execFileSync("git", ["-C", f.root, "worktree", "add", "-q", "-b", `run/${name}`, wt]);
    fs.writeFileSync(path.join(wt, `${name}.md`), `${name}\n`);
    const id = (await f.runtime.command({ action: "create", task: { goalId: "g1", title: `Add ${name}`, criteria: "Exists", root: f.root,
      executor: { address: `exec-${name}` }, reviewer: { address: `review-${name}` }, worktree: { branch: `run/${name}`, base: f.root } } })).result.taskId;
    ids.push(id); paths[id] = wt;
  }
  // The fake agents report the main checkout, so each task moves to its worktree here.
  transaction(f.home, (doc) => { for (const id of ids) { const task = doc.tasks.find((item) => item.id === id);
    Object.assign(task, { state: "needs_you", revision: "checkout-r1", root: paths[id] }); task.worktree.path = paths[id]; } });
  await f.runtime.command({ action: "batch", ids, outcome: "accept", preview: false, revisions: Object.fromEntries(ids.map((id) => [id, "checkout-r1"])) });
  for (const [index, name] of ["one", "two"].entries()) {
    const task = f.runtime.read().tasks.find((item) => item.id === ids[index]);
    assert.equal(task.state, "accepted");
    assert.match(task.worktree.commit, /^[0-9a-f]{40}$/);
    assert.equal(execFileSync("git", ["-C", f.root, "log", "-1", "--format=%s", `run/${name}`], { encoding: "utf8" }).trim(), `Add ${name}`);
  }
});

test("slow checks finish in the background and wake the coordinator instead of holding the tick", async (t) => {
  let releaseChecks, woke = 0;
  const checksImpl = () => new Promise((resolve) => { releaseChecks = () => resolve([{ argv: ["npm", "test"], code: 0, stdout: "", stderr: "" }]); });
  const f = await fixture({ checksImpl, wake: () => { woke++; } }); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  f.report("executor", "completed", "Implementation complete");
  await f.runtime.tick();
  assert.equal(f.runtime.read().tasks[0].state, "running", "the tick returned while checks still run");
  await f.runtime.tick();
  releaseChecks(); await new Promise((resolve) => globalThis.setImmediate(resolve));
  assert.equal(woke, 1);
  await f.runtime.tick();
  assert.deepEqual(f.runtime.read().tasks[0].attempts.map((a) => [a.role, a.state]), [["executor", "reported"], ["reviewer", "running"]], "checks passed and review was dispatched");
});

test("archive moves idle finished tasks to a monthly file and keeps what live work still needs", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const create = async (title, extra = {}) => (await f.runtime.command({ action: "create", task: { goalId: "g1", title, criteria: "Done", root: f.root,
    executor: { address: "exec-agent" }, reviewer: { address: "review-agent" }, ...extra } })).result.taskId;
  const parent = await create("Parent"), child = await create("Child", { dependsOn: [parent] });
  const run = await create("Run", { worktree: { branch: "run/kept-1", base: f.root } });
  transaction(f.home, (doc) => {
    for (const task of doc.tasks) task.state = task.id === child ? "ready" : "accepted";
  });
  f.setNow(Date.parse("2026-01-20T00:00:00Z"));
  const preview = await f.runtime.command({ action: "archive", preview: true });
  assert.deepEqual(preview.result.taskIds, [f.taskId], "the parent of live work and an existing worktree stay");
  assert.equal(f.runtime.read().tasks.length, 4, "a preview changes nothing");
  const done = await f.runtime.command({ action: "archive" });
  assert.equal(done.result.archived, 1);
  assert.deepEqual(f.runtime.read().tasks.map((task) => task.id).sort(), [parent, child, run].sort());
  assert.equal(f.runtime.read().events.some((e) => e.taskId === f.taskId), false);
  const [line] = fs.readFileSync(path.join(f.home, "relevo-workflow", "archive", "2026-01.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(line.task.id, f.taskId); assert.ok(line.events.length > 0);
  assert.equal((await f.runtime.command({ action: "archive", olderThanDays: 30 })).result.archived, 0, "younger tasks stay");
});

test("a full queue refuses new tasks with a pointer to archiving", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  transaction(f.home, (doc) => { const base = doc.tasks[0]; for (let i = 1; i < 200; i++) doc.tasks.push({ ...base, id: `filler-${i}`, state: "accepted" }); });
  await assert.rejects(f.runtime.command({ action: "create", task: { goalId: "g1", title: "One more", criteria: "c", root: f.root,
    executor: { address: "exec-agent" }, reviewer: { address: "review-agent" } } }), /archive finished ones/);
});

const agedTask = async (f, title, extra = {}) => (await f.runtime.command({ action: "create", task: { goalId: extra.goalId ?? "g1", title, criteria: "Done", root: f.root,
  executor: { address: "exec-agent" }, reviewer: { address: "review-agent" }, ...extra } })).result.taskId;

test("an open run keeps the tasks its plan and decision still read; finishing the run frees them", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const goalsFile = path.join(f.home, "relevo-goals.json");
  let linked = null;
  const writeGoals = (state) => fs.writeFileSync(goalsFile, JSON.stringify({ goals: [{ id: "g1", state, decisionLink: { taskId: linked } }, { id: "g2", state: "open" }] }));
  writeGoals("open");
  const step = await agedTask(f, "Step work"), other = await agedTask(f, "Other run", { goalId: "g2" });
  linked = await agedTask(f, "Decision work"); writeGoals("open");
  transaction(f.home, (doc) => { for (const task of doc.tasks) task.state = "accepted"; doc.tasks.find((task) => task.id === step).goalStep = { id: "s1" }; });
  f.setNow(Date.parse("2026-02-01T00:00:00Z"));
  const preview = async (extra = {}) => (await f.runtime.command({ action: "archive", preview: true, ...extra })).result.taskIds.sort();
  assert.deepEqual(await preview(), [f.taskId, other].sort(), "the step's task and the decision's task stay");
  assert.deepEqual(await preview({ goalId: "g1" }), [f.taskId], "a run archives only its own tasks");
  writeGoals("completed");
  assert.deepEqual(await preview({ goalId: "g1" }), [f.taskId, step, linked].sort());
  fs.writeFileSync(goalsFile, "{ not json");
  assert.deepEqual(await preview(), [], "an unreadable goals file archives nothing");
});

test("archiving removes the tasks' evidence and reports and leaves no pending file", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const dir = path.join(f.home, "relevo-workflow"), evidence = path.join(dir, "artifacts", f.taskId);
  fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, "shot.png"), "x");
  transaction(f.home, (doc) => { doc.tasks[0].state = "accepted"; doc.tasks[0].attempts.push({ id: "attempt-1", role: "executor", state: "reported", at: "2026-01-02T03:04:05Z" }); });
  fs.writeFileSync(path.join(dir, "reports", "attempt-1.json"), "{}");
  f.setNow(Date.parse("2026-02-01T00:00:00Z"));
  assert.equal((await f.runtime.command({ action: "archive" })).result.archived, 1);
  assert.equal(fs.existsSync(evidence), false); assert.equal(fs.existsSync(path.join(dir, "reports", "attempt-1.json")), false);
  assert.deepEqual(fs.readdirSync(path.join(dir, "archive")), ["2026-02.jsonl"]);
});

test("a cancelled run can discard its worktree with uncommitted changes; an accepted one cannot", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const ids = {};
  for (const name of ["dropped", "kept"]) {
    const wt = path.join(f.base, `wt-${name}`);
    execFileSync("git", ["-C", f.root, "worktree", "add", "-q", "-b", `run/${name}`, wt]);
    fs.writeFileSync(path.join(wt, "wip.md"), "wip\n");
    ids[name] = await agedTask(f, name, { worktree: { branch: `run/${name}`, base: f.root } });
    transaction(f.home, (doc) => { const task = doc.tasks.find((item) => item.id === ids[name]); task.root = wt; task.worktree.path = wt; task.state = name === "dropped" ? "cancelled" : "accepted"; });
  }
  await assert.rejects(f.runtime.command({ action: "worktree-remove", taskId: ids.kept }), /uncommitted changes/);
  await f.runtime.command({ action: "worktree-remove", taskId: ids.dropped });
  assert.equal(fs.existsSync(path.join(f.base, "wt-dropped")), false);
  assert.equal(f.runtime.read().tasks.find((task) => task.id === ids.dropped).worktree.removed, true);
  await assert.rejects(f.runtime.command({ action: "worktree-pr", taskId: ids.dropped }), /Only an accepted worktree run/);
});

test("stopping the engine aborts checks still running in the background", async (t) => {
  let signal;
  const checksImpl = (_root, _checks, options) => new Promise((resolve) => { signal = options.signal; signal.addEventListener("abort", () => resolve([{ code: 1 }])); });
  const f = await fixture({ checksImpl }); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  f.report("executor", "completed", "Implementation complete");
  await f.runtime.tick();
  assert.equal(signal.aborted, false);
  f.runtime.stopChecks(); await new Promise((resolve) => globalThis.setImmediate(resolve));
  assert.equal(signal.aborted, true);
  const task = f.runtime.read().tasks[0];
  assert.equal(task.attempts.at(-1).state, "running", "an aborted run is not a failed check");
  assert.equal(task.round, 1);
});

test("checks that throw block the task instead of leaving it running", async (t) => {
  const f = await fixture({ checksImpl: async () => { throw Error("check runner crashed"); } }); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  f.report("executor", "completed", "Implementation complete");
  await f.runtime.tick();
  assert.equal(f.runtime.read().tasks[0].state, "blocked");
  assert.match(f.runtime.read().tasks[0].error, /check runner crashed/);
});

test("a reported attempt keeps only the opening of its prompt", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  transaction(f.home, (doc) => { doc.tasks[0].criteria = "c".repeat(3900); });
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  assert.ok(f.runtime.read().tasks[0].attempts[0].prompt.length > 3900);
  f.report("executor", "completed", "Done"); await f.runtime.tick();
  assert.equal(f.runtime.read().tasks[0].attempts[0].prompt.length, 2001);
});

test("in a batch, one run whose commit fails does not lose the other run's commit record", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const ids = [];
  for (const name of ["good", "bad"]) {
    const wt = path.join(f.base, `wt-${name}`);
    execFileSync("git", ["-C", f.root, "worktree", "add", "-q", "-b", `run/${name}`, wt]);
    fs.writeFileSync(path.join(wt, `${name}.md`), `${name}\n`);
    const id = await agedTask(f, `Add ${name}`, { worktree: { branch: `run/${name}`, base: f.root } });
    ids.push(id);
    transaction(f.home, (doc) => { const task = doc.tasks.find((item) => item.id === id);
      Object.assign(task, { state: "needs_you", revision: "checkout-r1", root: wt }); task.worktree.path = wt;
      // A reviewed tree stored for another revision must refuse to commit.
      if (name === "bad") Object.assign(task.worktree, { reviewedTree: "0".repeat(40), reviewedRevision: "other" }); });
  }
  await f.runtime.command({ action: "batch", ids, outcome: "accept", preview: false, revisions: Object.fromEntries(ids.map((id) => [id, "checkout-r1"])) });
  const [good, bad] = ids.map((id) => f.runtime.read().tasks.find((task) => task.id === id));
  assert.match(good.worktree.commit, /^[0-9a-f]{40}$/);
  assert.equal(bad.state, "accepted"); assert.equal(bad.worktree.commit, undefined);
  assert.ok(f.runtime.read().events.some((e) => e.taskId === bad.id && e.type === "Commit failed"));
});

test("an accepted run whose commit never landed can commit the accepted revision later", async (t) => {
  let revision = "checkout-r1";
  const f = await fixture({ fingerprintImpl: async () => revision }); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const wt = path.join(f.base, "wt-late");
  execFileSync("git", ["-C", f.root, "worktree", "add", "-q", "-b", "run/late", wt]);
  fs.writeFileSync(path.join(wt, "late.md"), "late\n");
  const id = await agedTask(f, "Add late", { worktree: { branch: "run/late", base: f.root } });
  // The state an interrupted acceptance leaves: accepted and decided, with no commit recorded.
  transaction(f.home, (doc) => { const task = doc.tasks.find((item) => item.id === id);
    Object.assign(task, { state: "accepted", revision: "checkout-r1", root: wt }); task.worktree.path = wt;
    task.decisions.push({ id: "d1", outcome: "accept", text: "", revision: "checkout-r1", at: "2026-01-02T03:04:05Z" }); });
  const current = () => f.runtime.read().tasks.find((task) => task.id === id);
  revision = "checkout-r2";
  await assert.rejects(f.runtime.command({ action: "worktree-commit", taskId: id }), /changed after review/);
  assert.equal(current().worktree.commit, undefined);
  revision = "checkout-r1";
  await f.runtime.command({ action: "worktree-commit", taskId: id });
  assert.match(current().worktree.commit, /^[0-9a-f]{40}$/);
  assert.equal(execFileSync("git", ["-C", f.root, "log", "-1", "--format=%s", "run/late"], { encoding: "utf8" }).trim(), "Add late");
  await assert.rejects(f.runtime.command({ action: "worktree-commit", taskId: id }), /already committed/);
  await assert.rejects(f.runtime.command({ action: "worktree-commit", taskId: f.taskId }), /Only an accepted worktree run/);
});

const reviewWith = async (f, status, findings) => {
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  f.report("executor", "completed", "Done"); await f.runtime.tick(); await f.runtime.tick();
  f.report("reviewer", status, "Reviewed", undefined, { findings, notRun: ["npm run e2e"], notProven: ["Works offline"] });
  await f.runtime.tick();
  return f.runtime.read().tasks[0];
};

test("a review whose findings are all below the bar reaches the person with them, not the implementer", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const task = await reviewWith(f, "changes_requested", [{ level: "minor", where: "a.js:3", issue: "Name could be clearer" }]);
  assert.equal(task.state, "needs_you");
  const report = task.attempts.at(-1).report;
  assert.equal(report.status, "completed");
  assert.deepEqual(report.findings, [{ level: "minor", where: "a.js:3", issue: "Name could be clearer", fix: "" }]);
  assert.deepEqual(report.notRun, ["npm run e2e"]);
  assert.deepEqual(report.notProven, ["Works offline"]);
});

test("a blocker sends the work back even when the reviewer said completed, with the must-fix first", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const task = await reviewWith(f, "completed", [
    { level: "minor", issue: "Typo in a comment" }, { level: "blocker", where: "store.js:9", issue: "Deletes the file before the copy", fix: "Copy first" }]);
  assert.equal(task.attempts.at(-1).role, "executor"); assert.equal(task.attempts.at(-2).report.status, "changes_requested");
  assert.match(task.feedback, /^Reviewed\n\nMust fix:\n- \[blocker\] store\.js:9: Deletes the file before the copy Fix: Copy first\n\nOptional, below the bar:\n- \[minor\] Typo in a comment$/);
  assert.match(f.sends.at(-1).at(-1), /Requested corrections: Reviewed\n\nMust fix:/);
});

test("a review without findings keeps the status it gave, and findings an agent garbles are dropped", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  const task = await reviewWith(f, "changes_requested", [{ level: "blocker" }, "nonsense", null]);
  assert.equal(task.attempts.at(-1).role, "executor");
  assert.equal(task.feedback, "Reviewed");
  assert.deepEqual(task.attempts.at(-2).report.findings, []);
});

test("the status an agent writes shows while it works, only with its token, and goes with its report", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  const attempt = f.runtime.read().tasks[0].attempts[0];
  const file = path.join(f.home, "relevo-workflow", "reports", `${attempt.id}.status.json`);
  const say = (body) => fs.writeFileSync(file, JSON.stringify(body));
  say({ attemptId: attempt.id, token: "not-the-token", line: "Stolen", done: 99, left: 1 }); await f.runtime.tick();
  assert.equal(f.runtime.read().tasks[0].attempts[0].progress, undefined);
  fs.writeFileSync(file, '{"attemptId":'); await f.runtime.tick();
  assert.equal(f.runtime.read().tasks[0].state, "running");
  say({ attemptId: attempt.id, token: f.tokenFor(attempt), line: "  Fixing the two\nfailing tests ", done: 140, left: 12.4 }); await f.runtime.tick();
  const { at, ...progress } = f.runtime.read().tasks[0].attempts[0].progress;
  assert.deepEqual(progress, { line: "Fixing the two failing tests", done: 100, left: 12 });
  assert.ok(Date.parse(at));
  f.report("executor", "completed", "Done"); await f.runtime.tick();
  assert.equal(f.runtime.read().tasks[0].attempts[0].progress, undefined);
  assert.equal(fs.existsSync(file), false);
});

test("each role's prompt comes from its file, with the report and status files and no empty section", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  const sent = f.sends.at(-1).at(-1), attempt = f.runtime.read().tasks[0].attempts[0];
  assert.match(sent, new RegExp(`^Relevo task ${f.taskId}; attempt ${attempt.id}; role executor\\.`));
  assert.match(sent, /Goal: Example task\n\nExpected outcome: Expected behavior/);
  assert.ok(sent.includes(path.join(f.home, "relevo-workflow", "reports", `${attempt.id}.status.json`)));
  assert.ok(sent.includes(path.join(f.home, "relevo-workflow", "reports", `${attempt.id}.json`)));
  assert.doesNotMatch(sent, /Requested corrections|\{\{|\n\n\n/);
  assert.doesNotMatch(attempt.prompt, new RegExp(f.tokenFor(attempt)));
  f.report("executor", "completed", "Done"); await f.runtime.tick(); await f.runtime.tick();
  const review = f.sends.at(-1).at(-1);
  assert.match(review, /role reviewer\./);
  assert.match(review, /fix every finding at major or above/);
  assert.match(review, /Observed check results from the coordinator: \[\{"argv":\["npm","test"\],"code":0/);
});

test("a check that can't start blocks the run with what to fix, and sends nothing back to the implementer", async (t) => {
  const f = await fixture({ checksImpl: async () => [{ argv: ["node", "--test"], code: "ENOENT", stdout: "", stderr: "spawn node ENOENT" }] });
  t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  f.report("executor", "completed", "Done"); await f.runtime.tick(); await f.runtime.tick();
  const task = f.runtime.read().tasks[0];
  assert.equal(task.state, "blocked");
  assert.equal(task.error, 'The check "node --test" could not start (spawn node ENOENT). Fix the command, or make it findable from your login shell, then resume.');
  assert.equal(task.feedback ?? null, null);
  assert.equal(task.attempts.length, 1);
  assert.equal(f.sends.length, 1);
});

test("the reviewer is shown the change and its new files, since it has no shell", async (t) => {
  const f = await fixture(); t.after(() => fs.rmSync(f.base, { recursive: true, force: true }));
  await f.runtime.command({ action: "start", taskId: f.taskId }); await f.runtime.tick();
  fs.writeFileSync(path.join(f.root, "README.md"), "fixture\nchanged line\n");
  fs.writeFileSync(path.join(f.root, "new.js"), "export {};\n");
  f.report("executor", "completed", "Done"); await f.runtime.tick(); await f.runtime.tick();
  const review = f.sends.at(-1).at(-1);
  assert.match(review, /The change, as the coordinator read it against HEAD \(git diff\):\ndiff --git a\/README\.md b\/README\.md[\s\S]*\+changed line/);
  assert.match(review, /New files, not in the diff:\nnew\.js/);
  assert.doesNotMatch(f.sends[0].at(-1), /The change, as the coordinator/);
});
