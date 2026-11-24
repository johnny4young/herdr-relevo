// The agents list on the fake app: pins live in the core, and old ones move there.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { fake, resetFake } from "./fake/herdr.mjs";
import { fakeCx, find, flush, text } from "./fake/ui.mjs";

const { default: Agents, folderNote, folderOfSpace, leadPanes } = await import("../../relevo-agents/main.js");
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

test("a tab's label comes from its first agent, then focused terminal, then first terminal", () => {
  const pane = (tab, terminal, agent = false, focused = false) => ({ tab, terminal, program: { agent }, focused });
  const leads = leadPanes([
    { tab: "agent", focused: true },
    pane("agent", "shell", false, true), pane("agent", "first-agent", true), pane("agent", "second-agent", true, true),
    pane("focused", "first-shell"), pane("focused", "focused-shell", false, true),
    pane("first", "first"), pane("first", "second"),
  ]);
  assert.deepEqual([...leads].map(([tab, p]) => [tab, p.terminal]), [["agent", "first-agent"], ["focused", "focused-shell"], ["first", "first"]]);
});

for (const sort of ["priority", "grouped"]) {
  test(`a ${sort} render reads panes and terminals once, and the next one sees new titles`, async () => {
    const list = Array.from({ length: 12 }, (_, i) => agent(`t${i}`, { title: `Task ${i}`, status: "working" }));
    const { ui } = await open(list, list.map((a) => ({ address: a.address, state: "live", labels: { "agent.jira": "ABC-1" } })));
    fake.stored["agents.sort"] = sort;
    fake.reads = { panes: 0, terminals: 0 };
    assert.match(text(ui()), /Task 11/);
    assert.deepEqual(fake.reads, { panes: 1, terminals: 1 });
    fake.panes[11].title = "Updated task";
    assert.match(text(ui()), /Updated task/);
  });
}

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

test("Codex shows its chip and ticket, and never as borrowed", async () => {
  fake.stored["relevo.setup"] = { accounts: { codex: { label: "Codex", letter: "X", bg: "#000", fg: "#fff" } }, contexts: [{ key: "mine", account: "personal" }] };
  const { ui } = await open([agent("t1")], [{ address: "t1", state: "live", labels: { "agent.account": "codex", "agent.jira": "AB-1" } }]);
  const chip = find(ui(), "acct-t1");
  assert.match(text(chip), /AB-1/);
  assert.doesNotMatch(chip.tip, /borrowed/);
});

test("a cancelled CI on a row says so", async () => {
  fake.stored = { ...fake.stored, "relevo.agentPRs": { t1: { number: 24, url: "https://github.com/me/app/pull/24", ci: "CANCELLED", add: 1, del: 0 } } };
  const { ui } = await open([agent("t1", { focused: true })]);
  const tag = find(ui(), "pr-t1");
  assert.equal(text(tag), "#24 ⊘ +1 −0");
  assert.match(tag.tip, /CI cancelled · Open PR #24/);
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

test("a waiting agent's row says why, in its own line and colour; another's old reason is not shown", async () => {
  fake.stored["relevo.reasons"] = { t1: "Run: rm -rf dist", t2: "stale" };
  const { ui } = await open([agent("t1", { status: "blocked" }), agent("t2", { status: "working" })]);
  const view = ui(), why = find(view, "what-t1");
  assert.equal(text(why), "Run: rm -rf dist");
  assert.equal(text(find(view, "line-t1")), "app Run: rm -rf dist");
  assert.equal(text(find(view, "age-t1")), "<1m");
  assert.equal(text(find(view, "what-t2")), "t2");
  assert.doesNotMatch(text(find(view, "ag-t2")), /stale/);
  assert.doesNotMatch(text(view), /Needs me.*app Run/);
});

test("a row says its folder only when the space's name doesn't, selected or not", async () => {
  const list = [agent("t1", { space_name: "gos", cwd: "/home/test/code/repos", focused: true }), agent("t2", { space_name: "app", cwd: "/home/test/code/repos/app" })];
  const { ui } = await open(list);
  let drawn = ui();
  assert.equal(text(find(drawn, "folder-t1")), "code/repos");
  list[0].focused = false;
  list[1].focused = true;
  assert.equal(text(find(ui(), "folder-t1")), "code/repos");
  list[0].focused = true;
  drawn = ui();
  assert.equal(text(find(drawn, "folder-t1")), "code/repos");
  assert.equal(find(drawn, "ag-t1").tip, "/home/test/code/repos");
  assert.equal(find(drawn, "folder-t2"), null);
  assert.equal(find(drawn, "ag-t2").tip, "/home/test/code/repos/app");
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
  const { ui } = await open([agent("t1", { focused: true })]);
  assert.equal(find(ui(), "in-folder-t1").tip, "Mine");
});

test("a row shows its PR, with CI and size, and a click opens the PR without focusing the agent", async () => {
  fake.stored = { ...fake.stored, "relevo.agentPRs": { t1: { number: 24, url: "https://github.com/me/app/pull/24", ci: "FAILURE", add: 12, del: 3 } } };
  const { ui } = await open([agent("t1", { focused: true }), agent("t2")]);
  const drawn = ui(), tag = find(drawn, "pr-t1");
  assert.equal(text(tag), "#24 ✕ +12 −3");
  assert.match(tag.tip, /CI failed · Open PR #24/);
  assert.equal(find(drawn, "pr-t2"), null);
  tag.handlers.on_click({}, fakeCx());
  await flush();
  assert.ok(fake.execs.includes("open https://github.com/me/app/pull/24"));
  assert.equal(fake.runs.filter(([name]) => name === "pane.focus").length, 0);
});

test("a settled agent goes under Settled, last and shown, and its ✓ settles it", async () => {
  const { ui, mod, cx } = await open([agent("t1"), agent("t2")], [
    { address: "t1", state: "live", turn: 3, labels: { "relevo.addressed": "1:3" } },
    { address: "t2", state: "live", turn: 5, labels: {} },
  ]);
  const drawn = text(ui());
  assert.ok(drawn.indexOf("SETTLED") > drawn.indexOf("IDLE"));
  assert.ok(find(ui(), "ag-t1") && find(ui(), "ag-t2"));
  mod.hovered = "t2";
  find(ui(), "settle-t2").handlers.on_click({}, cx);
  await flush();
  assert.match(fake.execs.at(-1), /^hc label t2 relevo\.addressed=\d+:5$/);
});

test("an agent that works again is back in the list even with an old mark", async () => {
  const { ui } = await open([agent("t1", { status: "working" })], [{ address: "t1", state: "live", labels: { "relevo.addressed": "1:3" } }]);
  assert.ok(find(ui(), "ag-t1"));
  assert.equal(find(ui(), "settled"), null);
});

test("Claude Desktop sessions that work, ask or wait for review join the section of their state; settled ones don't", async () => {
  const now = Date.now() / 1000;
  fake.stored["relevo.desktop"] = [
    { id: "local_1", project: "app", title: "Fix login", state: "blocked", at: now, needs: "Pick one", said: "Two ways to fix it.\nWhich one?" },
    { id: "local_2", project: "web", title: "Done one", state: "review", at: now },
    { id: "local_3", project: "web", title: "Idle", state: "idle", at: now },
  ];
  fake.stored["relevo.desktop.settled"] = ["local_2"];
  const { ui, cx } = await open([]);
  assert.match(text(find(ui(), "sec-me")), /^NEEDS ME 1$/);
  assert.match(text(find(ui(), "dk-local_1")), /^app Pick one Desktop/);
  assert.equal(find(ui(), "dk-local_2"), null);
  assert.equal(find(ui(), "dk-local_3"), null);
  assert.equal(find(ui(), "dk-said-local_1"), null);
  find(ui(), "dk-local_1").handlers.on_click({}, cx);
  assert.match(text(find(ui(), "dk-said-local_1")), /Two ways to fix it/);
  assert.match(text(find(ui(), "dk-more-local_1")), /Fix login/);
  find(ui(), "dk-open-local_1").handlers.on_click({ }, { ...cx, stop_propagation() {} });
  await flush();
  assert.equal(fake.execs.at(-1), "open claude://code/continue?session=local_1");
  find(ui(), "dk-local_1").handlers.on_click({}, cx);
  assert.equal(find(ui(), "dk-said-local_1"), null, "a second click closes it");
});

test("Claude in a terminal outside Herdr joins the section of its state, with its app, and a click offers to show that app", async () => {
  const now = Date.now() / 1000;
  fake.stored["relevo.elsewhere"] = [
    { id: "s-1", project: "app", cwd: "/w/app", app: "Terminal", bundle: "com.apple.Terminal", state: "blocked", at: now, needs: "asks to use Bash", said: "Run the migration?" },
    { id: "s-2", project: "web", app: "iTerm", state: "idle", at: now },
  ];
  const { ui, cx } = await open([]);
  assert.match(text(find(ui(), "sec-me")), /^NEEDS ME 1$/);
  assert.match(text(find(ui(), "ew-s-1")), /^app asks to use Bash Terminal/);
  assert.equal(find(ui(), "ew-s-2"), null);
  find(ui(), "ew-s-1").handlers.on_click({}, cx);
  assert.match(text(find(ui(), "ew-said-s-1")), /Run the migration/);
  find(ui(), "ew-open-s-1").handlers.on_click({}, { ...cx, stop_propagation() {} });
  await flush();
  assert.equal(fake.execs.at(-1), "open -b com.apple.Terminal");
});

test("an agent's row says its model, context and how long its cache lasts while it rests", async () => {
  const now = Date.now() / 1000;
  fake.stored["relevo.agentContext"] = { t1: { model: "claude-opus-5-5", context: 273265, ttl: 3600, at: now - 600 } };
  const { ui } = await open([agent("t1", { focused: true })]);
  assert.match(text(find(ui(), "ctx-t1")), /^Opus 5\.5 273k · cache 50m$/);
  assert.equal(find(ui(), "ctx-t1").items[1].items[0].fill, "#accent");
  fake.stored["relevo.agentContext"].t1.at = now - 4000;
  assert.match(text(find(ui(), "ctx-t1")), /cache gone/);
});

const glance = () => {
  const now = Date.now() / 1000;
  fake.stored["relevo.agentPRs"] = { t2: { number: 43, url: "https://github.com/me/app/pull/43", ci: "PENDING", add: 5, del: 1 }, t3: { number: 40, url: "https://github.com/me/app/pull/40", ci: "SUCCESS", add: 9, del: 2 } };
  fake.stored["relevo.agentContext"] = { t2: { model: "claude-opus-5-5", context: 125000, ttl: 3600, at: now - 60 } };
  fake.stored["relevo.reasons"] = { t1: "Approve the plan" };
  return [agent("t1", { status: "blocked" }), agent("t2", { status: "working" }), agent("t3"), agent("t4", { status: "done" })];
};

test("every agent shows its PR, model and context below its first line, selected or not", async () => {
  const list = glance();
  const { ui } = await open(list);
  let drawn = ui();
  assert.deepEqual(["t1", "t2", "t3", "t4"].map((id) => text(find(drawn, `line-${id}`))), ["app Approve the plan", "app writing #43", "app finished #40 <1m", "app t4"]);
  assert.equal(find(drawn, "age-t2"), null);
  // The tab's own words give way to "writing #43" on the first line, so they go below.
  assert.equal(text(find(drawn, "more-t2")), "#43 ◌ +5 −1 Opus 5.5 125k t2");
  assert.equal(text(find(drawn, "detail-t2")), "t2");
  assert.equal(text(find(drawn, "more-t3")), "#40 ✓ +9 −2 t3");
  assert.equal(find(drawn, "ag-t2").fill, null);
  list[1].focused = true;
  drawn = ui();
  assert.equal(text(find(drawn, "more-t2")), "#43 ◌ +5 −1 Opus 5.5 125k t2");
  assert.equal(find(drawn, "ag-t2").fill, "#selected");
  assert.equal(find(drawn, "ag-t2").stroke, "#accent");
  assert.notEqual(find(drawn, "ag-t3").stroke, "#accent");
});

test("the priority view has one open section per state: Needs me, Done, Working, Idle", async () => {
  const { ui, cx } = await open([...glance(), agent("t5"), agent("t6", { pinned: true })]);
  let drawn = ui();
  assert.deepEqual(["pinned", "sec-me", "sec-done", "sec-flight", "sec-idle"].map((id) => text(find(drawn, id))),
    ["PINNED 1", "NEEDS ME 1", "DONE 1", "WORKING 1", "IDLE 2"]);
  for (const id of ["t1", "t2", "t3", "t4", "t5", "t6"]) assert.ok(find(drawn, `ag-${id}`), `${id} is shown`);
  assert.equal(find(drawn, "sec-done").items[0].ink, "#done");
  const order = (id) => text(drawn).indexOf(id);
  assert.ok(order("NEEDS ME") < order("DONE") && order("DONE") < order("WORKING") && order("WORKING") < order("IDLE"));
  assert.doesNotMatch(text(drawn), /resting|Nothing needs you/);
  find(drawn, "sec-idle").handlers.on_click({}, cx);
  assert.equal(find(ui(), "ag-t5"), null, "a section folds only when you fold it");
  fake.stored["agents.sort"] = "grouped";
  assert.equal(find(ui(), "sec-me"), null);
  assert.equal(text(find(ui(), "sp-sp1")), "app");
  assert.equal(find(ui(), "settled"), null);
});

test("the glyph says whose turn it is: a disc needs me, the spinner works, a check came back", async () => {
  const list = glance();
  const { ui } = await open(list);
  let drawn = ui();
  const glyph = (id) => find(drawn, `agent-fold-${id}`).items[0];
  assert.equal(glyph("t1").fill, "#blocked");
  assert.deepEqual(glyph("t1").box, { w: 8, h: 8 });
  assert.equal(glyph("t2").src, "mods/relevo/spinner.svg");
  assert.equal(glyph("t2").spinning, true);
  assert.equal(glyph("t3").src, "mods/relevo/icons/check.svg");
  // A result not yet seen is done: a check, its name in bold, under DONE.
  assert.equal(glyph("t4").src, "mods/relevo/icons/check.svg");
  assert.equal(text(find(drawn, "what-t4")), "t4", "its tab or title says what it was doing");
  assert.equal(find(drawn, "what-t1").ink, "#blocked");
  assert.equal(find(drawn, "what-t4").ink, "#muted");
  assert.equal(text(find(drawn, "sec-done")), "DONE 1");
  list[3].status = "idle";
  drawn = ui();
  assert.equal(find(drawn, "sec-done"), null);
  assert.equal(text(find(drawn, "sec-idle")), "IDLE 2");
});

test("a result being looked at stays under Done; a settled one goes under Settled, shown", async () => {
  const list = [agent("t1", { status: "done" }), agent("t2", { status: "done" })];
  const { ui, mod } = await open(list, [{ address: "t1", state: "live", labels: {} }, { address: "t2", state: "live", turn: 2, labels: { "relevo.addressed": "1:2" } }]);
  let drawn = ui();
  assert.equal(text(find(drawn, "sec-done")), "DONE 1");
  assert.ok(find(drawn, "settled") && find(drawn, "ag-t2"));
  assert.equal(mod.folded.size, 0);
  list[0].focused = true;
  ui();
  list[0].status = "idle";
  drawn = ui();
  assert.equal(text(find(drawn, "sec-done")), "DONE 1", "it stays while you look at it");
});

test("what waits on me carries its age, branch, PR and model below", async () => {
  const now = Date.now() / 1000;
  const list = [agent("t1", { status: "blocked" }), agent("t2", { status: "done" })];
  const { ui } = await open(list);
  fake.panes[0].branch = "feat/limits";
  fake.panes[1].branch = "main";
  fake.stored["relevo.agentPRs"] = { t2: { number: 81, url: "https://github.com/me/app/pull/81", ci: "SUCCESS", add: 64, del: 9 } };
  fake.stored["relevo.agentContext"] = { t1: { model: "claude-opus-5-5", context: 172000, ttl: 3600, at: now } };
  const drawn = ui();
  assert.equal(text(find(drawn, "more-t1")), "<1m feat/limits Opus 5.5 172k · cache 60m");
  assert.match(find(drawn, "ctx-t1").tip, /86% of its window/);
  assert.match(text(find(drawn, "more-t2")), /#81 ✓ \+64 −9/);
  assert.doesNotMatch(text(find(drawn, "more-t2")), /main/);
});

test("no row draws a narrow strip on its leading edge, selected or not", async () => {
  const list = glance();
  list[0].focused = true;
  const { ui } = await open(list);
  const strips = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    const { w, h } = node.box ?? {};
    if (node.fill && w >= 2 && w <= 6 && !(h < 10)) strips.push(node.key ?? node.kind);
    (node.items ?? []).forEach(walk);
  };
  walk(ui());
  assert.deepEqual(strips, []);
  const source = readFileSync(new URL("../../relevo-agents/main.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.border_(l|s)\(\s*[2-6]\s*\)|\.w\(\s*[2-6]\s*\)/);
});

test("the agents list draws whose turn with the same glyphs as Reviews", async () => {
  const { laneGlyph } = await import("../../relevo-agents/main.js");
  const ui = await import("../ui.js");
  const t = new Proxy({}, { get: (_x, name) => (typeof name === "string" ? `#${name}` : undefined) });
  const shape = (el) => ({ src: typeof el.src === "string" ? el.src : null, fill: el.fill, stroke: el.stroke, spinning: el.spinning === true });
  for (const turn of ["me", "flight", "ready", "open"]) assert.deepEqual(shape(laneGlyph(t, turn)), shape(ui.laneGlyph(t, turn)), turn);
});

test("a parent shows the turn of a helper that asks or works, and says so", async () => {
  const kid = (address, parent, status) => ({ address, parent, state: "live", status, labels: {} });
  const list = [agent("t1"), agent("t2"), agent("t3", { status: "working" }), agent("t4", { status: "blocked" }), agent("t5")];
  fake.stored["relevo.reasons"] = { t4: "Approve the plan" };
  const { ui, mod } = await open(list, [...list.map((a) => ({ address: a.address, state: "live", labels: {} })),
    kid("k1", "t1", "blocked"), kid("k2", "t2", "working"), kid("k3", "t3", "blocked"), kid("k4", "t4", "blocked"), kid("k5", "t5", "idle")]);
  let drawn = ui();
  const glyph = (id) => find(drawn, `agent-fold-${id}`).items[0];
  assert.deepEqual(["sec-me", "sec-flight", "sec-idle"].map((id) => text(find(drawn, id))), ["NEEDS ME 3", "WORKING 1", "IDLE 1"]);
  for (const id of ["t1", "t3", "t4"]) assert.equal(glyph(id).fill, "#blocked", id);
  assert.equal(text(find(drawn, "what-t1")), "a helper needs you");
  assert.equal(find(drawn, "what-t1").ink, "#blocked");
  assert.equal(text(find(drawn, "what-t3")), "a helper needs you");
  assert.equal(text(find(drawn, "what-t4")), "Approve the plan");
  assert.equal(glyph("t2").spinning, true);
  assert.equal(text(find(drawn, "what-t2")), "a helper is working");
  assert.equal(find(drawn, "what-t2").ink, "#muted");
  assert.equal(glyph("t5").src, "mods/relevo/icons/check.svg");
  assert.equal(text(find(drawn, "what-t5")), "t5");
  // Folded, a space says its most urgent turn, a helper's included.
  fake.stored["agents.sort"] = "grouped";
  mod.folded.add("sp-sp1");
  drawn = ui();
  assert.ok(find(drawn, "sp-sp1").items.some((item) => item?.fill === "#blocked"));
});

test("a folded space or Desktop group says a working helper or session with the spinner", async () => {
  fake.stored["agents.sort"] = "grouped";
  fake.stored["relevo.desktop"] = [{ id: "local_1", project: "app", title: "Fix login", state: "working", at: Date.now() / 1000 }];
  const { ui, mod } = await open([agent("t1")], [{ address: "t1", state: "live", labels: {} }, { address: "k1", parent: "t1", state: "live", status: "working", labels: {} }]);
  mod.folded.add("sp-sp1").add("desktop");
  let drawn = ui();
  for (const id of ["sp-sp1", "desktop"]) assert.ok(find(drawn, id).items.some((item) => item?.spinning === true), id);
  fake.stored["relevo.desktop"][0].state = "blocked";
  drawn = ui();
  assert.ok(find(drawn, "desktop").items.some((item) => item?.fill === "#blocked"));
});

test("a waiting agent says how long it has waited; a working one says no age", async () => {
  const { ui, mod } = await open([agent("t1", { status: "blocked" }), agent("t2", { status: "working" }), agent("t3")]);
  ui();
  for (const id of ["t1", "t2", "t3"]) mod.changed[id].at = Date.now() - 5 * 60000;
  const drawn = ui();
  assert.equal(text(find(drawn, "age-t1")), "5m");
  assert.equal(find(drawn, "age-t2"), null);
  assert.equal(text(find(drawn, "age-t3")), "5m");
  assert.ok(find(find(drawn, "more-t1"), "age-t1"), "what waits on me says its age on the line below");
  mod.hovered = "t3";
  assert.equal(find(ui(), "age-t3"), null, "hover actions take the age's place");
});

test("a row that waits on me keeps its first line for the reason: ticket and age go below until selected", async () => {
  fake.stored["relevo.reasons"] = { t1: "Which limiter should I use for the gateway?" };
  const list = [agent("t1", { status: "blocked" }), agent("t2")];
  const { ui, mod } = await open(list, [{ address: "t1", state: "live", labels: { "agent.jira": "ABC-142" } }, { address: "t2", state: "live", labels: { "agent.jira": "ABC-9" } }]);
  ui();
  mod.changed.t1.at = Date.now() - 4 * 60000;
  let drawn = ui();
  assert.doesNotMatch(text(find(drawn, "acct-t1") ?? {}), /ABC-142/);
  assert.match(text(find(drawn, "more-t1")), /^4m ABC-142/);
  assert.match(text(find(drawn, "acct-t2")), /ABC-9/, "an idle row keeps its ticket where it was");
  list[0].focused = true;
  drawn = ui();
  assert.match(text(find(drawn, "acct-t1")), /ABC-142/);
  assert.equal(find(drawn, "ticket-t1"), null);
});

test("a remote agent wears its machine's color, as in Spaces, and an offline one says so and offers no reply", async () => {
  fake.machines = [{ name: null, layout: "ready" }, { name: "box", layout: "ready" }, { name: "lab", layout: "unavailable" }];
  const { cx, ui } = await open([agent("t1"), agent("box/t2"), agent("lab/t3")]);
  const { machineLook } = await import("../../relevo-spaces/folders.js");
  assert.equal(find(ui(), "machine-t1"), null);
  const marks = (node) => (node?.key === "machine-box/t2" ? 1 : 0) + (node?.items ?? []).reduce((n, c) => n + marks(c), 0);
  assert.equal(marks(ui()), 1, "one machine dot per row");
  assert.equal(find(ui(), "machine-box/t2").fill, machineLook("box", fake.machines).color);
  assert.equal(find(ui(), "machine-lab/t3").fill, machineLook("lab", fake.machines).color);
  assert.notEqual(find(ui(), "machine-box/t2").fill, find(ui(), "machine-lab/t3").fill);
  assert.equal(find(ui(), "offline-box/t2"), null);
  assert.ok(find(ui(), "offline-lab/t3"));
  fake.stored["relevo.machines"] = { lab: { state: "needs_login" } };
  assert.equal(text(find(ui(), "offline-lab/t3")), "needs login");
  find(ui(), "ag-lab/t3").handlers.on_hover(true, cx);
  assert.equal(find(ui(), "reply-lab/t3"), null);
  find(ui(), "ag-box/t2").handlers.on_hover(true, cx);
  assert.ok(find(ui(), "reply-box/t2"));
});
