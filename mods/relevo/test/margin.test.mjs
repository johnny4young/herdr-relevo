import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake } from "./fake/herdr.mjs";
import { marginOf, mostMargin } from "../lib/margin.js";

const { Sidebar } = await import("../sidebar.js");
const { ACCOUNTS } = await import("../accounts.js");
const q = (h5, d7) => ({ h5: h5 == null ? null : { pct: h5 }, d7: d7 == null ? null : { pct: d7 } });

test("marginOf: the fuller window decides; no data is unknown", () => {
  assert.equal(marginOf(q(20, 70)), 30);
  assert.equal(marginOf(q(90, 10)), 10);
  assert.equal(marginOf(q(null, 40)), 60);
  assert.equal(marginOf(null), null);
});

test("mostMargin: most room wins, ties keep the preference order, unknown ranks last", () => {
  assert.equal(mostMargin(["a", "b", "c"], { a: q(80, 20), b: q(10, 30), c: q(5, 60) }).key, "b");
  assert.equal(mostMargin(["a", "b"], { a: q(10, 10), b: q(10, 10) }).key, "a");
  assert.equal(mostMargin(["a", "b"], { b: q(95, 95) }).key, "b");
  assert.deepEqual(mostMargin(["a", "b"], {}), { key: "a", i: 0, margin: null });
});

beforeEach(() => resetFake());

test("the shortcut starts the account with most room in the focused folder, and says which", () => {
  const [first, second] = ACCOUNTS;
  fake.focused = { pane: "p1" };
  fake.panes = [{ pane: "p1", cwd: "/r/app" }];
  const bar = new Sidebar();
  bar.quota = { [first.key]: q(90, 40), [second.key]: q(20, 50) };
  bar.launch("best");
  const [name, args] = fake.runs.at(-1);
  assert.equal(name, "tab.new");
  assert.equal(args.folder, "/r/app");
  assert.equal(args.argv[2], second.launcher);
  assert.equal(fake.notices.at(-1).title, `Starting ${second.label}`);
  assert.equal(fake.notices.at(-1).body, "Most room left · 5h 20% · 7d 50%");
});
