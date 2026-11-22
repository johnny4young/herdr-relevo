// A machine back on the network logs in again by itself once its SSH key works; otherwise Spaces says why it waits.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake, calls } from "./fake/herdr.mjs";

const { MachineWatch, MACHINES } = await import("../machine-watch.js");
const ls = (...machines) => ({ stdout: JSON.stringify({ machines }) });
const lab = { name: "lab", state: "needs_login", target: "me@10.0.0.6", via: false };

beforeEach(() => resetFake());

test("nothing is asked while every machine is there, and what was away is cleared", async () => {
  fake.machines = [{ name: null, layout: "ready" }, { name: "lab", layout: "ready" }];
  fake.stored[MACHINES] = { lab: { state: "needs_login" } };
  await new MachineWatch().tick();
  assert.equal(calls(/^hc /).length, 0);
  assert.deepEqual(fake.stored[MACHINES], {});
});

test("a machine that needs a login is logged in when its key works, and retried only every two minutes", async () => {
  fake.machines = [{ name: "lab", layout: "unavailable" }];
  fake.exec = (cmd, args) => (cmd === "hc" && args[0] === "machine" ? ls(lab) : null);
  const watch = new MachineWatch();
  await watch.tick(1_000_000);
  assert.deepEqual(calls(/^(ssh|script) /), ["ssh -o BatchMode=yes -o ConnectTimeout=5 me@10.0.0.6 true", "script -q /dev/null hc machine login lab"]);
  assert.equal(fake.stored[MACHINES].lab.state, "connecting");
  await watch.tick(1_060_000);
  assert.equal(calls(/^ssh /).length, 1);
  await watch.tick(1_130_000);
  assert.equal(calls(/^ssh /).length, 2);
});

test("without a working key nothing is typed: it stays needs login for a person; an unreachable one only says why", async () => {
  fake.machines = [{ name: "lab", layout: "unavailable" }, { name: "box", layout: "unavailable" }];
  fake.exec = (cmd, args) => (cmd === "hc" && args[0] === "machine" ? ls(lab, { name: "box", state: "unreachable", why: "No route to host", target: "me@box" })
    : cmd === "ssh" ? { code: 255 } : null);
  await new MachineWatch().tick();
  assert.equal(calls(/^script /).length, 0);
  assert.deepEqual(fake.stored[MACHINES], { lab: { state: "needs_login", why: null }, box: { state: "unreachable", why: "No route to host" } });
  assert.equal(calls(/^ssh .*me@box/).length, 0);
});
