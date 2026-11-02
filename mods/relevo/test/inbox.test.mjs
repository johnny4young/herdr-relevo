// The real Inbox on a fake app: marking cards addressed, and what makes it look at git again.
import "./fake/register.mjs";
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake, calls, changeFolder, watched } from "./fake/herdr.mjs";
import { fakeCx, find, text, click, flush } from "./fake/ui.mjs";

const { Inbox } = await import("../inbox.js");

const TOP = "/work/app", GIT_DIR = "/work/app/.git";
const LABEL = "relevo.addressed";
const DIFF = /--shortstat/;

const agent = (address, status, tab = "tb1") => ({
  address, status, pane: `p-${address}`, tab, tab_name: "", space: "sp1", space_name: "app", program: { agent: true }, seq: 1,
});
const pane = (address, cwd = TOP) => ({ pane: `p-${address}`, terminal: address, cwd, branch: "main", status: "idle", program: { agent: true } });
const term = (address, turn = 3, labels = {}) => ({ address, turn, labels, state: "live", parent: null, cwd: TOP });

function setAgents(...list) {
  fake.agents = list.map(([address, status]) => agent(address, status));
  fake.panes = list.map(([address]) => pane(address));
  fake.terminals = list.map(([address, , turn, labels]) => term(address, turn, labels));
}

function repoOutput(cmd, args) {
  const line = args.join(" ");
  if (line.includes("--show-toplevel")) return { stdout: `${TOP}\n` };
  if (line.includes("--git-common-dir")) return { stdout: `${GIT_DIR}\n` };
  if (line.includes("--shortstat")) return { stdout: " 2 files changed, 5 insertions(+), 1 deletion(-)\n" };
  if (cmd === "gh") return { stdout: JSON.stringify({ data: { viewer: { login: "me", pullRequests: { nodes: [] } }, search: { nodes: [] } } }) };
  return null;
}

async function open() {
  const inbox = new Inbox(), cx = fakeCx();
  inbox.init({}, cx);
  await flush();
  return { inbox, cx, ui: () => inbox.render(cx) };
}

const count = () => fake.stored["relevo.inbox.count"];

beforeEach(() => {
  mock.timers.reset();
  resetFake();
  fake.exec = repoOutput;
});

test("a finished agent's diff is a card that can be marked addressed", async () => {
  setAgents(["t1", "done"]);
  const { ui, inbox } = await open();
  const view = ui();
  assert.ok(find(view, "in-t1"));
  assert.match(text(view), /UNCOMMITTED WORK/);
  assert.ok(find(view, "addressed-t1"));
  assert.equal(count(), 1);
  assert.equal(inbox.local.length, 1);
});

test("✓ hides the card at once, before the label comes back, and writes it", async () => {
  setAgents(["t1", "done", 7]);
  const { ui, cx } = await open();
  click(find(ui(), "addressed-t1"), cx);
  await flush();
  const view = ui();
  assert.equal(find(view, "in-t1"), null);
  assert.match(text(find(view, "addressed-local")), /1 addressed/);
  assert.equal(count(), 0);
  assert.equal(calls(/^hc label t1 relevo\.addressed=\d+:7$/).length, 1);
});

test("the fold shows the card with Undo, which removes the label", async () => {
  setAgents(["t1", "done", 7, { [LABEL]: "100:7" }]);
  const { ui, cx } = await open();
  await flush();
  cx.fire(1500);
  await flush();
  click(find(ui(), "addressed-local"), cx);
  const undo = find(ui(), "undo-t1");
  assert.ok(undo);
  click(undo, cx);
  await flush();
  assert.equal(calls(/^hc label t1 relevo\.addressed=$/).length, 1);
  assert.ok(find(ui(), "addressed-t1"));
  assert.equal(count(), 1);
});

test("a turn ended since brings the card back and removes the label", async () => {
  setAgents(["t1", "done", 8, { [LABEL]: "100:7" }]);
  const { ui } = await open();
  assert.ok(find(ui(), "addressed-t1"));
  assert.equal(calls(/^hc label t1 relevo\.addressed=$/).length, 1);
});

test("the same turn keeps the card away across a reload", async () => {
  setAgents(["t1", "idle", 7, { [LABEL]: "100:7" }]);
  const { ui } = await open();
  assert.equal(find(ui(), "addressed-t1"), null);
  assert.equal(calls(/^hc label/).length, 0);
});

test("an agent that starts working drops the mark, and a stale one is only cleared once", async () => {
  setAgents(["t1", "idle", 7, { [LABEL]: "100:7" }]);
  const { cx } = await open();
  setAgents(["t1", "working", 7, { [LABEL]: "100:7" }]);
  cx.fire(1500);
  await flush();
  cx.fire(1500);
  await flush();
  assert.equal(calls(/^hc label t1 relevo\.addressed=$/).length, 1);
});

test("a waiting agent can't be marked and stays in the list", async () => {
  setAgents(["t1", "blocked", 7, { [LABEL]: "100:7" }]);
  const { ui } = await open();
  const view = ui();
  assert.ok(find(view, "in-t1"));
  assert.equal(find(view, "addressed-t1"), null);
  assert.equal(find(view, "addressed-local"), null);
});

test("a waiting agent stays in the list even if its mark can't be removed", async () => {
  setAgents(["t1", "blocked", 7, { [LABEL]: "100:7" }]);
  const output = fake.exec;
  fake.exec = (cmd, args) => (cmd === "hc" && args[0] === "label" ? { code: 1, stderr: "busy\n" } : output(cmd, args));
  const { ui } = await open();
  assert.ok(find(ui(), "in-t1"));
});

test("a label that can't be written puts the card back and says so", async () => {
  setAgents(["t1", "done", 7]);
  const output = fake.exec;
  fake.exec = (cmd, args) => (cmd === "hc" && args[0] === "label" ? { code: 1, stderr: "no such terminal\n" } : output(cmd, args));
  const { ui, cx } = await open();
  click(find(ui(), "addressed-t1"), cx);
  await flush();
  assert.ok(find(ui(), "addressed-t1"));
  assert.equal(fake.notices.at(-1).body, "no such terminal");
});

test("a repo's one card goes to the agent not marked addressed", async () => {
  setAgents(["t1", "done", 7, { [LABEL]: "100:7" }], ["t2", "done", 2]);
  const { ui } = await open();
  const view = ui();
  assert.equal(find(view, "addressed-t1"), null);
  assert.ok(find(view, "addressed-t2"));
});

test("a change to a repo's git state reads the diff again, after it settles", async () => {
  setAgents(["t1", "done"]);
  const { cx } = await open();
  assert.deepEqual(watched(), [GIT_DIR]);
  const before = calls(DIFF).length;
  changeFolder(GIT_DIR, [`${GIT_DIR}/refs/heads/main`]);
  await flush();
  assert.equal(calls(DIFF).length, before + 1);
  assert.deepEqual(cx.slept, [2000]);
  assert.deepEqual(watched(), [GIT_DIR], "keeps watching");
});

test("new objects and locks under .git don't read anything", async () => {
  setAgents(["t1", "done"]);
  await open();
  const before = calls(DIFF).length;
  changeFolder(GIT_DIR, [`${GIT_DIR}/objects/ab/cd`, `${GIT_DIR}/index.lock`]);
  await flush();
  assert.equal(calls(DIFF).length, before);
});

test("a command ending in a shell reads that repo's diff again", async () => {
  setAgents(["t1", "done"]);
  const shell = { pane: "p-sh", terminal: "t9", cwd: `${TOP}/src`, status: null, program: { name: "npm" } };
  fake.panes = [...fake.panes, shell];
  const { cx } = await open();
  const before = calls(DIFF).length;
  fake.panes = [...fake.panes.filter((p) => p !== shell), { ...shell, program: { shell: true } }];
  cx.fire(1500);
  await flush();
  assert.equal(calls(DIFF).length, before + 1);
});

test("without events the fallback waits for the window to be in front", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  setAgents(["t1", "done"]);
  const { cx } = await open();
  const diffs = calls(DIFF).length, trees = () => calls(/^sh -c .*worktree/s).length, treesBefore = trees();

  fake.window.active = false;
  mock.timers.tick(700_000);
  cx.fire(1500);
  await flush();
  assert.equal(calls(DIFF).length, diffs, "nothing while it's behind");
  assert.equal(trees(), treesBefore);

  fake.window.active = true;
  cx.fire(1500);
  await flush();
  assert.equal(calls(DIFF).length, diffs + 1, "catches up when it's back");
  assert.equal(trees(), treesBefore + 1);

  mock.timers.tick(1_500);
  cx.fire(1500);
  await flush();
  assert.equal(calls(DIFF).length, diffs + 1, "then waits again");
});

test("an agent changing state still scans while the window is behind", async () => {
  setAgents(["t1", "working"]);
  const { cx } = await open();
  fake.window.active = false;
  const before = calls(DIFF).length;
  setAgents(["t1", "done"]);
  cx.fire(1500);
  await flush();
  assert.equal(calls(DIFF).length, before + 1);
});

test("the PR and quota timers keep running behind other apps", async () => {
  setAgents();
  const { cx } = await open();
  fake.window.active = false;
  const before = calls(/^gh api graphql/).length;
  cx.fire(180000);
  await flush();
  assert.equal(calls(/^gh api graphql/).length, before + 1);
  assert.equal(cx.timers.some((t) => t.ms === 60000), true);
});
