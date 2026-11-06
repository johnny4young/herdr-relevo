// The tab bar on the fake app: going to another space leaves the side panel as it was.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake } from "./fake/herdr.mjs";
import { fakeCx } from "./fake/ui.mjs";

const { default: Tabs } = await import("../../relevo-tabs/main.js");

beforeEach(() => resetFake());

const layoutWith = (hidden) => ({ id: "root", children: [{ id: "panel", hidden, children: [{ id: "panel-body", active: "inbox", children: [] }] }] });
const space = (id, active) => ({ id, name: id, active, tabs: [{ id: `${id}-t`, name: "1", active: true }] });

test("switching spaces never shows or hides the panel", () => {
  const tabs = new Tabs(), cx = fakeCx();
  tabs.init({}, cx);
  for (const hidden of [false, true]) {
    fake.layout = layoutWith(hidden);
    fake.spaces = [space("a", true), space("b", false)];
    tabs.render(cx);
    fake.spaces = [space("a", false), space("b", true)];
    tabs.render(cx);
    fake.spaces = [space("a", true), space("b", false)];
    tabs.render(cx);
  }
  assert.deepEqual(fake.runs.filter(([name]) => name.startsWith("layout.")), []);
});
