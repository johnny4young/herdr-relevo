// Writes and redraws that nothing changed: every shared write redraws every mod.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake } from "./fake/herdr.mjs";
import { fakeCx } from "./fake/ui.mjs";

const { LandViews, LANDING } = await import("../inbox-land.js");
const { contextOfPath } = await import("../context.js");
const { default: Agents } = await import("../../relevo-agents/main.js");

beforeEach(() => resetFake());

test("a landing poll that found the same state writes nothing", () => {
  const view = Object.create(LandViews.prototype), first = { u: { phase: "ci", running: 1 } };
  fake.stored[LANDING] = first;
  view.setLanding("u", { phase: "ci", running: 1 });
  assert.equal(fake.stored[LANDING], first);
  view.setLanding("u", { running: 0 });
  assert.equal(fake.stored[LANDING].u.running, 0);
});

test("with no landings, the landing timer neither reads GitHub nor redraws", async () => {
  const view = Object.create(LandViews.prototype), cx = fakeCx();
  await view.landTick(cx);
  assert.equal(cx.notified, 0);
  assert.equal(fake.execs.length, 0);
});

test("a path's context is worked out once until the folders' rules change", () => {
  let reads = 0;
  const real = fake.stored;
  fake.stored = new Proxy(real, { get: (o, k) => { if (k === "space-folders") reads += 1; return o[k]; } });
  contextOfPath("/w/app");
  contextOfPath("/w/app");
  const once = reads;
  contextOfPath("/w/app");
  assert.equal(reads, once + 1);
  fake.stored = real;
});

test("the agents list sends its order only when it changed", () => {
  fake.agents = [{ address: "t1", status: "idle", pane: "p1", tab: "tb1", space: "sp1", space_name: "app", program: { agent: true }, seq: 1 }];
  fake.terminals = [{ address: "t1", state: "live", labels: {} }];
  fake.panes = [{ pane: "p1", terminal: "t1", tab: "tb1", program: { agent: true } }];
  fake.spaces = [{ id: "sp1", name: "app", active: true, tabs: [{ id: "tb1", name: "1" }] }];
  const mod = new Agents(), cx = fakeCx();
  mod.init({}, cx);
  mod.render(cx);
  mod.render(cx);
  mod.render(cx);
  assert.deepEqual(fake.orders, [["t1"]]);
});

test("a repo's HEAD is read once for several agents and again when its git state changed", async () => {
  const { Inbox } = await import("../inbox.js");
  const box = Object.create(Inbox.prototype);
  box.dirty = new Set();
  fake.exec = () => ({ stdout: "abc\n" });
  await box.headOf("/w/app");
  await box.headOf("/w/app");
  assert.equal(fake.execs.filter((l) => l.includes("rev-parse HEAD")).length, 1);
  box.dirty.add("/w/app");
  await box.headOf("/w/app");
  assert.equal(fake.execs.filter((l) => l.includes("rev-parse HEAD")).length, 2);
});

test("today's agent time is worked out once until a stretch opens or closes", async () => {
  const { today } = await import("../ledger.js");
  let reads = 0;
  fake.read = () => { reads += 1; return ""; };
  await today();
  await today();
  assert.equal(reads, 1);
  fake.stored["relevo.ledger.open"] = { t1: { start: Date.now() / 1000 - 60, repo: "app" } };
  await today();
  assert.equal(reads, 2);
});
