// Reviews' two views on the real Inbox: Now by whose turn it is, Maintenance for what can wait.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake } from "./fake/herdr.mjs";
import { fakeCx, find, text, click, flush } from "./fake/ui.mjs";
import { newGoal, saveGoal, emptyGoals } from "../lib/goals.js";

const { Inbox } = await import("../inbox.js");
const { DESKTOP } = await import("../desktop.js");
const { LANDING } = await import("../inbox-land.js");
const { GOAL_MODE } = await import("../inbox-goals.js");

const VIEW = "relevo.inbox.view", NOW = new Date().toISOString(), OLD = "2020-01-01T00:00:00Z";
const url = (n) => `https://github.com/acme/app/pull/${n}`;
const pr = (n, extra = {}) => ({ url: url(n), number: n, repo: "acme/app", title: `PR ${n}`, reasons: [], skills: [], updatedAt: NOW, ...extra });
const ci = (state) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] } });
const agent = (address, status) => ({ address, status, pane: `p-${address}` });
const session = (id, state) => ({ id, title: `Session ${id}`, project: "app", cwd: "/w/app", state, at: Date.now() / 1000, needs: "Pick one" });
const landing = (n, phase, extra = {}) => ({ repo: "acme/app", number: n, title: `Land ${n}`, phase, at: Date.now() / 1000, ...extra });

beforeEach(() => {
  resetFake();
  fake.exec = (cmd) => (cmd === "gh"
    ? { stdout: JSON.stringify({ data: { viewer: { login: "me", merged: { nodes: [] }, pullRequests: { nodes: [] } }, search: { nodes: [] } } }) }
    : null);
});

async function open() {
  const inbox = new Inbox(), cx = fakeCx();
  inbox.init({}, cx);
  await flush();
  return { inbox, cx, ui: () => inbox.render(cx) };
}

// One item for each source, so each group gets several, in the order the sources are read.
function everyTurn(inbox) {
  inbox.local = [
    { kind: "blocked", top: "/work/app", repo: "app", agent: agent("t1", "blocked"), at: 1 },
    { kind: "diff", top: "/work/app", repo: "app", agent: agent("t2", "done"), files: 1, add: 1, del: 0, at: 1 },
  ];
  fake.stored[DESKTOP] = [session("d1", "blocked"), session("d2", "review")];
  fake.stored[LANDING] = { [url(90)]: landing(90, "ci", { running: 1, total: 2 }), [url(91)]: landing(91, "failed", { failed: { name: "Deploy", url: "https://x" } }) };
  inbox.goalDoc = saveGoal(emptyGoals(), newGoal("g", "Ship", []), 0);
  inbox.workflowTasks = [{ id: "k1", goalId: "g", title: "Result", state: "needs_you" }];
  inbox.requested = [pr(10)];
  inbox.mine = [pr(11, { reasons: ["CI failing"] }), pr(12, ci("PENDING")), pr(13)];
  inbox.ready = [pr(14)];
  inbox.drafts = [pr(15, { isDraft: true })];
}

const ME = ["in-t1", "dk-d1", `land-${url(91)}`, "result-k1", `pr-${url(10)}`, `pr-${url(11)}`, "in-t2"];
const FLIGHT = [`land-${url(90)}`, `pr-${url(12)}`];
const READY = ["dk-d2", `pr-${url(14)}`];
const OPEN = [`pr-${url(13)}`, `pr-${url(15)}`];

// Keys in screen order, kept to the ones a test names.
function drawn(node, keep, out = []) {
  if (node && typeof node === "object") {
    if (keep.has(node.key) && !out.includes(node.key)) out.push(node.key);
    for (const child of node.items ?? []) drawn(child, keep, out);
  }
  return out;
}

test("Now groups every source by whose turn it is, in source order within a group", async () => {
  const { inbox, ui } = await open();
  everyTurn(inbox);
  const view = ui();
  assert.equal(text(find(view, "leg-me")), "NEEDS ME 7");
  assert.equal(text(find(view, "leg-flight")), "IN FLIGHT 2");
  assert.equal(text(find(view, "leg-ready")), "READY 2");
  assert.match(text(find(view, "now-open")), /^2 waiting on others/);
  const heads = ["leg-me", "leg-flight", "leg-ready", "now-open"];
  const keep = new Set([...heads, ...ME, ...FLIGHT, ...READY, ...OPEN]);
  assert.deepEqual(drawn(find(view, "inbox-list"), keep), ["leg-me", ...ME, "leg-flight", ...FLIGHT, "leg-ready", ...READY, "now-open"]);
  inbox.expanded["now-open"] = true;
  assert.deepEqual(drawn(find(ui(), "inbox-list"), keep).slice(-3), ["now-open", ...OPEN]);
});

test("the keyboard walks Now in the order it is drawn; waiting-on-others joins only unfolded", async () => {
  const { inbox, cx, ui } = await open();
  everyTurn(inbox);
  inbox.h.is_focused = () => true;
  ui();
  assert.deepEqual(inbox.nav.map((n) => n.id), [...ME, ...FLIGHT, ...READY]);
  inbox.expanded["now-open"] = true;
  const view = ui();
  const ids = inbox.nav.map((n) => n.id);
  assert.deepEqual(ids, [...ME, ...FLIGHT, ...READY, ...OPEN]);
  assert.deepEqual(drawn(find(view, "inbox-list"), new Set(ids)), ids);
  const walked = [];
  for (let i = 0; i < ids.length; i++) {
    inbox.navKey({ key: "down" }, cx);
    walked.push(inbox.sel);
    ui();
  }
  assert.deepEqual(walked, ids);
});

test("the Now tab counts what needs you, is in flight or is ready, not what waits on others", async () => {
  const { inbox, ui } = await open();
  everyTurn(inbox);
  assert.equal(text(find(ui(), "view-now")), `Now ${ME.length + FLIGHT.length + READY.length}`);
  assert.equal(text(find(ui(), "now-legend")).replace(/\s+/g, " "), "Needs me 7 In flight 2 Ready 2");
});

test("the Maintenance tab counts old PRs, merged worktrees and loose rows", async () => {
  const { inbox, ui } = await open();
  inbox.requested = [pr(1, { updatedAt: OLD })];
  inbox.mine = [pr(2, { updatedAt: OLD }), pr(3, { reasons: ["CI failing"] })];
  const tree = (name, extra) => ({ main: "/w/app", path: `/w/${name}`, branch: name, repo: "app", name, merged: false, open: false, at: 1, ...extra });
  inbox.worktrees = [tree("m1", { merged: true }), tree("m2", { merged: true }), tree("loose"), tree("spaced", { open: true })];
  assert.equal(text(find(ui(), "view-maintenance")), "Maintenance 5");
  assert.equal(text(find(ui(), "view-now")), "Now 1");
});

test("a click on a tab switches the view; Maintenance unfolds the loose worktrees and reads them", async () => {
  const { inbox, cx, ui } = await open();
  inbox.mine = [pr(1, { reasons: ["CI failing"] })];
  let reads = 0;
  inbox.loadTreeStates = () => { reads += 1; };
  inbox.sel = `pr-${url(1)}`;
  let view = ui();
  assert.ok(find(view, "now-legend"));
  assert.ok(find(view, "leg-me"));
  click(find(view, "view-maintenance"), cx);
  assert.equal(fake.stored[VIEW], "maintenance");
  assert.equal(inbox.sel, null);
  assert.equal(inbox.expanded.loose, true);
  assert.equal(fake.stored["relevo.inbox.folds"].loose, true);
  assert.equal(reads, 1);
  view = ui();
  assert.equal(find(view, "now-legend"), null);
  assert.equal(find(view, "leg-me"), null);
  assert.ok(find(view, "today-time"));
  click(find(view, "view-now"), cx);
  assert.equal(fake.stored[VIEW], "now");
  assert.ok(find(ui(), "leg-me"));
  click(find(ui(), "view-maintenance"), cx);
  assert.equal(reads, 1, "loose worktrees are read once they unfold, not on every visit");
});

test("m and n switch the view from the keyboard, but not in Runs", async () => {
  const { inbox, cx, ui } = await open();
  inbox.h.is_focused = () => true;
  ui();
  inbox.navKey({ key: "m" }, cx);
  assert.equal(fake.stored[VIEW], "maintenance");
  inbox.navKey({ key: "n" }, cx);
  assert.equal(fake.stored[VIEW], "now");
  fake.stored[GOAL_MODE] = true;
  inbox.navKey({ key: "m" }, cx);
  assert.equal(fake.stored[VIEW], "now");
});

test("Maintenance lists old PRs under OLD and every addressed or landed item in one fold, each with Undo", async () => {
  const { inbox, cx, ui } = await open();
  const done = pr(5, { reasons: ["CI failing"] });
  inbox.requested = [pr(1, { updatedAt: OLD })];
  inbox.mine = [pr(2, { updatedAt: OLD }), done];
  inbox.addressed[done.url] = Date.parse(NOW) / 1000;
  inbox.local = [{ kind: "diff", top: "/work/app", repo: "app", agent: agent("t1", "done"), files: 1, add: 1, del: 0, at: 1 }];
  inbox.labelling.t1 = "123:1";
  fake.stored[LANDING] = { [url(90)]: landing(90, "landed", { done: Date.now() / 1000 }) };
  let view = ui();
  for (const id of [`pr-${url(1)}`, `pr-${url(2)}`, `pr-${done.url}`, "in-t1", `land-${url(90)}`]) assert.equal(find(view, id), null, id);
  assert.equal(text(find(view, "view-now")), "Now 0");
  fake.stored[VIEW] = "maintenance";
  view = ui();
  assert.equal(text(find(view, "leg-old")), "OLD 2");
  assert.deepEqual(inbox.nav.map((n) => n.id), [`pr-${url(1)}`, `pr-${url(2)}`]);
  assert.match(text(find(view, "maintenance-done")), /^3 marked addressed or landed/);
  assert.equal(find(view, `pr-${done.url}`), null);
  click(find(view, "maintenance-done"), cx);
  view = ui();
  for (const id of [`pr-${done.url}`, "in-t1", `land-${url(90)}`]) assert.ok(find(view, id), id);
  click(find(view, "in-t1"), cx);
  assert.equal(inbox.sel, "in-t1");
  assert.ok(find(ui(), "undo-t1"));
  click(find(ui(), `pr-${done.url}`), cx);
  click(find(ui(), `undo-${done.url}`), cx);
  assert.match(text(find(ui(), "maintenance-done")), /^2 marked addressed or landed/);
  click(find(ui(), "view-now"), cx);
  assert.ok(find(ui(), `pr-${done.url}`));
});

test("the Reviews badge is the Needs me count, so a quiet or running PR never raises it", async () => {
  const { inbox, ui } = await open();
  inbox.mine = [pr(13), pr(12, ci("PENDING"))];
  ui();
  assert.equal(fake.stored["relevo.inbox.count"], 0);
  everyTurn(inbox);
  ui();
  assert.equal(fake.stored["relevo.inbox.count"], ME.length);
});

test("the Now tab keeps its count while Maintenance is open", async () => {
  const { inbox, ui } = await open();
  everyTurn(inbox);
  fake.stored[VIEW] = "maintenance";
  assert.equal(text(find(ui(), "view-now")), `Now ${ME.length + FLIGHT.length + READY.length}`);
});

test("a PR ready to merge but past 45 days is under OLD, not waiting on others", async () => {
  const { inbox, ui } = await open();
  inbox.ready = [pr(14, { updatedAt: OLD })];
  assert.equal(find(ui(), "now-open"), null);
  fake.stored[VIEW] = "maintenance";
  const view = ui();
  assert.equal(text(find(view, "leg-old")), "OLD 1");
  assert.equal(text(find(view, "view-maintenance")), "Maintenance 1");
});

test("the Maintenance count does not change when the recent loose worktrees fold", async () => {
  const { inbox, ui } = await open();
  inbox.worktrees = [{ main: "/w/app", path: "/w/a", branch: "a", repo: "app", name: "a", merged: false, open: false, at: Date.now() / 1000 }];
  inbox.treeStates = new Map([["/w/a", { state: { files: 0, unpushed: 0, unique: 0 } }]]);
  const before = text(find(ui(), "view-maintenance"));
  inbox.expanded["loose-recent"] = !inbox.expanded["loose-recent"];
  assert.equal(text(find(ui(), "view-maintenance")), before);
});

test("a click selects a row without hiding the rows above it", async () => {
  const { inbox, cx, ui } = await open();
  everyTurn(inbox);
  inbox.h.is_focused = () => true;
  click(find(ui(), `pr-${url(11)}`), cx);
  const view = ui();
  assert.equal(inbox.sel, `pr-${url(11)}`);
  assert.ok(find(view, "in-t1"));
  inbox.navKey({ key: "down" }, cx);
  assert.equal(find(ui(), "in-t1"), null, "the keyboard still scrolls by hiding what is above");
});

test("revealing a merged worktree leaves the addressed fold closed", async () => {
  const { inbox, ui } = await open();
  inbox.worktrees = [{ main: "/w/app", path: "/w/m1", branch: "m1", repo: "app", name: "m1", merged: true, open: false, at: 1 }];
  inbox.reveal("wt-/w/m1");
  ui();
  assert.equal(fake.stored[VIEW], "maintenance");
  assert.equal(inbox.sel, "wt-/w/m1");
  assert.ok(!inbox.expanded["maintenance-done"]);
});
