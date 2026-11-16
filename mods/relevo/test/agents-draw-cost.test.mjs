// The agents list reads its shared settings once per draw, and the pointer crossing rows redraws once per row.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake } from "./fake/herdr.mjs";
import { fakeCx, find, flush } from "./fake/ui.mjs";

const { default: Agents } = await import("../../relevo-agents/main.js");
beforeEach(resetFake);

const agent = (n) => ({ address: `t${n}`, status: "idle", pane: `p${n}`, tab: `tb${n}`, title: `a${n}`, space: "sp1", space_name: "app", program: { name: "claude", agent: true }, seq: n, pinned: false, cwd: `/work/app${n}` });

async function open(n) {
  const list = Array.from({ length: n }, (_, i) => agent(i + 1));
  fake.agents = list;
  fake.terminals = list.map((a) => ({ address: a.address, state: "live", labels: { "agent.account": "personal" } }));
  fake.panes = list.map((a) => ({ pane: a.pane, terminal: a.address, tab: a.tab, cwd: a.cwd, program: a.program }));
  fake.spaces = [{ id: "sp1", name: "app", active: true, tabs: list.map((a) => ({ id: a.tab, name: "1" })) }];
  fake.stored["relevo.setup"] = { accounts: { personal: { label: "Personal", letter: "P", bg: "#000", fg: "#fff" } }, contexts: [{ key: "personal", account: "personal" }] };
  const mod = new Agents(), cx = fakeCx();
  mod.init({}, cx);
  await flush();
  return { mod, cx };
}

test("a draw reads the accounts and folders once, however many agents", async () => {
  const { mod, cx } = await open(30);
  fake.sharedReads = {};
  mod.render(cx);
  assert.equal(fake.sharedReads["relevo.setup"], 1);
  assert.ok((fake.sharedReads["space-folders"] ?? 0) <= 2, `space-folders read ${fake.sharedReads["space-folders"]} times`);
});

test("moving the pointer from one row to the next redraws once", async () => {
  const { mod, cx } = await open(3);
  const drawn = mod.render(cx);
  find(drawn, "ag-t1").handlers.on_hover(true, cx);
  const before = cx.notified;
  find(drawn, "ag-t1").handlers.on_hover(false, cx);
  find(drawn, "ag-t2").handlers.on_hover(true, cx);
  cx.timers.filter((x) => x.once).forEach((x) => x.fn(cx));
  assert.equal(cx.notified - before, 1);
  assert.equal(mod.hovered, "t2");
  find(drawn, "ag-t2").handlers.on_hover(false, cx);
  cx.timers.filter((x) => x.once).forEach((x) => x.fn(cx));
  assert.equal(cx.notified - before, 2, "leaving the list redraws once it settles");
  assert.equal(mod.hovered, null);
});
