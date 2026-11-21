// A run's agent opens on this computer, so finding it never picks another machine's tab of the same name.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake } from "./fake/herdr.mjs";

const { openAgent } = await import("../run-launch.js");

beforeEach(() => resetFake());

test("the agent a run waits for is this computer's, even when another machine has the same tab in the same folder", async () => {
  const tab = "Writer · fix-login", folder = "/w/app";
  fake.agents = [{ address: "box/t9", tab_name: tab, status: "idle" }];
  fake.terminals = [{ address: "box/t9", cwd: folder, state: "live" }];
  let ticks = 0;
  const cx = { sleep: async () => {
    if (++ticks === 2) {
      fake.agents.push({ address: "t3", tab_name: tab, status: "idle" });
      fake.terminals.push({ address: "t3", cwd: folder, state: "live" });
    }
  } };
  const found = await openAgent({ name: "app", folder, tab, argv: ["claude"], label: "Writer", ask: () => {}, cx });
  assert.equal(found.address, "t3");
  assert.equal(ticks, 2, "box/t9 was never taken for it");
});
