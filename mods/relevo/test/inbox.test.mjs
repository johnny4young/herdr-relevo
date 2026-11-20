// The real Inbox on a fake app: marking cards addressed, and what makes it look at git again.
import "./fake/register.mjs";
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake, calls, changeFolder, watched, theme } from "./fake/herdr.mjs";
import { fakeCx, find, text, click, flush, spinners } from "./fake/ui.mjs";

const { Inbox } = await import("../inbox.js");
const { meTint } = await import("../ui.js");
const { LAUNCHED } = await import("../skills.js");

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
  localStorage.removeItem("since");
  fake.exec = repoOutput;
});

test("a card keeps its age when the mod reloads", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000_000 });
  setAgents(["t1", "done"]);
  const first = await open();
  const at = first.inbox.local[0].at;
  mock.timers.tick(3_600_000);
  const again = await open();
  assert.equal(again.inbox.local[0].at, at);
});

test("a card's age starts over when its agent's status changes, and a broken save is ignored", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000_000 });
  setAgents(["t1", "done"]);
  const { inbox } = await open();
  const at = inbox.local[0].at;
  mock.timers.tick(3_600_000);
  setAgents(["t1", "idle"]);
  const again = await open();
  assert.equal(again.inbox.local[0].at, at + 3600);
  localStorage.setItem("since", "{not json");
  setAgents(["t1", "done"]);
  const broken = await open();
  assert.equal(broken.inbox.local.length, 1);
});

test("a finished agent's diff is a card that can be marked addressed", async () => {
  setAgents(["t1", "done"]);
  const { ui, inbox, cx } = await open();
  const view = ui();
  assert.ok(find(view, "in-t1"));
  assert.equal(text(find(view, "leg-me")), "NEEDS ME 1");
  assert.equal(find(view, "addressed-t1"), null);
  click(find(view, "in-t1"), cx);
  assert.ok(find(ui(), "addressed-t1"));
  assert.equal(count(), 1);
  assert.equal(inbox.local.length, 1);
});

test("✓ hides the card at once, before the label comes back, and writes it", async () => {
  setAgents(["t1", "done", 7]);
  const { ui, cx, inbox } = await open();
  inbox.sel = "in-t1";
  click(find(ui(), "addressed-t1"), cx);
  await flush();
  const view = ui();
  assert.equal(find(view, "in-t1"), null);
  click(find(view, "view-maintenance"), cx);
  assert.match(text(find(ui(), "maintenance-done")), /^1 marked addressed or landed/);
  assert.equal(count(), 0);
  assert.equal(calls(/^hc label t1 relevo\.addressed=\d+:7$/).length, 1);
});

test("the fold shows the card with Undo, which removes the label", async () => {
  setAgents(["t1", "done", 7, { [LABEL]: "100:7" }]);
  const { ui, cx, inbox } = await open();
  await flush();
  cx.fire(1500);
  await flush();
  assert.equal(find(ui(), "in-t1"), null);
  fake.stored["relevo.inbox.view"] = "maintenance";
  click(find(ui(), "maintenance-done"), cx);
  assert.ok(find(ui(), "in-t1"));
  assert.equal(find(ui(), "undo-t1"), null);
  inbox.sel = "in-t1";
  const undo = find(ui(), "undo-t1");
  assert.ok(undo);
  click(undo, cx);
  await flush();
  assert.equal(calls(/^hc label t1 relevo\.addressed=$/).length, 1);
  assert.equal(find(ui(), "maintenance-done"), null);
  click(find(ui(), "view-now"), cx);
  inbox.sel = "in-t1";
  assert.ok(find(ui(), "addressed-t1"));
  assert.equal(count(), 1);
});

test("a turn ended since brings the card back and removes the label", async () => {
  setAgents(["t1", "done", 8, { [LABEL]: "100:7" }]);
  const { ui, inbox } = await open();
  inbox.sel = "in-t1";
  assert.ok(find(ui(), "addressed-t1"));
  assert.equal(calls(/^hc label t1 relevo\.addressed=$/).length, 1);
});

test("the same turn keeps the card away across a reload", async () => {
  setAgents(["t1", "idle", 7, { [LABEL]: "100:7" }]);
  const { ui } = await open();
  assert.equal(find(ui(), "in-t1"), null);
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
  const { ui, inbox } = await open();
  inbox.sel = "in-t1";
  const view = ui();
  assert.ok(find(view, "in-t1"));
  assert.ok(find(view, "go-t1"), "selected");
  assert.equal(find(view, "addressed-t1"), null);
  fake.stored["relevo.inbox.view"] = "maintenance";
  assert.equal(find(ui(), "maintenance-done"), null, "its stale mark does not count it addressed");
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
  const { ui, cx, inbox } = await open();
  inbox.sel = "in-t1";
  click(find(ui(), "addressed-t1"), cx);
  await flush();
  assert.ok(find(ui(), "addressed-t1"));
  assert.equal(fake.notices.at(-1).body, "no such terminal");
});

test("a repo's one card goes to the agent not marked addressed", async () => {
  setAgents(["t1", "done", 7, { [LABEL]: "100:7" }], ["t2", "done", 2]);
  const { ui, inbox } = await open();
  inbox.sel = "in-t2";
  const view = ui();
  assert.equal(find(view, "in-t1"), null);
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
  const before = calls(PRS).length;
  cx.fire(180000);
  await flush();
  assert.equal(calls(PRS).length, before + 1);
  assert.equal(cx.timers.some((t) => t.ms === 60000), true);
});

test("an agent that leaves the list and returns waiting shows the question on its screen, not the old one", async () => {
  let screen = " Delete the staging data?\n › 1. Yes\n   2. No\n";
  fake.exec = (cmd, args) => (cmd === "hc" && args[0] === "read" ? { stdout: screen } : repoOutput(cmd, args));
  setAgents(["t1", "blocked"]);
  const { ui, inbox, cx } = await open();
  assert.match(text(ui()), /Delete the staging data/);
  setAgents();
  inbox.scanLocal(cx);
  await flush();
  screen = " Which database?\n › 1. Postgres\n   2. SQLite\n";
  setAgents(["t1", "blocked"]);
  inbox.scanLocal(cx);
  await flush();
  const view = text(ui());
  assert.match(view, /Which database/);
  assert.doesNotMatch(view, /Delete the staging data/);
});

test("a command cut by the screen shows whole from the hook's note, timed by the core's own clock", async () => {
  const lines = ["set -e", ...Array.from({ length: 60 }, (_, i) => `echo step ${i}`), "git push --force origin main"];
  const screen = [...lines.slice(-4).map((l) => ` ${l}`), "╌".repeat(20), " Do you want to proceed?", " ❯ 1. Yes", "   2. No", ""].join("\n");
  const note = (at) => JSON.stringify({ at, terminal: "t1", tool: "Bash", input: { command: lines.join("\n"), description: "Push it" } });
  let waitedFrom = 1000, notes = note(1000.5);
  fake.exec = (cmd, args) => (cmd === "hc" && args[0] === "read" ? { stdout: screen }
    : cmd === "hc" && args[0] === "get" ? { stdout: JSON.stringify({ status_ms: waitedFrom * 1000 }) }
    : cmd === "sh" && args.at(-1) === "/home/test/.local/state/relevo/asks/t1" ? { stdout: notes } : repoOutput(cmd, args));
  setAgents(["t1", "blocked"]);
  const { ui, inbox, cx } = await open();
  let view = text(ui());
  assert.match(view, /Bash command · Push it set -e echo step 0/);
  assert.match(view, /\+54 more lines Do you want to proceed\? 1 Yes 2 No/);
  assert.doesNotMatch(view, /Can't read all of what this asks/);
  // A note from before this wait began is someone else's request.
  waitedFrom = 2000; notes = note(1000.5);
  setAgents(); inbox.scanLocal(cx); await flush();
  setAgents(["t1", "blocked"]); inbox.scanLocal(cx); await flush();
  view = text(ui());
  assert.match(view, /Can't read all of what this asks/);
});

// A waiting agent whose screen the test can change after the card was drawn.
async function waiting(first) {
  const screen = { now: first };
  fake.exec = (cmd, args) => (cmd === "hc" && args[0] === "read" ? { stdout: screen.now } : repoOutput(cmd, args));
  setAgents(["t1", "blocked"]);
  return { screen, ...await open() };
}
const DB = " Which database?\n › 1. Postgres\n   2. SQLite\n";
const DELETE = " Delete the staging data?\n › 1. Yes\n   2. No\n";
const sent = () => [...calls(/^hc keys t1/), ...calls(/^hc send/)];

test("a choice is pressed when the question is still the one the card showed", async () => {
  const { ui, cx, screen } = await waiting(DB);
  const row = find(ui(), "answer-t1-2");
  screen.now = " Which database?\n   1. Postgres\n › 2. SQLite\n";
  click(row, cx);
  await flush();
  assert.deepEqual(calls(/^hc keys t1/), ["hc keys t1 enter"]);
  assert.equal(fake.notices.filter((n) => n.title === "The question changed").length, 0);
});

test("a question that changed after the card was drawn gets no keys, and the card shows the new one", async () => {
  const { ui, cx, screen } = await waiting(DB);
  const row = find(ui(), "answer-t1-1");
  screen.now = DELETE;
  click(row, cx);
  await flush();
  assert.deepEqual(sent(), []);
  assert.equal(fake.notices.at(-1).title, "The question changed");
  assert.match(text(ui()), /Delete the staging data/);
});

test("a click compares with the card as drawn, even if a read already refreshed the question behind it", async () => {
  const { ui, inbox, cx, screen } = await waiting(DB);
  const row = find(ui(), "answer-t1-1");
  screen.now = DELETE;
  await inbox.rereadPrompt("t1");
  click(row, cx);
  await flush();
  assert.deepEqual(sent(), []);
});

test("the keyboard's choice checks against the card too", async () => {
  const { inbox, cx, screen } = await waiting(DB);
  const item = inbox.navItems(inbox.shown()).find((i) => i.id === "in-t1");
  screen.now = DELETE;
  item.choose(1, cx);
  await flush();
  assert.deepEqual(sent(), []);
});

test("a box in a multiple choice toggles after the cursor moved, and not on another question", async () => {
  const MULTI = " Pick\n › 1. [ ] A\n   2. [ ] B\n   3. [ ] Other\n   Submit\n";
  const { ui, cx, screen } = await waiting(MULTI);
  const row = find(ui(), "answer-t1-2");
  screen.now = " Pick\n   1. [x] A\n › 2. [ ] B\n   3. [ ] Other\n   Submit\n";
  click(row, cx);
  await flush();
  assert.deepEqual(calls(/^hc keys t1/), ["hc keys t1 2"]);
  fake.execs.length = 0;
  const again = find(ui(), "answer-t1-1");
  screen.now = " Another\n › 1. [ ] A\n   2. [ ] B\n   3. [ ] Other\n   Submit\n";
  click(again, cx);
  await flush();
  assert.deepEqual(sent(), []);
});

test("Submit presses nothing if the form changed", async () => {
  const MULTI = " Pick\n › 1. [x] A\n   2. [ ] B\n   Submit\n";
  const { ui, cx, screen } = await waiting(MULTI);
  const button = find(ui(), "submit-t1");
  screen.now = DELETE;
  click(button, cx);
  await flush();
  assert.deepEqual(sent(), []);
  assert.equal(fake.notices.at(-1).title, "The question changed");
});

test("a typed answer isn't sent to a question that changed while typing", async () => {
  const FREE = " Why?\n › 1. Because\n   2. Type something.\n";
  const { ui, inbox, cx, screen } = await waiting(FREE);
  click(find(ui(), "answer-t1-2"), cx);
  await flush();
  assert.equal(inbox.replying, "t1");
  inbox.reply.set_value("my words");
  screen.now = DELETE;
  inbox.sendReply(cx);
  await flush();
  assert.deepEqual(sent(), []);
  assert.equal(fake.notices.at(-1).title, "The question changed");
});

test("Reply on a card without choices sends, but not once a menu has appeared", async () => {
  const { ui, inbox, cx, screen } = await waiting("Should I also update the docs?\n");
  click(find(ui(), "reply-t1"), cx);
  inbox.reply.set_value("yes");
  screen.now = "Thinking about it.\nShould I also update the docs?\n";
  inbox.sendReply(cx);
  await flush();
  assert.deepEqual(calls(/^hc send/), ["hc send --force t1 yes"]);
  fake.execs.length = 0;
  click(find(ui(), "reply-t1"), cx);
  inbox.reply.set_value("yes");
  screen.now = DELETE;
  inbox.sendReply(cx);
  await flush();
  assert.deepEqual(sent(), []);
  assert.equal(fake.notices.at(-1).title, "The question changed");
});

test("the keyboard answers the card as drawn, even if a read refreshed it before the redraw", async () => {
  const { ui, inbox, cx, screen } = await waiting(DB);
  ui();
  const item = inbox.nav.find((i) => i.id === "in-t1");
  screen.now = DELETE;
  await inbox.rereadPrompt("t1");
  item.choose(1, cx);
  await flush();
  assert.deepEqual(sent(), []);
});

test("a new question redraws the card, even within the same minute", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000_000 });
  const { ui, inbox, cx, screen } = await waiting(DB);
  ui();
  setAgents(["t1", "working"]);
  inbox.scanLocal(cx);
  await flush();
  mock.timers.tick(1000);
  screen.now = DELETE;
  setAgents(["t1", "blocked"]);
  const redraws = cx.notified;
  inbox.scanLocal(cx);
  await flush();
  assert.ok(cx.notified > redraws);
  assert.match(text(ui()), /Delete the staging data/);
});

test("a failed read of the screen sends nothing, whatever the card", async () => {
  const noMenu = await waiting("Should I also update the docs?\n");
  click(find(noMenu.ui(), "reply-t1"), noMenu.cx);
  noMenu.inbox.reply.set_value("yes");
  fake.exec = (cmd, args) => (cmd === "hc" && args[0] === "read" ? { code: 1, stderr: "gone" } : repoOutput(cmd, args));
  noMenu.inbox.sendReply(noMenu.cx);
  await flush();
  assert.deepEqual(sent(), []);
  assert.match(fake.notices.at(-1).title, /Could not read/);
});

test("Reply stops on a screen that looks like a menu but can't be read as one", async () => {
  const { ui, inbox, cx, screen } = await waiting("Should I also update the docs?\n");
  click(find(ui(), "reply-t1"), cx);
  inbox.reply.set_value("yes");
  screen.now = " Which?\n   2. B\n › 3. C\n";
  inbox.sendReply(cx);
  await flush();
  assert.deepEqual(sent(), []);
});

// Holds the PR query until the test answers it.
function holdPRs() {
  let answer;
  const held = new Promise((resolve) => { answer = resolve; });
  fake.exec = (cmd, args) => (cmd === "gh" && args[0] === "api" ? held : repoOutput(cmd, args));
  return answer;
}

// One query per scan asks for review requests; your own PRs come in pages beside it.
const PRS = /^gh api graphql[\s\S]*review-requested/;

test("a first PR scan spins while pending and stops when gh fails", async () => {
  const answer = holdPRs();
  const { inbox, ui } = await open();
  assert.match(find(ui(), "inbox-refresh").tip, /loading/);
  assert.equal(spinners(find(ui(), "first-read")), 1);
  assert.equal(spinners(find(ui(), "inbox-refresh")), 0);
  answer({ code: 1, stderr: "offline\ndetail" });
  await flush();
  assert.match(find(ui(), "inbox-refresh").tip, /PRs unavailable/);
  assert.equal(find(ui(), "first-read"), null);
  assert.equal(spinners(find(ui(), "inbox-refresh")) + spinners(find(ui(), "inbox-list")), 0);
  assert.equal(inbox.error, "offline");
});

test("a cut answer from GitHub, read again and still cut, says so and stops the spinner", async () => {
  const answer = holdPRs();
  const { inbox, ui } = await open();
  answer({ stdout: "not json" });
  await flush();
  assert.match(find(ui(), "inbox-refresh").tip, /PRs unavailable/);
  assert.equal(spinners(find(ui(), "inbox-refresh")) + spinners(find(ui(), "inbox-list")), 0);
  assert.equal(inbox.error, "GitHub's answer was cut short");
});

test("a 502 is read again, and the second answer counts", async () => {
  const data = { data: { viewer: { login: "me", merged: { nodes: [] }, pullRequests: { nodes: [] } }, search: { nodes: [] } } };
  const tries = new Map();
  fake.exec = (cmd, args) => {
    if (cmd !== "gh" || args[0] !== "api") return repoOutput(cmd, args);
    const n = (tries.get(args[3]) ?? 0) + 1;
    tries.set(args[3], n);
    return n === 1 ? { code: 1, stderr: "gh: HTTP 502" } : { stdout: JSON.stringify(data) };
  };
  const { inbox, ui } = await open();
  await flush();
  assert.equal(inbox.error, null);
  assert.match(find(ui(), "inbox-refresh").tip, /PRs now/);
});

test("gh failing with blank stderr still shows an error", async () => {
  const answer = holdPRs();
  const { inbox } = await open();
  answer({ code: 1, stderr: "\n" });
  await flush();
  assert.equal(inbox.error, "gh failed");
});

test("refreshing an existing PR snapshot retains its age in the refresh tooltip", async () => {
  const { cx, ui } = await open();
  assert.match(find(ui(), "inbox-refresh").tip, /PRs now/);
  holdPRs();
  click(find(ui(), "inbox-refresh"), cx);
  await flush();
  assert.match(find(ui(), "inbox-refresh").tip, /PRs now/);
  assert.equal(spinners(find(ui(), "inbox-refresh")) + spinners(find(ui(), "inbox-list")), 0);
});

test("a PR scan already running is not started again", async () => {
  const answer = holdPRs();
  const { inbox, cx } = await open();
  inbox.scanPRs(cx);
  await flush();
  assert.equal(calls(PRS).length, 1);
  answer({ code: 1, stderr: "offline" });
  await flush();
  const done = calls(PRS).length;
  inbox.scanPRs(cx);
  await flush();
  assert.ok(calls(PRS).length > done);
});

test("PR data that arrived stays dated when a later step fails", async () => {
  const node = {
    url: "https://github.com/o/r/pull/1", number: 1, title: "t", isDraft: false, updatedAt: new Date().toISOString(), reviewDecision: "CHANGES_REQUESTED",
    repository: { nameWithOwner: "o/r" }, commits: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] },
  };
  fake.exec = (cmd, args) => {
    if (cmd === "git" && args.includes("get-url")) throw new Error("no git");
    if (cmd === "gh" && args[0] === "api") return { stdout: JSON.stringify({ data: { viewer: { login: "me", pullRequests: { nodes: [node] } }, search: { nodes: [] } } }) };
    return repoOutput(cmd, args);
  };
  const { inbox, ui } = await open();
  assert.match(inbox.error, /^PRs: no git/);
  assert.match(find(ui(), "inbox-refresh").tip, /PRs now/);
  assert.equal(inbox.mine.length, 1);
});

test("a second click during a send sends nothing", async () => {
  const { ui, cx } = await waiting(DB);
  const row = find(ui(), "answer-t1-1");
  click(row, cx);
  click(row, cx);
  await flush();
  assert.deepEqual(calls(/^hc keys t1/), ["hc keys t1 enter"]);
});

test("a numbered list with no cursor offers no choices and no reply", async () => {
  const { ui } = await waiting("Plan:\n1. Rebuild\n2. Test\nPress Enter to continue\n");
  assert.equal(find(ui(), "answer-t1-1"), null);
  assert.equal(find(ui(), "reply-t1"), null);
});

test("a digit held with a modifier answers nothing", async () => {
  const { inbox, ui, cx } = await waiting(DB);
  ui();
  inbox.keyboard = true;
  inbox.sel = "in-t1";
  inbox.navKey({ key: "1", modifiers: { platform: true } }, cx);
  await flush();
  assert.deepEqual(sent(), []);
});

test("quick clicks on two boxes both land, in order", async () => {
  const boxes = " Pick\n › 1. [ ] A\n   2. [ ] B\n";
  const { ui, cx } = await waiting(boxes);
  const one = find(ui(), "answer-t1-1"), two = find(ui(), "answer-t1-2");
  click(one, cx);
  click(two, cx);
  await flush();
  assert.deepEqual(calls(/^hc keys t1/), ["hc keys t1 1", "hc keys t1 2"]);
});

test("a blocked agent in a PR's tab gets a card, and a resting one doesn't", async () => {
  fake.stored[LAUNCHED] = { "https://github.com/o/r/pull/1": { tab: "r#1 review", skill: "fix" } };
  const screen = { now: DB };
  fake.exec = (cmd, args) => (cmd === "hc" && args[0] === "read" ? { stdout: screen.now } : repoOutput(cmd, args));
  setAgents(["t1", "blocked"]);
  fake.agents[0].tab_name = "r#1 review";
  const { ui, inbox, cx } = await open();
  assert.ok(find(ui(), "answer-t1-1"));
  fake.agents[0].status = "idle";
  inbox.scanLocal(cx);
  await flush();
  assert.equal(find(ui(), "answer-t1-1"), null);
});

test("Submit clicked twice on a static screen presses once", async () => {
  const boxes = " Pick\n › 1. [ ] A\n   2. [ ] B\n     Submit\n";
  const { ui, cx } = await waiting(boxes);
  const row = find(ui(), "submit-t1");
  click(row, cx);
  click(row, cx);
  await flush();
  assert.equal(calls(/^hc keys t1/).length, 1);
});

test("a click during a slow redraw can't reach the next dialog", async () => {
  const { ui, cx, screen, inbox } = await waiting(DB);
  const row = find(ui(), "answer-t1-1");
  let sleeps = 0;
  cx.sleep = async () => {
    if (++sleeps === 2) click(row, cx);
    if (sleeps === 3) screen.now = DELETE;
  };
  click(row, cx);
  await flush();
  assert.deepEqual(calls(/^hc keys t1/), ["hc keys t1 enter"]);
  assert.equal(inbox.answering.size, 0);
});

test("a typed answer in a multiple choice is checked again after its label changes", async () => {
  const before = " Pick\n   1. [ ] A\n › 2. [ ] Type something\n     Submit\n";
  const { ui, cx, screen, inbox } = await waiting(before);
  click(find(ui(), "answer-t1-2"), cx);
  await flush();
  inbox.reply.set_value("my words");
  const realExec = fake.exec;
  fake.exec = (cmd, args) => {
    if (cmd === "hc" && args[0] === "send") screen.now = " Pick\n   1. [ ] A\n › 2. [ ] my words\n     Submit\n";
    return realExec(cmd, args);
  };
  inbox.sendReply(cx);
  await flush();
  assert.deepEqual(calls(/^hc keys t1/).slice(-1), ["hc keys t1 up 2"]);
});

test("a reply while the agent is still being answered keeps its text", async () => {
  const { inbox, cx } = await waiting("Should I go on?\n");
  inbox.startReply({ address: "t1" }, null, cx);
  inbox.reply.set_value("yes");
  inbox.answering.set("t1", { turn: Promise.resolve(), at: Date.now() });
  inbox.sendReply(cx);
  await flush();
  assert.equal(inbox.replying, "t1");
  assert.equal(fake.notices.at(-1).title, "Still answering this agent");
  assert.deepEqual(sent(), []);
});

test("a waiting card can continue with another account", async () => {
  const { ui, cx, inbox } = await waiting(DB);
  assert.equal(find(ui(), "handoff-t1"), null);
  inbox.sel = "in-t1";
  click(find(ui(), "handoff-t1"), cx);
  assert.equal(fake.overlays.at(-1).props.role, "handoff");
  assert.equal(fake.overlays.at(-1).props.terminal, "t1");
});

test("Reply on a finished agent's card opens the quick replies for that agent", async () => {
  setAgents(["t1", "done"]);
  const { ui, cx } = await open();
  click(find(ui(), "in-t1"), cx);
  click(find(ui(), "reply-t1"), cx);
  await flush();
  assert.equal(fake.overlays.at(-1).props.role, "quick-replies");
  assert.equal(fake.overlays.at(-1).props.address, "t1");
});

test("a merged PR alerts once, and the Inbox shortcut lands on its worktree", async () => {
  let merged = false;
  const node = {
    url: "https://github.com/me/app/pull/7", number: 7, title: "x", isDraft: false, updatedAt: "2026-11-01T10:00:00Z",
    reviewDecision: null, headRefName: "feat/x", baseRefName: "main", isCrossRepository: false,
    repository: { nameWithOwner: "me/app" }, commits: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] },
  };
  fake.exec = (cmd, args) => {
    const line = args.join(" ");
    if (cmd === "gh" && args[0] === "api") {
      const viewer = { login: "me", pullRequests: { nodes: merged ? [] : [node] }, merged: { nodes: merged ? [node] : [] } };
      return { stdout: JSON.stringify({ data: { viewer, search: { nodes: [] } } }) };
    }
    if (cmd === "gh") return { stdout: JSON.stringify(merged ? [{ headRefName: "feat/x", isCrossRepository: false }] : []) };
    if (line.includes("worktree list --porcelain")) {
      return { stdout: "/r/app\tworktree /r/app\n/r/app\tworktree /wt/x\n/r/app\tbranch refs/heads/feat/x\n" };
    }
    if (line.includes("get-url")) return { stdout: "git@github.com:me/app.git\n" };
    return null;
  };
  const { inbox, cx } = await open();
  assert.equal(fake.notices.length, 0);
  merged = true;
  inbox.scanPRs(cx);
  await flush();
  const said = fake.notices.filter((n) => n.title === "Merged · app #7");
  assert.equal(said.length, 1);
  assert.match(said[0].body, /feat\/x: its worktree can go/);
  assert.deepEqual(said[0].action, { name: "relevo.panel-reviews" });
  fake.stored["relevo.inbox.focus"] = { at: 1, pane: null };
  inbox.render(cx);
  assert.equal(inbox.sel, "wt-/wt/x");
  assert.equal(fake.stored["relevo.inbox.view"], "maintenance");
  const shown = inbox.render(cx);
  assert.equal(inbox.sel, "wt-/wt/x", "the selection survives the next draw");
  assert.ok(find(shown, "wt-/wt/x"));
  inbox.scanPRs(cx);
  await flush();
  assert.equal(fake.notices.filter((n) => n.title === "Merged · app #7").length, 1);
});

test("your green PRs are READY rows, outside the count, and open from there", async () => {
  const node = (url, number) => ({
    url, number, title: `t${number}`, isDraft: false, updatedAt: "2026-11-01T10:00:00Z", reviewDecision: null,
    headRefName: `b${number}`, baseRefName: "main", isCrossRepository: false, repository: { nameWithOwner: "me/app" },
    commits: { nodes: [{ commit: { committedDate: "2026-11-01T09:00:00Z", statusCheckRollup: { state: "SUCCESS" } } }] },
    reviews: { nodes: [] }, reviewThreads: { nodes: [] },
  });
  fake.exec = (cmd, args) => (cmd === "gh" && args[0] === "api" ? { stdout: JSON.stringify({ data: {
    viewer: { login: "me", pullRequests: { nodes: [node("https://github.com/me/app/pull/1", 1), node("https://github.com/me/app/pull/2", 2)] } },
    search: { nodes: [] },
  } }) } : null);
  const { ui, cx } = await open();
  assert.equal(text(find(ui(), "leg-ready")), "READY 2");
  assert.equal(find(ui(), "leg-me"), null);
  assert.equal(text(find(ui(), "view-now")), "Now 2");
  assert.equal(count(), 0);
  click(find(ui(), "open-https://github.com/me/app/pull/1"), cx);
  await flush();
  assert.equal(calls(/^open https:\/\/github\.com\/me\/app\/pull\/1$/).length, 1);
  assert.equal(count(), 0);
});

test("back after ten minutes away, the Inbox says what finished and what waits, and ✓ clears it", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  setAgents(["t1", "working"], ["t2", "working"], ["t3", "idle"]);
  const { ui, cx } = await open();
  cx.fire(1500);
  fake.window.active = false;
  cx.fire(1500);
  await flush();
  setAgents(["t1", "done"], ["t2", "blocked"], ["t3", "idle"]);
  mock.timers.tick(11 * 60_000);
  cx.fire(1500);
  await flush();
  assert.equal(find(ui(), "away"), null, "nothing while still away");
  fake.window.active = true;
  cx.fire(1500);
  await flush();
  const view = ui();
  assert.match(text(view), /WHILE YOU WERE AWAY/);
  assert.ok(find(view, "away-done-t1"));
  assert.ok(find(view, "away-wait-t2"));
  assert.equal(find(view, "away-done-t3"), null, "an agent that never worked didn't finish anything");
  click(find(view, "away-dismiss"), cx);
  assert.equal(find(ui(), "away"), null);
});

test("a short absence shows nothing", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  setAgents(["t1", "working"]);
  const { ui, cx } = await open();
  fake.window.active = false;
  cx.fire(1500);
  setAgents(["t1", "done"]);
  mock.timers.tick(2 * 60_000);
  cx.fire(1500);
  fake.window.active = true;
  cx.fire(1500);
  await flush();
  assert.equal(find(ui(), "away"), null);
});

const PERMISSION = (...command) => [
  "─".repeat(20), " Bash command", " Clean up", "╌".repeat(20), ...command.map((c) => ` │ ${c}`), "╌".repeat(20),
  " Do you want to proceed?", " ❯ 1. Yes", "   2. No",
].join("\n");

test("a permission's card shows the command it asks about", async () => {
  const { ui } = await waiting(PERMISSION("git push --force origin main"));
  const view = text(ui());
  assert.match(view, /Bash command · Clean up/);
  assert.match(view, /git push --force origin main/);
  assert.doesNotMatch(view, /╌/);
});

test("a long command shows its first lines and says how many it left out", async () => {
  const { ui } = await waiting(PERMISSION(...Array.from({ length: 10 }, (_, i) => `step ${i + 1}`)));
  const view = text(ui());
  assert.match(view, /step 8/);
  assert.doesNotMatch(view, /step 9/);
  assert.match(view, /\+2 more lines/);
});

test("the lines left out show with a click", async () => {
  const { ui, cx } = await waiting(PERMISSION(...Array.from({ length: 10 }, (_, i) => `step ${i + 1}`)));
  click(find(ui(), "ask-t1-more"), cx);
  const view = text(ui());
  assert.match(view, /step 10/);
  assert.doesNotMatch(view, /more lines/);
});

test("the reason for each waiting agent reaches the other mods, and goes once it stops waiting", async () => {
  const { inbox, cx } = await waiting(PERMISSION("rm -rf dist"));
  assert.deepEqual(fake.stored["relevo.reasons"], { t1: "Run: rm -rf dist" });
  setAgents(["t1", "working"]);
  inbox.scanLocal(cx);
  await flush();
  assert.deepEqual(fake.stored["relevo.reasons"], {});
});

test("back from away, a waiting agent says why", async () => {
  const { ui, inbox } = await waiting(PERMISSION("rm -rf dist"));
  inbox.digest = { finished: [], waiting: ["t1"], prs: [], quota: [], seconds: 0, said: {} };
  assert.match(text(ui()), /Run: rm -rf dist/);
});

test("an unselected row shows only its main action; selected, it shows every other action and its mark", async () => {
  setAgents(["t1", "done"]);
  const { ui, cx } = await open();
  assert.ok(find(ui(), "review-t1"));
  for (const id of ["agent-t1", "diff-t1", "files-t1", "reply-t1", "addressed-t1"]) assert.equal(find(ui(), id), null, id);
  click(find(ui(), "in-t1"), cx);
  for (const id of ["review-t1", "agent-t1", "diff-t1", "files-t1", "reply-t1", "addressed-t1"]) assert.ok(find(ui(), id), id);
  assert.equal(find(ui(), "more-in-t1"), null, "no ⋯ fold");
  click(find(ui(), "in-t1"), cx);
  assert.equal(find(ui(), "reply-t1"), null);
  assert.ok(find(ui(), "review-t1"));
});

test("a selected row lists each action once, its main one at the edge, and in flight shows none until selected", () => {
  const v = new Inbox();
  const btn = (id) => ({ id, label: id, run() {} });
  const ids = (node) => [node?.key, ...(node?.items ?? []).flatMap(ids)].filter((k) => /^(a|b|x|y|mark)$/.test(k ?? ""));
  const opts = () => { const a = btn("a"); return { turn: "open", title: "c", main: a, actions: [a, btn("b"), btn("x"), btn("y")], mark: btn("mark") }; };
  assert.deepEqual(ids(v.item(theme(), "c", opts())), ["a"]);
  v.sel = "c";
  assert.deepEqual(ids(v.item(theme(), "c", opts())).sort(), ["a", "b", "mark", "x", "y"]);
  v.sel = null;
  assert.deepEqual(ids(v.item(theme(), "c", { ...opts(), turn: "flight" })), []);
});

test("a PR with failing CI is a needs-me row tinted like a waiting agent; a draft is not", async () => {
  const pr = (number, state, isDraft = false) => ({
    url: `https://github.com/me/app/pull/${number}`, number, title: "x", isDraft, updatedAt: new Date().toISOString(),
    reviewDecision: null, headRefName: `feat${number}`, baseRefName: "main", isCrossRepository: false, repository: { nameWithOwner: "me/app" },
    commits: { nodes: [{ commit: { committedDate: new Date().toISOString(), statusCheckRollup: { state } } }] },
    reviews: { nodes: [] }, reviewThreads: { nodes: [] },
  });
  fake.exec = (cmd, args) => (cmd === "gh" && args[0] === "api" ? { stdout: JSON.stringify({ data: {
    viewer: { login: "me", merged: { nodes: [] }, pullRequests: { nodes: [pr(1, "FAILURE"), pr(2, "SUCCESS", true)] } },
    search: { nodes: [] },
  } }) } : null);
  const { inbox } = await open();
  const folded = inbox.render(fakeCx());
  assert.equal(find(folded, "pr-https://github.com/me/app/pull/2"), null, "a draft waits on others, folded");
  inbox.expanded["now-open"] = true;
  const t = theme(), view = inbox.render(fakeCx());
  assert.ok(find(find(view, "inbox-list"), "leg-me"));
  const failing = find(view, "pr-https://github.com/me/app/pull/1"), draft = find(view, "pr-https://github.com/me/app/pull/2");
  assert.equal(failing.fill, null, "its disc and red words say it; only the open row is shaded");
  assert.ok(draft);
  assert.notEqual(failing.stroke, t.blocked, "no red border either");
  inbox.sel = "pr-https://github.com/me/app/pull/1";
  assert.equal(find(inbox.render(fakeCx()), inbox.sel).fill, t.selected);
});

function cancelledPR() {
  const runs = [];
  fake.exec = (cmd, args) => {
    if (cmd !== "gh") return null;
    if (args[0] === "api" && args[1] === "graphql") return { stdout: JSON.stringify({ data: {
      viewer: { login: "me", merged: { nodes: [] }, pullRequests: { nodes: [{
        url: "https://github.com/me/app/pull/1", number: 1, title: "x", isDraft: false, updatedAt: new Date().toISOString(),
        reviewDecision: null, headRefName: "feat", baseRefName: "main", isCrossRepository: false, repository: { nameWithOwner: "me/app" },
        commits: { nodes: [{ commit: { committedDate: new Date().toISOString(), statusCheckRollup: {
          state: "FAILURE", contexts: { pageInfo: { hasNextPage: false }, nodes: [{ conclusion: "SUCCESS" }, { conclusion: "CANCELLED" }] },
        } } }] },
        reviews: { nodes: [] }, reviewThreads: { nodes: [] },
      }] } },
      search: { nodes: [] },
    } }) };
    if (args[0] === "pr" && args[1] === "checks") return { code: 1, stdout: JSON.stringify([{ state: "CANCELLED", link: "https://github.com/me/app/actions/runs/42/job/1" }]) };
    if (args[0] === "run") {
      runs.push(args);
      return cancelledPR.rerun ?? null;
    }
    return null;
  };
  return runs;
}

test("a cancelled CI says so and Retry CI runs only its cancelled jobs, once", async () => {
  cancelledPR.rerun = null;
  const runs = cancelledPR();
  const { inbox } = await open();
  const url = "https://github.com/me/app/pull/1";
  inbox.sel = `pr-${url}`;
  const cx = fakeCx(), ui = inbox.render(cx);
  assert.match(text(find(ui, `ci-cancelled-${url}`)), /cancelled$/);
  assert.doesNotMatch(text(ui), /CI failing/);
  inbox.retryCI(inbox.mine[0], cx);
  inbox.retryCI(inbox.mine[0], cx);
  await flush();
  assert.deepEqual(runs, [["run", "rerun", "42", "--failed", "--repo", "me/app"]]);
  assert.equal(fake.notices.at(-1).title, "CI restarted · app #1");
  assert.ok(find(inbox.render(cx), `retry-ci-${url}`));
});

test("a retry GitHub refuses says why", async () => {
  cancelledPR.rerun = { code: 1, stderr: "run is too old\n" };
  cancelledPR();
  const { inbox } = await open();
  const cx = fakeCx();
  inbox.render(cx);
  inbox.retryCI(inbox.mine[0], cx);
  await flush();
  assert.equal(fake.notices.at(-1).title, "Could not retry CI · app #1");
  assert.equal(fake.notices.at(-1).body, "run is too old");
});

test("each agent's PR is published for the agents list, also from a worktree with another name", async () => {
  setAgents(["t1", "working"]);
  fake.panes[0].branch = "feat";
  fake.panes[0].cwd = "/work/.claude/worktrees/some-name";
  fake.exec = (cmd, args) => {
    if (cmd === "git" && args.includes("--show-toplevel")) return { stdout: "/work/.claude/worktrees/some-name\n" };
    if (cmd === "git" && args.includes("get-url")) return { stdout: "git@github.com:me/app.git\n" };
    if (cmd !== "gh" || args[0] !== "api") return null;
    return { stdout: JSON.stringify({ data: {
      viewer: { login: "me", merged: { nodes: [] }, pullRequests: { nodes: [{
        url: "https://github.com/me/app/pull/9", number: 9, title: "x", isDraft: true, updatedAt: new Date().toISOString(), additions: 4, deletions: 2,
        reviewDecision: null, headRefName: "feat", baseRefName: "main", isCrossRepository: false, repository: { nameWithOwner: "me/app" },
        commits: { nodes: [{ commit: { committedDate: new Date().toISOString(), statusCheckRollup: { state: "SUCCESS" } } }] },
        reviews: { nodes: [] }, reviewThreads: { nodes: [] },
      }] } },
      search: { nodes: [] },
    } }) };
  };
  const { ui } = await open();
  for (let i = 0; i < 12; i++) await flush();
  ui();
  assert.deepEqual(fake.stored["relevo.agentPRs"], { t1: { number: 9, url: "https://github.com/me/app/pull/9", ci: "SUCCESS", add: 4, del: 2 } });
});

test("a send stuck on an hc call that never answered stops blocking clicks after a while", async () => {
  const { ui, cx, inbox } = await waiting(DB);
  inbox.answering.set("t1", { turn: new Promise(() => {}), at: Date.now() });
  click(find(ui(), "answer-t1-1"), cx);
  await flush();
  assert.equal(calls(/^hc keys t1/).length, 0);
  inbox.answering.set("t1", { turn: new Promise(() => {}), at: Date.now() - 60000 });
  click(find(ui(), "answer-t1-1"), cx);
  await flush();
  assert.deepEqual(calls(/^hc keys t1/), ["hc keys t1 enter"]);
});

test("the card says it's answering while a send runs", async () => {
  const { ui, inbox } = await waiting(DB);
  inbox.answering.set("t1", { turn: new Promise(() => {}), at: Date.now() });
  assert.match(text(find(ui(), "in-t1")), /Answering…/);
});

test("an answer that brings another question marks it as the next one", async () => {
  const { ui, cx, screen } = await waiting(DB);
  let sleeps = 0;
  cx.sleep = async () => {
    if (++sleeps === 1) screen.now = DELETE;
  };
  click(find(ui(), "answer-t1-1"), cx);
  await flush();
  assert.match(text(find(ui(), "in-t1")), /Next question/);
});

test("a PR whose agent left a monitor running stays with that agent, not a new skill", async () => {
  const url = "https://github.com/me/app/pull/1";
  fake.stored[LAUNCHED] = { [url]: { tab: "app#1 · fix", skill: "fix", at: 1 } };
  setAgents(["t1", "idle", 3, { "agent.wait": "watch", "agent.bg": "⧗ 1 shell" }]);
  fake.agents[0].tab_name = "app#1 · fix";
  const node = {
    number: 1, title: "Fix", url, isDraft: false, updatedAt: new Date().toISOString(), reviewDecision: null, headRefName: "feat",
    repository: { nameWithOwner: "me/app" }, reviews: { nodes: [] }, reviewThreads: { nodes: [] },
    commits: { nodes: [{ commit: { committedDate: new Date().toISOString(), statusCheckRollup: { state: "FAILURE" } } }] },
  };
  fake.exec = (cmd, args) => (cmd === "gh" && args[0] === "api"
    ? { stdout: JSON.stringify({ data: { viewer: { login: "me", merged: { nodes: [] }, pullRequests: { nodes: [node] } }, search: { nodes: [] } } }) }
    : repoOutput(cmd, args));
  const { ui, inbox } = await open();
  inbox.clones["me/app"] = "/work/app";
  inbox.sel = `pr-${url}`;
  assert.ok(find(ui(), `agent-${url}`), "selected");
  const card = text(find(ui(), `pr-${url}`));
  assert.match(card, /waiting in the background · ⧗ 1 shell/);
  assert.equal(find(ui(), `skill-fix-${url}`), null);
  assert.equal(fake.stored["relevo.inbox.count"], 0);
});

test("a waiting card follows the agent to its next question without a status change", async () => {
  const { ui, cx, screen, inbox } = await waiting(DB);
  assert.ok(find(ui(), "answer-t1-1"));
  const first = text(find(ui(), "in-t1"));
  screen.now = DELETE;
  inbox.followPrompts(cx);
  await flush();
  assert.notEqual(text(find(ui(), "in-t1")), first);
  const reads = calls(/^hc read t1/).length;
  inbox.followPrompts(cx);
  await flush();
  assert.equal(calls(/^hc read t1/).length, reads);
});

test("open folds are kept for the next Inbox; a card's extra lines are not", async () => {
  const { inbox, cx, ui } = await open();
  assert.equal(find(ui(), "today-time"), null, "agent time lives in Maintenance");
  fake.stored["relevo.inbox.view"] = "maintenance";
  assert.match(text(find(ui(), "today-time")), /Agent time today/);
  inbox.expanded["more-x"] = true;
  click(find(ui(), "today-time"), cx);
  assert.deepEqual(fake.stored["relevo.inbox.folds"], { today: true });
  const next = await open();
  assert.equal(next.inbox.expanded.today, true);
  assert.equal(next.inbox.expanded["more-x"], undefined);
});

test("the keyboard goes through review requests, then your PRs, then uncommitted work", () => {
  const inbox = new Inbox(), now = new Date().toISOString();
  inbox.expanded = {};
  const ids = inbox.navItems({
    local: [{ kind: "diff", agent: { address: "t1" }, top: "/r" }], desktop: [], ready: [], worktrees: [],
    mine: [{ url: "mine", updatedAt: now, reasons: ["CI failing"] }], requested: [{ url: "theirs", updatedAt: now }],
  }).map((i) => i.id);
  assert.deepEqual(ids, ["pr-theirs", "pr-mine", "in-t1"]);
});

test("Now navigation holds recent PRs; older ones are navigated in Maintenance", () => {
  const inbox = new Inbox(), now = new Date().toISOString(), old = "2020-01-01T00:00:00Z";
  inbox.expanded = {};
  const v = {
    local: [], desktop: [], ready: [], worktrees: [],
    mine: [{ url: "m1", updatedAt: now, reasons: ["CI failing"] }, { url: "m2", updatedAt: old }],
    requested: [{ url: "r1", updatedAt: old }],
  };
  assert.deepEqual(inbox.navItems(v).map((entry) => entry.id), ["pr-m1"]);
  fake.stored["relevo.inbox.view"] = "maintenance";
  assert.deepEqual(inbox.navItems(v).map((entry) => entry.id), ["pr-r1", "pr-m2"]);
});

test("an agent whose folder is gone leaves its card out and the other agents' cards stay", async () => {
  fake.exec = (cmd, args, options) => {
    if (options?.cwd === "/gone") throw Error("cwd does not exist");
    return cmd === "hc" && args[0] === "read" ? { stdout: DB } : repoOutput(cmd, args);
  };
  fake.agents = [agent("t1", "blocked"), agent("t2", "idle")];
  fake.panes = [pane("t1"), pane("t2", "/gone")];
  fake.terminals = [term("t1"), term("t2")];
  const { ui, inbox } = await open();
  assert.equal(inbox.localError ?? null, null);
  assert.match(text(ui()), /Which database/);
});

test("a reply whose question went away lets go of the keyboard", async () => {
  const FREE = " Why?\n › 1. Because\n   2. Type something.\n";
  const { ui, inbox, cx } = await waiting(FREE);
  click(find(ui(), "answer-t1-2"), cx);
  await flush();
  assert.equal(inbox.replying, "t1");
  setAgents(["t1", "idle"]);
  inbox.scanLocal(cx);
  await flush();
  assert.equal(inbox.replying, null);
});

test("a second opinion on an agent's work opens a reviewer of another provider beside it and starts a review-only task", async () => {
  const { opinionAccount } = await import("../second-opinion.js");
  assert.deepEqual([opinionAccount("personal", {}), opinionAccount("codex", {}), opinionAccount("personal", { codex: { h5: { pct: 100 } } }), opinionAccount("personal", { codex: { h5: { pct: 100 } }, work: { h5: { pct: 100 } } })],
    ["codex", "personal", "work", null]);
  setAgents(["t1", "done", 3, { "agent.account": "personal" }]);
  const { ui, cx } = await open();
  click(find(ui(), "in-t1"), cx);
  const sent = [];
  fake.exec = (cmd, args) => {
    if (/cli\.mjs$/.test(args?.[0] ?? "")) { sent.push(JSON.parse(args.at(-1))); return { code: 0, stdout: JSON.stringify({ result: { taskId: "task-1" } }) }; }
    return repoOutput(cmd, args);
  };
  fake.agents = [...fake.agents, { ...agent("t9", "idle"), tab_name: "app · second opinion" }];
  click(find(ui(), "opinion-t1"), cx);
  for (let i = 0; i < 10; i++) await flush();
  assert.equal(fake.runs.some(([name, args]) => ["tab.new", "space.new"].includes(name) && /codex/.test(JSON.stringify(args.argv))), true, "Codex reviews Claude's work");
  const task = sent.find((p) => p.action === "create")?.task;
  assert.deepEqual([task.reviewOnly, task.root, task.executor.address, task.reviewer.address], [true, TOP, "t1", "t9"]);
  assert.equal(fake.stored["relevo.runs.launch"], null);
  assert.deepEqual(fake.notices.filter((n) => n.level === "error"), []);
});

test("a PR of yours with failing CI or open comments offers Fix with a run, which writes the prompt from GitHub and opens the run on its branch", async () => {
  const { fixPrompt, unresolvedThreads, fixable } = await import("../lib/fix-prompt.js");
  const url = "https://github.com/me/app/pull/7";
  const pr = { url, number: 7, title: "Search", headRefName: "fix/search", isDraft: false, updatedAt: new Date().toISOString(), reviewDecision: null, baseRefName: "main",
    isCrossRepository: false, repository: { nameWithOwner: "me/app" }, reviews: { nodes: [] }, reviewThreads: { nodes: [{ isResolved: false }] },
    commits: { nodes: [{ commit: { committedDate: new Date().toISOString(), statusCheckRollup: { state: "FAILURE",
      contexts: { pageInfo: { hasNextPage: false }, nodes: [{ name: "test", conclusion: "FAILURE" }, { name: "lint", conclusion: "SUCCESS" }] } } } }] } };
  const threads = { data: { repository: { pullRequest: { reviewThreads: { nodes: [
    { isResolved: false, path: "src/search.js", line: 12, comments: { nodes: [{ body: "Handle an empty query\nplease", author: { login: "ana" } }] } },
    { isResolved: true, path: "x.js", line: 1, comments: { nodes: [{ body: "done", author: { login: "bo" } }] } }] } } } } };
  assert.deepEqual(unresolvedThreads(threads), [{ path: "src/search.js", line: 12, author: "ana", body: "Handle an empty query\nplease" }]);
  const prompt = fixPrompt({ ...pr, skills: ["fix"] }, unresolvedThreads(threads));
  assert.match(prompt, /CI fails: test\. Run the same commands here/);
  assert.match(prompt, /- src\/search\.js:12 \(ana\): Handle an empty query please/);
  assert.equal(fixPrompt(pr, [], 60).length, 60);
  assert.deepEqual([fixable({ ...pr, skills: ["fix"] }, "/c"), fixable({ ...pr, skills: [], threads: 0 }, "/c"), fixable({ ...pr, skills: ["fix"], isCrossRepository: true }, "/c"), fixable({ ...pr, skills: ["fix"] }, null)],
    [true, false, false, false]);

  fake.exec = (cmd, args) => {
    if (cmd === "git" && args.includes("get-url")) return { code: 0, stdout: "git@github.com:me/app.git\n" };
    if (cmd !== "gh" || args[1] !== "graphql") return null;
    if (args.some((a) => a.includes("reviewThreads(first:50){nodes{isResolved path"))) return { code: 0, stdout: JSON.stringify(threads) };
    return { stdout: JSON.stringify({ data: { viewer: { login: "me", merged: { nodes: [] }, pullRequests: { nodes: [pr] } }, search: { nodes: [] } } }) };
  };
  const { inbox } = await open();
  inbox.sel = `pr-${url}`;
  const cx = fakeCx();
  click(find(inbox.render(cx), `fix-run-${url}`), cx);
  for (let i = 0; i < 8; i++) await flush();
  const asked = fake.runs.findLast(([name]) => name === "pane.split")?.[1].props;
  assert.equal(asked.role, "workflow");
  assert.deepEqual([asked.fixPR.url, asked.fixPR.headRef, asked.fixPR.root.endsWith("/app")], [url, "fix/search", true]);
  assert.match(asked.fixPR.prompt, /Handle an empty query/);
  const goals = JSON.parse(Object.entries(fake.files).find(([path]) => path.endsWith("relevo-goals.json"))[1]);
  assert.deepEqual([goals.goals[0].title, goals.goals[0].sources], ["Fix #7 · Search", [`pr:${url}`]]);
});

test("Review reads the checkout again, so a card whose work was committed goes", async () => {
  setAgents(["t1", "done"]);
  const { ui, cx } = await open();
  assert.ok(find(ui(), "review-t1"));
  fake.exec = (cmd, args) => (args.join(" ").includes("--shortstat") ? { stdout: "" } : repoOutput(cmd, args));
  click(find(ui(), "review-t1"), cx);
  for (let i = 0; i < 6; i++) await flush();
  assert.equal(find(ui(), "review-t1"), null);
});

test("a PR you were asked to review offers Review too, once its repo is cloned here", async () => {
  const { inbox } = await open();
  const pr = { url: "https://github.com/o/r/pull/7", number: 7, repo: "o/r", skills: [], reasons: [], updatedAt: new Date().toISOString() };
  const ids = () => [inbox.prActions(theme(), pr, true).main, ...inbox.prActions(theme(), pr, true).actions].filter(Boolean).map((a) => a.id);
  assert.equal(ids().includes(`review-pr-${pr.url}`), false, "no clone, nothing to diff");
  inbox.clones["o/r"] = "/code/r";
  assert.ok(ids().includes(`review-pr-${pr.url}`));
});
