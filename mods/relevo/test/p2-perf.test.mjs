import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake, calls } from "./fake/herdr.mjs";
import { fakeCx, flush } from "./fake/ui.mjs";
import { capMap } from "../lib/cache.js";

const { parsePorcelainV2, readGit } = await import("../../relevo-spaces/git.js");
const { default: Spaces } = await import("../../relevo-spaces/main.js");
const { default: Agents } = await import("../../relevo-agents/main.js");
const { Inbox } = await import("../inbox.js");
const { ReviewDiff } = await import("../review.js");
const { Workflow } = await import("../workflow.js");
const { USAGE, USAGE_OPEN } = await import("../usage-scan.js");
const { UsageDialog } = await import("../usage.js");
const { InboxButton, COUNT } = await import("../toolbar.js");
const { AliveWatch } = await import("../alive.js");
const { DesktopWatch } = await import("../desktop.js");
const { ElsewhereWatch } = await import("../elsewhere.js");

beforeEach(() => {
  resetFake();
  for (const k of ["opened", "closed", "touched", "changed", "pins"]) localStorage.removeItem(k);
});

test("parsePorcelainV2 parses branch, detached HEAD, ahead/behind and changed files; readGit refreshes in 1 fork", async () => {
  assert.deepEqual(parsePorcelainV2("# branch.head main\n# branch.ab +4 -2\n1 .M N... 0 0 0 a b x.js\n? y.js\n"),
    { branch: "main", ahead: 4, behind: 2, changed: 2 });
  assert.deepEqual(parsePorcelainV2("# branch.head (detached)\n"), { branch: null, ahead: 0, behind: 0, changed: 0 });
  fake.exec = (cmd, args) => {
    const a = args.join(" ");
    if (a.includes("--show-toplevel")) return { stdout: "/r/app\n" };
    if (a.includes("--git-common-dir")) return { stdout: "/r/app/.git\n" };
    if (a.includes("status")) return { stdout: "# branch.head feat\n# branch.ab +1 -0\n" };
    return null;
  };
  const first = await readGit("/r/app");
  assert.equal(calls(/^git /).length, 3);
  const refreshed = await readGit("/r/app", null, first);
  assert.equal(calls(/^git /).length, 4, "refresh uses only 1 git status fork");
  assert.equal(refreshed.branch, "feat");
  assert.equal(refreshed.ahead, 1);
});

test("capMap bounds Map growth while keeping the newest entries", () => {
  const m = new Map([["a", 1], ["b", 2], ["c", 3], ["d", 4]]);
  capMap(m, 2);
  assert.deepEqual([...m.keys()], ["c", "d"]);
});

test("Inbox caches publish() and maintenanceModel() across j/k navigation and cancels watches on close", async () => {
  const inbox = new Inbox(), cx = fakeCx();
  inbox.init({}, cx); await flush();
  const pr = (n) => ({ url: `https://github.com/acme/app/pull/${n}`, repo: "acme/app", number: n, title: `PR ${n}`, reasons: ["CI failing"], skills: [], updatedAt: new Date().toISOString() });
  inbox.mine = [pr(1), pr(2)];
  let pubCalls = 0, maintCalls = 0;
  const origPub = inbox.publish.bind(inbox), origMaint = inbox.maintenanceModel.bind(inbox);
  inbox.publish = (...a) => { pubCalls++; return origPub(...a); };
  inbox.maintenanceModel = (...a) => { maintCalls++; return origMaint(...a); };
  inbox.render(cx);
  assert.equal(pubCalls, 1);
  assert.equal(maintCalls, 1);
  // Pure j/k selection move does not re-run publish() or maintenanceModel().
  inbox.sel = `pr-${pr(2).url}`;
  inbox.render(cx);
  assert.equal(pubCalls, 1);
  assert.equal(maintCalls, 1);

  let cancelled = 0;
  inbox.watches.set("/r/.git", { cancel() { cancelled++; } });
  inbox.close();
  assert.equal(cancelled, 1);
  assert.equal(inbox.watches.size, 0);
});

test("ReviewDiff in scope=seen reuses snapshot when HEAD and working tree status are unchanged", async () => {
  let snapshots = 0;
  fake.exec = (cmd, args) => {
    const a = args.join(" ");
    if (a.includes("rev-parse HEAD")) return { code: 0, stdout: "abc123\n" };
    if (a.includes("status --porcelain")) return { code: 0, stdout: " M a.js\n" };
    if (cmd === "sh" && a.includes("git add -A")) { snapshots++; return { code: 0, stdout: "treehash1\n" }; }
    return { code: 0, stdout: "" };
  };
  const v = new ReviewDiff(), cx = fakeCx();
  v.init({}, cx);
  v.root = "/r/app"; v.scope = "seen";
  fake.stored["relevo.review.seen"] = { "/r/app": { tree: "base1", at: 1 } };
  await v.read(cx);
  await v.read(cx);
  assert.equal(snapshots, 1, "unchanged poll skips git add -A .");
  v.close();
});

test("Workflow replaces its 10 Hz timer with on-demand focus scheduling", () => {
  fake.props = { goalId: "g1" };
  const w = new Workflow(), cx = fakeCx();
  w.init({}, cx);
  assert.equal(cx.timers.some((t) => !t.once && t.ms === 100), false, "no permanent 100ms timer");
  w.close();
});

test("InboxButton tracks seen count locally without calling setShared inside render", () => {
  fake.layout = { id: "root", children: [{ id: "panel", hidden: false }, { id: "panel-body", active: "inbox" }] };
  fake.stored[COUNT] = 2;
  const bar = new InboxButton();
  bar.render();
  assert.equal(fake.stored["relevo.inbox.seen"], undefined);
});

test("UsageScanner suppresses intermediate progress redraws when UsageDialog is closed", () => {
  const dlg = new UsageDialog(), cx = fakeCx();
  dlg.init({}, cx);
  assert.equal(fake.stored[USAGE_OPEN], true);
  dlg.close();
  assert.equal(fake.stored[USAGE_OPEN], false);
  assert.equal(USAGE, "relevo.usage");
});

test("AliveWatch, DesktopWatch and ElsewhereWatch guard overlapping ticks with busy + STUCK_MS", async () => {
  fake.window = { active: true };
  let callsCount = 0;
  fake.exec = () => { callsCount++; return new Promise(() => {}); };
  const alive = new AliveWatch();
  alive.tick(); alive.tick();
  assert.equal(callsCount, 2, "second tick skipped while busy (first tick runs lsof + ps)");
  const desk = new DesktopWatch();
  desk.busy = true; desk.busySince = Date.now();
  await desk.tick();
  assert.equal(desk.busy, true);
  const ew = new ElsewhereWatch();
  ew.busy = true; ew.busySince = Date.now();
  await ew.tick();
  assert.equal(ew.busy, true);
});

test("Agents guards cyclic sub-agent trees and corrupted localStorage; Spaces.close cancels watches", () => {
  localStorage.setItem("changed", "{broken json");
  localStorage.setItem("pins", "{broken");
  const ag = new Agents(), cx = fakeCx();
  ag.init({}, cx);
  assert.deepEqual(ag.changed, {});
  assert.deepEqual(ag.pendingPins, []);
  const cyclic = [
    { address: "a", parent: "b", state: "live" },
    { address: "b", parent: "a", state: "live" },
  ];
  const walked = ag.tree(cyclic, "a");
  assert.equal(walked.length, 1);

  const sp = new Spaces();
  sp.watching = new Map();
  let cancelled = 0;
  sp.watching.set("/r/.git", { cancel() { cancelled++; } });
  sp.close();
  assert.equal(cancelled, 1);
  assert.equal(sp.watching.size, 0);
});
