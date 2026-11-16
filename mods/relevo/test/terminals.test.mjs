// Terminals that are not agents: how each reads, its ports, and what Spaces and Maintenance can do with it.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake, calls } from "./fake/herdr.mjs";
import { fakeCx, find, text, click, flush } from "./fake/ui.mjs";
import { parseListening, parseProcs, portsOf, terminalRow } from "../lib/terminals.js";

const { restartTerminal } = await import("../terminals.js");
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

test("a port belongs to the terminal whose process, or a child of it, listens", () => {
  const listening = parseListening("p300\nnnode\nn*:3000\nn[::1]:3000\np999\nn127.0.0.1:5432\n");
  assert.deepEqual(listening, [{ pid: 300, port: 3000 }, { pid: 999, port: 5432 }]);
  const parents = new Map([...parseProcs("  300   210 node\n  210   100 npm\n  999     1 postgres\n")].map(([pid, p]) => [pid, p.ppid]));
  assert.deepEqual([...portsOf(rowsOf(), listening, parents)], [["t2", [3000]]]);
});

test("restart ends the command, frees its name and starts it again where it lived", async () => {
  const rows = Object.fromEntries(rowsOf().map((r) => [r.address, r]));
  await restartTerminal(rows.t4);
  assert.deepEqual(calls(/^hc /).slice(-3), ["hc kill t4", "hc rm t4", "hc run --bg --name api-server --cwd /w/api -- npm run dev"]);
  fake.runs.length = 0;
  await restartTerminal({ ...rows.t6, cwd: "/w/app" });
  assert.deepEqual(fake.runs, [["space.select", { id: "sp1" }], ["terminal.open", { argv: ["npm", "test"], folder: "/w/app", place: "tab" }]]);
  assert.equal(calls(/^hc kill t6/).length, 0, "a finished one is only removed");
});

test("the panel's tabs are Reviews and Runs; terminals live in Spaces", () => {
  fake.layout = { id: "root", children: [{ id: "panel", hidden: false, children: [{ id: "panel-body", active: "inbox", children: [] }] }] };
  const bar = new InboxButton().render();
  assert.equal(text(bar), "Reviews Runs");
  assert.equal(find(bar, "terminals-toggle"), null);
});

test("Maintenance offers the terminals to tidy, each with its action and d twice to close", async () => {
  const { Inbox } = await import("../inbox.js");
  const now = Date.now();
  fake.terminals = [
    term("f1", { state: "finished", argv: ["npm", "test"], exit_code: 1, finished_ms: now - 60e3 }),
    term("d1", { state: "finished", exit_code: 0, finished_ms: now - 600e3 }), term("d2", { state: "finished", argv: ["npm", "run", "build"], exit_code: 0, finished_ms: now - 300e3 }),
    term("b1", { argv: ["go", "run", "."], name: "api-server", pid: 500, foreground: { pid: 500, name: "go", argv: ["go"] }, labels: { where: "api / 2" }, created_ms: now - 3 * 3600e3 }),
    term("b2", { argv: ["vite"], pid: 600, foreground: { pid: 600, name: "node", argv: ["vite"] }, created_ms: now - 600e3 }),
    term("o1", { created_ms: now - 3 * DAY, labels: { where: "notes / 1" } }),
    term("ok", { created_ms: now - 600e3 }),
  ];
  fake.panes = [{ pane: "p1", terminal: "f1" }, { pane: "p2", terminal: "d1" }, { pane: "p3", terminal: "d2" }, { pane: "p4", terminal: "o1" }, { pane: "p5", terminal: "ok" }];
  fake.exec = (cmd) => (cmd === "gh" ? { stdout: JSON.stringify({ data: { viewer: { login: "me", merged: { nodes: [] }, pullRequests: { nodes: [] } }, search: { nodes: [] } } }) } : null);
  const inbox = new Inbox(), cx = fakeCx();
  inbox.init({}, cx);
  await flush();
  fake.stored["relevo.inbox.view"] = "maintenance";
  inbox.h.is_focused = () => true;
  const ui = () => inbox.render(cx), key = (k) => { inbox.navKey({ key: k }, cx); return ui(); };
  const tree = ui();
  assert.equal(text(find(tree, "leg-terms")), "TERMINALS TO TIDY 5");
  assert.match(text(find(tree, "term-f1")), /npm test · app exited 1 .*Restart/);
  assert.match(text(find(tree, "term-finished")), /2 finished zsh, npm run build .*Close 2/);
  assert.match(text(find(tree, "term-b1")), /^api-server · api no pane 3h$/, "in flight, its action waits for the selection");
  assert.equal(find(tree, "term-b2"), null, "running with no pane for less than an hour is not clutter yet");
  assert.match(text(find(tree, "term-o1")), /zsh · notes idle over a day .*Close/);
  assert.equal(find(tree, "term-ok"), null);
  inbox.sel = "term-o1";
  key("d");
  assert.equal(fake.runs.some(([n]) => n === "terminal.kill"), false, "the first d only arms");
  assert.match(text(find(ui(), "term-o1")), /Close it/);
  key("d");
  assert.deepEqual(fake.runs.at(-1), ["terminal.kill", { terminal: "o1" }]);
  inbox.sel = "term-finished";
  key("d");
  assert.deepEqual(calls(/^hc rm/), ["hc rm d1", "hc rm d2"]);
  inbox.sel = "term-b1";
  key("o");
  assert.deepEqual(fake.runs.at(-1), ["terminal.keep", { terminal: "b1", place: "tab" }]);
});

test("a tab's command runs in a shell that stays: it reads as that command, ended, and runs again in the same shell", async () => {
  const wrap = ["/bin/zsh", "-lic", "\"$@\"; exec \"$0\" -li", "zsh", "/opt/node/bin/node", "server.mjs", "4310"];
  const ran = terminalRow(term("w1", { argv: wrap, foreground: { pid: 140, name: "node", argv: ["/opt/node/bin/node", "server.mjs", "4310"] } }), { now: NOW });
  assert.deepEqual([ran.state, ran.title, ran.canRestart, ran.canStop, ran.ended], ["running", "node server.mjs 4310", true, true, false]);
  const ended = terminalRow(term("w2", { argv: [...wrap.slice(0, 4), "node", "fail.mjs"] }), { now: NOW });
  assert.deepEqual([ended.state, ended.title, ended.ended, ended.canRestart, ended.canStop], ["idle", "node fail.mjs", true, true, false]);
  const { restartTerminal } = await import("../terminals.js");
  fake.terminals = [term("w2", { argv: wrap }), term("w1", { argv: wrap, foreground: { pid: 140, name: "node" } })];
  await restartTerminal(ended);
  assert.deepEqual(calls(/^hc /), ["hc send w2 node fail.mjs"]);
  // The server ignores Ctrl-C: its shell never comes back, so nothing is typed into the server.
  await restartTerminal(ran);
  assert.deepEqual(calls(/^hc /), ["hc send w2 node fail.mjs", "hc interrupt w1"]);
  assert.match(fake.notices.at(-1).title, /did not stop/);
  fake.terminals[1].foreground.pid = 100;
  await restartTerminal({ ...ran, rerun: ["node", "it's here.mjs"] });
  assert.equal(calls(/^hc send w1/).at(-1), "hc send w1 node 'it'\\''s here.mjs'");
  const odd = terminalRow(term("w3", { argv: [...wrap.slice(0, 4), "echo", "a\u001b[201~b"] }), { now: NOW });
  assert.deepEqual([odd.rerun, odd.canRestart], [null, false], "a control character is never typed back");
});
