// The Terminals view: every terminal that is not an agent, by space, and what each one can do.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake, calls } from "./fake/herdr.mjs";
import { fakeCx, find, text, click, flush } from "./fake/ui.mjs";
import { lastLines, parseListening, parseParents, portsOf, terminalCounts, terminalGroups, terminalRow } from "../lib/terminals.js";

const { Terminals, focusTerminals, TERMINALS_FOCUS } = await import("../terminals.js");
const { InboxButton } = await import("../toolbar.js");

const NOW = 2_000_000_000_000, DAY = 86400e3;
const term = (address, over = {}) => ({ address, state: "live", argv: ["/bin/zsh", "-l"], pid: 100, foreground: { pid: 100, name: "zsh", argv: ["zsh"], cwd: "/w/app" },
  cwd: "/w/app", labels: { where: "app / 1", "herdr.space": "sp1" }, status: null, created_ms: NOW - 600e3, exit_code: null, name: null, parent: null, ...over });
const TERMS = [
  term("t1"),
  term("t2", { foreground: { pid: 210, name: "node", argv: ["npm", "run", "dev"], cwd: "/w/app" } }),
  term("t3", { status: { app: "claude-code", state: "working" } }),
  term("t4", { argv: ["npm", "run", "dev"], pid: 400, foreground: { pid: 400, name: "node", argv: ["npm", "run", "dev"] }, labels: { where: "api / 2" }, name: "api-server", cwd: "/w/api" }),
  term("t5", { state: "finished", exit_code: 1, finished_ms: NOW - 120e3 }),
  term("t6", { state: "finished", argv: ["npm", "test"], exit_code: 1, finished_ms: NOW - 60e3 }),
  term("t7", { created_ms: NOW - 2 * DAY, labels: { where: "notes / 1" }, cwd: "/w/notes" }),
];
const PANES = [{ pane: "p1", terminal: "t1", branch: "main" }, { pane: "p2", terminal: "t2", branch: "main" }, { pane: "p5", terminal: "t5" }, { pane: "p6", terminal: "t6" }, { pane: "p7", terminal: "t7" }];
const rowsOf = () => TERMS.map((k) => terminalRow(k, { agents: new Set(), panes: PANES, now: NOW })).filter(Boolean);

beforeEach(() => resetFake());

test("each terminal reads as what runs in it; agents are left out", () => {
  const rows = Object.fromEntries(rowsOf().map((r) => [r.address, r]));
  assert.equal(rows.t3, undefined, "an agent lives in the agents list");
  assert.deepEqual([rows.t1.state, rows.t1.title, rows.t1.canRestart, rows.t1.canStop], ["idle", "zsh", false, false]);
  assert.deepEqual([rows.t2.state, rows.t2.title, rows.t2.canStop, rows.t2.canRestart], ["running", "npm run dev", true, false], "a server typed into a shell can be stopped, not restarted");
  assert.deepEqual([rows.t4.state, rows.t4.title, rows.t4.background, rows.t4.canRestart, rows.t4.space], ["running", "api-server", true, true, "api"]);
  assert.equal(rows.t5.state, "done", "a shell that ended is finished, whatever its last exit code");
  assert.deepEqual([rows.t6.state, rows.t6.exit], ["failed", 1]);
  assert.equal(rows.t7.state, "old");
  assert.equal(terminalRow(term("t9", { name: "relevo-603291ddef62", argv: ["node", "cli.mjs"] }), { now: NOW }).title, "node cli.mjs", "an internal name is not a title");
});

test("groups go by space, then the background, idle over a day and finished, folded", () => {
  const groups = terminalGroups(rowsOf());
  assert.deepEqual(groups.map((g) => [g.label, g.rows.map((r) => r.address)]), [
    ["app", ["t6", "t2", "t1"]], ["In the background", ["t4"]], ["Idle over a day", ["t7"]], ["Finished", ["t5"]]]);
  assert.equal(groups.at(-1).folded, true);
  assert.deepEqual(terminalCounts(rowsOf()), { running: 2, idle: 2, failed: 1 });
});

test("a port belongs to the terminal whose process, or a child of it, listens", () => {
  const listening = parseListening("p300\nnnode\nn*:3000\nn[::1]:3000\np999\nn127.0.0.1:5432\n");
  assert.deepEqual(listening, [{ pid: 300, port: 3000 }, { pid: 999, port: 5432 }]);
  const parents = parseParents("  300   210\n  210   100\n  999     1\n");
  assert.deepEqual([...portsOf(rowsOf(), listening, parents)], [["t2", [3000]]]);
  assert.deepEqual(lastLines("\x1b[32mVITE ready\x1b[0m in 412 ms\n\n  Local: http://localhost:3000/\n\n"), ["VITE ready in 412 ms", "  Local: http://localhost:3000/"]);
});

async function open() {
  fake.terminals = TERMS.map((k) => ({ ...k, created_ms: Date.now() - (NOW - k.created_ms), finished_ms: k.finished_ms && Date.now() - (NOW - k.finished_ms) }));
  fake.panes = PANES;
  fake.layout = { id: "root", children: [{ id: "panel", hidden: false, children: [{ id: "panel-body", active: "terminals", children: [] }] }] };
  fake.exec = (cmd) => (cmd === "lsof" ? { stdout: "p300\nn*:3000\n" } : cmd === "ps" ? { stdout: "300 210\n210 100\n" } : cmd === "hc" ? { stdout: "VITE ready\n" } : null);
  const view = new Terminals(), cx = fakeCx();
  view.init({}, cx);
  view.h.is_focused = () => true;
  await flush();
  const ui = () => view.render(cx);
  ui();
  const key = (k) => { view.navKey({ key: k }, cx); return ui(); };
  return { view, cx, ui, key };
}

test("the view lists the groups with a legend, and a selected row opens with its actions and keys", async () => {
  const { ui, key } = await open();
  assert.equal(text(find(ui(), "term-legend")), "Running 2 Idle 2 Failed 1");
  assert.ok(find(ui(), "term-space-app") && find(ui(), "term-background") && find(ui(), "term-done"));
  assert.equal(find(ui(), "term-t5"), null, "finished ones are folded");
  key("j");
  const tree = key("j");
  assert.match(text(find(tree, "term-t2")), /npm run dev/);
  assert.match(text(find(tree, "term-t2")), /:3000/, "its port at the edge");
  await flush();
  assert.match(text(find(ui(), "term-t2-said-0")), /VITE ready/, "its last lines");
  assert.match(text(find(ui(), "term-t2")), /Open p Peek w Open :3000 s Stop b To background x Close/);
});

test("keys open, peek, park and open the port; x arms then closes; Esc gives the keyboard back", async () => {
  const { key, view } = await open();
  view.returnPane = "p9";
  key("j"); key("j");
  key("enter");
  assert.deepEqual(fake.runs.at(-1), ["pane.focus", { terminal: "t2" }]);
  key("p");
  assert.deepEqual(fake.runs.at(-1), ["terminal.peek", { terminal: "t2" }]);
  key("w");
  assert.equal(calls(/^open /).at(-1), "open http://localhost:3000");
  key("s");
  assert.equal(calls(/^hc interrupt/).at(-1), "hc interrupt t2");
  key("b");
  assert.deepEqual(fake.runs.at(-1), ["terminal.park", { terminal: "t2" }]);
  const armed = key("x");
  assert.match(text(find(armed, "term-t2-armed")), /Press x again/);
  assert.notDeepEqual(fake.runs.at(-1)?.[0], "terminal.kill");
  key("x");
  assert.deepEqual(fake.runs.at(-1), ["terminal.kill", { terminal: "t2" }]);
  key("escape");
  assert.deepEqual(fake.runs.at(-1), ["pane.focus", { pane: "p9" }]);
});

test("restart ends the command, frees its name and starts it again where it lived", async () => {
  const { view, cx } = await open();
  const rows = Object.fromEntries(view.rows.map((r) => [r.address, r]));
  await view.restart(rows.t4);
  assert.deepEqual(calls(/^hc /).slice(-3), ["hc kill t4", "hc rm t4", "hc run --bg --name api-server --cwd /w/api -- npm run dev"]);
  fake.runs.length = 0;
  await view.restart({ ...rows.t6, cwd: "/w/app" });
  assert.deepEqual(fake.runs, [["space.select", { id: "sp1" }], ["terminal.open", { argv: ["npm", "test"], folder: "/w/app", place: "tab" }]]);
  assert.equal(calls(/^hc kill t6/).length, 0, "a finished one is only removed");
  click(find(view.render(cx), "term-close-done"), cx);
  assert.equal(calls(/^hc rm t5/).length, 1);
});

test("the panel has a Terminals tab and ⌘⌥5 focuses it", () => {
  fake.layout = { id: "root", children: [{ id: "panel", hidden: false, children: [{ id: "panel-body", active: "inbox", children: [] }] }] };
  const bar = new InboxButton().render();
  assert.equal(text(bar), "Reviews Runs Terminals");
  click(find(bar, "terminals-toggle"), fakeCx());
  assert.deepEqual(fake.runs.at(-2), ["layout.select", { stack: "panel-body", child: "terminals" }]);
  focusTerminals();
  assert.ok(fake.stored[TERMINALS_FOCUS].at);
});
