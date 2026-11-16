// While runs are open, the Inbox asks the coordinator CLI now and then to come back if it died.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake } from "./fake/herdr.mjs";
import { fakeCx, flush } from "./fake/ui.mjs";

const { Inbox } = await import("../inbox.js");
const { needsEngine } = await import("../lib/engine.js");
beforeEach(resetFake);

const wakes = () => fake.execs.filter((l) => l.includes('"action":"wake"')).length;

test("runs still open ask for the coordinator at most once a minute; none open, or paused, never", async () => {
  const inbox = new Inbox(), cx = fakeCx();
  inbox.workflowEngine = { enabled: true };
  inbox.workflowTasks = [{ id: "a", state: "running", attempts: [{ state: "running" }] }];
  inbox.wakeEngine(cx); inbox.wakeEngine(cx); await flush();
  assert.equal(wakes(), 1);
  inbox.wokeAt = 0; inbox.workflowEngine = { enabled: false }; inbox.wakeEngine(cx); await flush();
  assert.equal(wakes(), 1, "paused");
  inbox.workflowEngine = { enabled: true }; inbox.workflowTasks = [{ id: "a", state: "accepted" }]; inbox.wakeEngine(cx); await flush();
  assert.equal(wakes(), 1, "nothing open");
});

test("work needs the coordinator while an attempt is out or work waits to start", () => {
  assert.equal(needsEngine([{ state: "running", attempts: [] }]), true);
  assert.equal(needsEngine([{ state: "blocked", attempts: [{ state: "running" }] }]), true);
  assert.equal(needsEngine([{ state: "ready", paused: true }]), false);
  assert.equal(needsEngine([{ state: "cancelled", attempts: [{ state: "running" }] }]), false);
  assert.equal(needsEngine([{ state: "planned", messages: [{ status: "queued" }] }]), true);
  assert.equal(needsEngine([]), false);
});

test("the run state is read whole past readTextFile's 1 MiB, and nothing runs when there is no state", async () => {
  const { readRunState } = await import("../runtime-cli.js");
  fake.read = () => { throw Error("over 1 MiB"); };
  fake.exec = (cmd) => (cmd === "cat" ? { code: 0, stdout: '{"tasks":[]}' } : null);
  assert.equal(await readRunState("12"), '{"tasks":[]}');
  fake.read = () => null; fake.execs = [];
  assert.equal(await readRunState(null), null);
  assert.deepEqual(fake.execs, []);
});
