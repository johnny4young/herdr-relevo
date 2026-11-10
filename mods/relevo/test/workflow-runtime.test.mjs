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

async function fixture({ sendCode = 0, checkCode = 0, maxRounds = 3, checksImpl: injectedChecks, fingerprintImpl: injectedFingerprint } = {}) {
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
    if (args[0] === "send") { sends.push(args); return { code: sendCode, stdout: "", stderr: sendCode ? "offline" : "" }; }
    if (args[0] === "interrupt") { interrupts.push(args[1]); return { code: 0, stdout: "" }; }
    throw new Error(`unexpected hc ${args[0]}`);
  };
  let now = Date.parse("2026-01-02T03:04:05Z");
  let revision = "checkout-r1";
  const runtime = createRuntime({ home, runCommand, clock: () => now++, fingerprintImpl: injectedFingerprint ?? (async () => revision),
    checksImpl: injectedChecks ?? (async () => [{ argv: ["npm", "test"], code: checkCode, stdout: "", stderr: "" }]) });
  const task = { goalId: "g1", title: "Example task", criteria: "Expected behavior", root,
    executor: { address: "exec-agent", label: "Executor" }, reviewer: { address: "review-agent", label: "Reviewer" },
    checks: [["npm", "test"]], maxRounds, maxMinutes: 10 };
  const created = await runtime.command({ action: "create", task });
  const taskId = created.result.taskId;
  const report = (role, status, summary, attemptOverride) => {
    const current = runtime.read().tasks.find((t) => t.id === taskId), attempt = attemptOverride ?? current.attempts.at(-1);
    const reports = path.join(home, "relevo-workflow", "reports"); fs.mkdirSync(reports, { recursive: true });
    fs.writeFileSync(path.join(reports, `${attempt.id}.json`), JSON.stringify({ attemptId: attempt.id, token: attempt.token, status, summary }));
    return attempt;
  };
  return { base, home, root, runtime, taskId, report, sends, interrupts, setActorStatus(address, status) { actorStatuses.set(address, status); }, setRevision(value) { revision = value; }, setNow(value) { now = value; }, get now() { return now; } };
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
  assert.equal(doc.tasks.find((item) => item.id === second).state, "blocked");
  assert.match(doc.tasks.find((item) => item.id === second).error, /checkout or agent/);
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
  const cancelled = observedSignal?.aborted;
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
