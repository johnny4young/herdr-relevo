// The agents list on the fake app: pins live in the core, and old ones move there.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake } from "./fake/herdr.mjs";
import { fakeCx, find, flush, text } from "./fake/ui.mjs";

const { default: Agents, folderNote, folderOfSpace } = await import("../../relevo-agents/main.js");
const pins = () => fake.runs.filter(([name]) => name === "terminal.pin").map(([, args]) => args);

function agent(address, over = {}) {
  return { address, status: "idle", pane: `p-${address}`, tab: `tb-${address}`, title: address, space: "sp1", space_name: "app", program: { name: "claude", agent: true }, seq: 1, pinned: false, ...over };
}

async function open(list, terminals = list.map((a) => ({ address: a.address, state: "live", labels: {} }))) {
  fake.agents = list;
  fake.terminals = terminals;
  fake.panes = list.map((a) => ({ pane: a.pane, terminal: a.address, tab: a.tab, title: a.title, program: a.program }));
  fake.spaces = [{ id: "sp1", name: "app", active: true, tabs: list.map((a) => ({ id: a.tab, name: "1", named: false })) }];
  const mod = new Agents(), cx = fakeCx();
  mod.init({}, cx);
  await flush();
  return { mod, cx, ui: () => mod.render(cx) };
}

beforeEach(() => {
  resetFake();
  localStorage.removeItem("pins");
});

test("an old pin moves to the core, and is kept until the core has it", async () => {
  localStorage.setItem("pins", JSON.stringify(["t1", "t9"]));
  const { ui } = await open([agent("t1")]);
  ui();
  ui();
  assert.deepEqual(pins(), [{ terminal: "t1", pinned: true }]);
  assert.deepEqual(JSON.parse(localStorage.getItem("pins")), ["t1", "t9"]);
  fake.terminals = [{ address: "t1", state: "live", labels: { "herdr.pinned": "true" } }];
  ui();
  assert.deepEqual(JSON.parse(localStorage.getItem("pins")), ["t9"]);
});

test("a pin from any client comes first", async () => {
  const { ui } = await open([agent("t1", { title: "first", seq: 2 }), agent("t2", { title: "second", seq: 1, pinned: true })]);
  const shown = text(ui());
  assert.ok(shown.indexOf("second") < shown.indexOf("first"), shown);
});

test("an unnamed tab shows what its agent is doing", async () => {
  const { ui } = await open([agent("t1", { title: "Fixing the login" })]);
  assert.match(text(ui()), /Fixing the login/);
});

test("a named tab keeps its name", async () => {
  const a = agent("t1", { title: "Fixing the login" });
  const { ui } = await open([a]);
  fake.spaces[0].tabs = [{ id: a.tab, name: "Auth", named: true }];
  assert.match(text(ui()), /Auth/);
});

test("nothing is drawn for collapsing unless the sidebar is collapsed", async () => {
  const { ui } = await open([agent("t1")]);
  assert.equal(find(ui(), "collapse"), null);
});

test("a local agent's account chip opens the handoff, without focusing it", async () => {
  fake.stored["relevo.setup"] = { accounts: { personal: { label: "Personal", letter: "P", bg: "#000", fg: "#fff" } }, contexts: [] };
  const { ui, cx } = await open([agent("t1")], [{ address: "t1", state: "live", labels: { "agent.account": "personal" } }]);
  const chip = find(ui(), "acct-t1");
  assert.match(chip.tip, /continue with another account/);
  let stopped = false;
  chip.handlers.on_click({}, { ...cx, stop_propagation() { stopped = true; } });
  assert.deepEqual(fake.runs.at(-1), ["relevo.handoff-agent-t1", undefined]);
  assert.equal(stopped, true);
});

test("an agent on another machine has no handoff click", async () => {
  fake.stored["relevo.setup"] = { accounts: { personal: { label: "Personal", letter: "P", bg: "#000", fg: "#fff" } }, contexts: [] };
  const { ui } = await open([agent("box/t1")], [{ address: "box/t1", state: "live", labels: { "agent.account": "personal", "agent.jira": "AB-1" } }]);
  const chip = find(ui(), "acct-box/t1");
  assert.equal(chip.handlers.on_click, undefined);
  assert.doesNotMatch(chip.tip, /continue with/);
});

test("a ticket with no account has no handoff click", async () => {
  fake.stored["relevo.setup"] = { accounts: {}, contexts: [] };
  const { ui } = await open([agent("t1")], [{ address: "t1", state: "live", labels: { "agent.jira": "AB-1" } }]);
  assert.equal(find(ui(), "acct-t1").handlers.on_click, undefined);
});

test("a waiting agent's row says why; others stay one line", async () => {
  fake.stored["relevo.reasons"] = { t1: "Run: rm -rf dist", t2: "stale" };
  const { ui } = await open([agent("t1", { status: "blocked" }), agent("t2", { status: "working" })]);
  const view = ui();
  assert.equal(text(find(view, "why-t1")), "Run: rm -rf dist");
  assert.equal(find(view, "why-t2"), null);
});

test("a row says its folder only when the space's name doesn't", async () => {
  const { ui } = await open([agent("t1", { space_name: "gos", cwd: "/home/test/Personal/github" }), agent("t2", { space_name: "app", cwd: "/home/test/Personal/github/app" })]);
  const drawn = ui();
  assert.equal(text(find(drawn, "folder-t1")), "Personal/github");
  assert.equal(find(drawn, "ag-t1").tip, "/home/test/Personal/github");
  assert.equal(find(drawn, "folder-t2"), null);
  assert.equal(find(drawn, "ag-t2").tip, "/home/test/Personal/github/app");
});

test("folderNote: home, a subfolder and another machine", () => {
  assert.equal(folderNote("/home/test", "app"), "~");
  assert.equal(folderNote("/home/test/Personal", "app"), "Personal");
  assert.equal(folderNote("/home/test/github/app/mods/relevo", "app"), "mods/relevo");
  assert.equal(folderNote("/srv/app/web", "app"), "app/web");
  assert.equal(folderNote(undefined, "app"), null);
});

test("folderOfSpace follows the sidebar: dragged first, then the first rule that takes it", () => {
  const list = [{ id: "work", name: "Work", color: "ansi4", match: "api, web" }, { id: "mine", name: "Mine", color: "ansi2", match: "~" }];
  const all = { "": { list, of: { dragged: "mine", out: "" } } };
  const ps = [{ tab: "a", cwd: "/home/me/code/api" }];
  const space = (id, over = {}) => ({ id, tabs: [{ id: "a" }], ...over });
  assert.equal(folderOfSpace(space("s1"), all, ps).id, "work");
  assert.equal(folderOfSpace(space("dragged"), all, ps).id, "mine");
  assert.equal(folderOfSpace(space("out"), all, ps), null);
  assert.equal(folderOfSpace({ id: "s2", tabs: [], folder: "/home/me/notes" }, all, []).id, "mine");
  assert.equal(folderOfSpace({ id: "s3", tabs: [], folder: "/srv/notes" }, all, []), null);
  assert.equal(folderOfSpace(space("s1"), undefined, ps), null);
  assert.equal(folderOfSpace({ id: "s4", tabs: [], folder: ["", "Users", "me", "notes"].join("/") }, all, []).id, "mine");
});

test("a row shows its sidebar folder's name in the icon's tooltip", async () => {
  fake.stored = { ...fake.stored, "space-folders": { "": { list: [{ id: "mine", name: "Mine", color: "ansi2", match: "~" }], of: { sp1: "mine" } } } };
  const { ui } = await open([agent("t1")]);
  assert.equal(find(ui(), "in-folder-t1").tip, "Mine");
});
