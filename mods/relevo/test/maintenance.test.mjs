// Maintenance on the real Inbox: three groups by what removing would lose, a selection removed after one
// question, sizes, and the branches nobody touched.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake, calls } from "./fake/herdr.mjs";
import { fakeCx, find, text, click, flush } from "./fake/ui.mjs";
import { bulkPlan, laneOf, loseOf, reasonOf, totalKb } from "../lib/trees.js";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { checkedOut, staleBranches, staleReason } from "../lib/branches.js";
import { INBOX_SHORTCUT_ACTIONS, buildShortcutHelpRows } from "../lib/shortcut-help.js";

const { Inbox } = await import("../inbox.js");
const { scanStale, deleteBranch } = await import("../branches.js");
const { deleteLocalBranch } = await import("../worktrees.js");

const VIEW = "relevo.inbox.view", DAY = 86400, NOW = Date.now() / 1000, OLD = NOW - 30 * DAY;
const REMOVE = /worktree remove/;
const tree = (name, extra = {}) => ({ main: "/w/app", path: `/w/${name}`, branch: name, repo: "app", name, merged: false, open: false, at: OLD, ...extra });
const merged = (name, extra = {}) => tree(name, { merged: true, pr: { number: 38, mergedAt: NOW - 3 * DAY }, ...extra });
const clean = { locked: false, files: 0, unpushed: 0, unique: 0, ignored: [] };
const settled = async () => { for (let i = 0; i < 12; i++) await flush(); };

// Every call a removal makes succeeds, except `worktree remove` on the paths in `refuse`.
function git({ refuse = [] } = {}) {
  fake.exec = (cmd, args) => {
    if (cmd === "gh") return { stdout: JSON.stringify({ data: { viewer: { login: "me", merged: { nodes: [] }, pullRequests: { nodes: [] } }, search: { nodes: [] } } }) };
    if (cmd === "sh" && args[1].includes("stat -f")) return { stdout: args.slice(3).map((p) => `${p}\t1\n`).join("") };
    if (args.includes("rev-parse")) return { stdout: "abc123\n" };
    if (args.includes("remove") && refuse.includes(args.at(-1))) return { code: 1, stderr: "fatal: cannot remove\n" };
    return null;
  };
}

beforeEach(() => {
  resetFake();
  git();
});

// Maintenance open with the keyboard in the list; `states` and `sizes` are what the scans would have read.
async function open(worktrees = [], { states = {}, sizes = {} } = {}) {
  const inbox = new Inbox(), cx = fakeCx();
  inbox.init({}, cx);
  await flush();
  fake.stored[VIEW] = "maintenance";
  inbox.h.is_focused = () => true;
  inbox.worktrees = worktrees;
  inbox.treeStates = new Map(Object.entries(states).map(([n, state]) => [`/w/${n}`, { at: OLD, state }]));
  inbox.treeSizes = new Map(Object.entries(sizes).map(([n, kb]) => [`/w/${n}`, { at: OLD, kb }]));
  const ui = () => inbox.render(cx);
  const key = (k, modifiers = {}) => { inbox.navKey({ key: k, modifiers }, cx); return ui(); };
  return { inbox, cx, ui, key };
}

const board = () => [merged("a"), merged("b"), merged("env", { ignored: [".env.local", "fixtures", "out"] }), tree("idle"), tree("dirty"), tree("pushed"), tree("new")];
const STATES = { idle: clean, dirty: { ...clean, files: 3 }, pushed: { ...clean, unique: 2 } };
const SIZES = { a: 217088, b: 202752, env: 1153434, idle: 86016, dirty: 6144 };

function drawn(node, keep, out = []) {
  if (node && typeof node === "object") {
    if (keep.has(node.key) && !out.includes(node.key)) out.push(node.key);
    for (const child of node.items ?? []) drawn(child, keep, out);
  }
  return out;
}

test("laneOf: safe only when nothing would be lost; in use or unread is quiet", () => {
  assert.equal(laneOf(merged("a"), NOW), "safe");
  assert.equal(laneOf(merged("a", { at: NOW - 3600 }), NOW), "quiet");
  assert.equal(laneOf(merged("a", { at: 0 }), NOW), "quiet");
  for (const extra of [{ dirty: true }, { locked: true }, { ignored: [".env"] }, { group: "work" }, { unreadable: true }]) {
    assert.equal(laneOf(merged("a", extra), NOW), "look", JSON.stringify(extra));
  }
  assert.equal(laneOf(tree("a"), NOW), "quiet");
  assert.equal(laneOf(tree("a", { group: "recent" }), NOW), "quiet");
  // Not merged is never safe to remove in a batch, even with nothing to lose.
  assert.equal(laneOf(tree("a", { group: "safe" }), NOW), "look");
  assert.equal(laneOf(tree("a", { group: "safe", ignored: ["out"] }), NOW), "look");
  assert.equal(laneOf(tree("a", { group: "pushed" }), NOW), "look");
  assert.equal(laneOf(tree("a", { group: "work" }), NOW), "look");
});

test("reasonOf: the one reason, in plain words", () => {
  assert.equal(reasonOf(merged("a"), NOW), "merged #38");
  assert.equal(reasonOf(merged("a", { pr: null }), NOW), "merged");
  assert.equal(reasonOf(merged("a", { at: NOW - 3600 }), NOW), "merged #38 · used 1h ago");
  assert.equal(reasonOf(merged("a", { ignored: [".env"] }), NOW), "merged #38, but has files git ignores");
  assert.equal(reasonOf(merged("a", { dirty: true }), NOW), "merged #38, but has uncommitted changes");
  assert.equal(reasonOf(merged("a", { dirty: true, work: true, unsaved: true }), NOW), "merged #38, but has work that is not saved anywhere");
  assert.equal(reasonOf(merged("a", { locked: true }), NOW), "merged #38, but is locked");
  assert.equal(reasonOf(tree("a", { group: "work", work: true, unsaved: true }), NOW), "work that is not saved anywhere");
  assert.equal(reasonOf(tree("a", { group: "work", work: true, unsaved: false }), NOW), "work saved in Backups, not on GitHub");
  assert.equal(reasonOf(tree("a", { group: "work", unreadable: true }), NOW), "could not check what is here");
  assert.equal(reasonOf(tree("a", { group: "work", locked: true }), NOW), "locked");
  assert.equal(reasonOf(tree("a", { group: "pushed" }), NOW), "pushed, not merged");
  assert.equal(reasonOf(tree("a", { group: "safe" }), NOW), "not merged, nothing to lose");
  assert.equal(reasonOf(tree("a", { group: "safe", ignored: ["out"] }), NOW), "nothing to lose in git, but has files git ignores");
  assert.equal(reasonOf(tree("a"), NOW), "checking");
});

test("loseOf: the merge and age facts, then at most five files git never saw", () => {
  const seven = ["a", "b", "c", "d", "e", "f", "g"];
  const lose = loseOf(merged("a", { ignored: seven, at: NOW - 12 * DAY }));
  assert.deepEqual(lose.says, ["Merged as #38 3d ago, so the code is safe.", "Last used 12d ago.", "Removing the folder also deletes 7 things git never saw:"]);
  assert.deepEqual(lose.files, ["a", "b", "c", "d", "e"]);
  assert.equal(lose.more, 2);
  assert.deepEqual(loseOf(merged("a", { ignored: [".env"], at: 0 })).says.at(-1), "Removing the folder also deletes 1 thing git never saw:");
  const safe = loseOf(merged("a", { space: "sp1" }));
  assert.deepEqual(safe.says, ["Merged as #38 3d ago, so the code is safe.", "Last used 30d ago.", "Removing it closes its space."]);
  assert.deepEqual([safe.files, safe.more], [[], 0]);
  // Work that is not in the merge is never called safe.
  const held = loseOf(merged("a", { dirty: true, work: true, unsaved: true, why: "3 files uncommitted" })).says;
  assert.deepEqual(held.slice(0, 2), ["Merged as #38 3d ago.", "Not saved anywhere: 3 files uncommitted."]);
  assert.match(loseOf(merged("a", { pr: null })).says[0], /^Its branch is gone from GitHub/);
});

test("bulkPlan: says only what holds for the selection, and stops on a row that is not safe", () => {
  const a = merged("a", { kb: 1024 }), b = merged("b", { kb: 2048, space: "sp1" }), idle = tree("idle", { group: "safe", kb: 512 });
  const all = bulkPlan([a, b], NOW);
  assert.equal(all.title, "Remove 2 merged worktrees?");
  assert.equal(all.body, "Removes each folder and its local branch. Their work is merged on GitHub. 1 space closes. Nothing unsaved is lost. Logged in deletions.log.");
  assert.equal(all.kb, 3072);
  const one = bulkPlan([a], NOW);
  assert.equal(one.title, "Remove 1 merged worktree?");
  assert.doesNotMatch(one.body, /space/);
  const mixed = bulkPlan([a, idle], NOW);
  assert.equal(mixed.ok, false);
  assert.equal(mixed.why, "app idle is not safe to remove. Unselect it first.");
  const bad = bulkPlan([a, merged("env", { ignored: [".env"] }), tree("dirty", { group: "work" })], NOW);
  assert.equal(bad.ok, false);
  assert.equal(bad.why, "app env and 1 more are not safe to remove. Unselect them first.");
  assert.equal(bulkPlan([], NOW).ok, false);
  assert.equal(totalKb([a, b, tree("x")]), 3072);
});

test("Maintenance reads as a legend and three groups, and the keyboard walks them as drawn", async () => {
  const { inbox, ui } = await open(board(), { states: STATES, sizes: SIZES });
  const view = ui();
  assert.equal(text(find(view, "maintenance-legend")).replace(/\s+/g, " "), "Safe to remove 2 Needs a look 4 Old 0");
  assert.equal(text(find(view, "leg-safe")), "SAFE TO REMOVE 2 410 MB Remove 2");
  assert.equal(text(find(view, "leg-look")), "NEEDS A LOOK 4");
  assert.match(text(find(view, "loose-recent")), /^Checking 1/);
  const ids = ["a", "b", "env", "idle", "dirty", "pushed"].map((n) => `wt-/w/${n}`);
  assert.deepEqual(inbox.nav.map((n) => n.id), ids);
  assert.deepEqual(drawn(find(view, "inbox-list"), new Set(["leg-safe", "leg-look", "loose-recent", ...ids])),
    ["leg-safe", ...ids.slice(0, 2), "leg-look", ...ids.slice(2), "loose-recent"]);
  assert.equal(text(find(view, "wt-/w/a")), "app a · merged #38 212 MB Remove");
  assert.equal(text(find(view, "wt-/w/idle")), "app idle · not merged, nothing to lose 84 MB Remove");
  assert.equal(text(find(view, "wt-/w/env")), "app env · merged #38, but has files git ignores 1.1 GB Look");
  assert.equal(text(find(view, "wt-/w/dirty")), "app dirty · work that is not saved anywhere 6 MB Look");
  assert.equal(text(find(view, "wt-/w/pushed")), "app pushed · pushed, not merged Open");
  assert.equal(text(find(view, "view-maintenance")), "Maintenance 6", "the tab is the legend's sum");
  inbox.expanded["loose-recent"] = true;
  ui();
  assert.deepEqual(inbox.nav.map((n) => n.id), [...ids, "wt-/w/new"], "the folded row is reached only once it shows");
});

test("a selected row that needs a look says what would go, and offers its actions with their keys", async () => {
  const many = [".env.local", "fixtures/ask-audio", "results.xcresult", "notes.md", "out", "tmp.db", "scratch"];
  const { inbox, cx, ui } = await open([merged("env", { ignored: many }), tree("dirty")], { states: { dirty: { ...clean, files: 3 } } });
  click(find(ui(), "wt-look-/w/env"), cx);
  assert.equal(inbox.sel, "wt-/w/env");
  let view = ui();
  assert.match(text(find(view, "wt-/w/env")), /Merged as #38 3d ago, so the code is safe\. Last used 30d ago\. Removing the folder also deletes 7 things git never saw:/);
  assert.equal(text(find(view, "wt-lose-/w/env")), ".env.local fixtures/ask-audio results.xcresult notes.md out +2 more");
  assert.equal(find(view, "wt-look-/w/env"), null);
  assert.equal(text(find(view, "wt-folder-/w/env")), "o Open folder");
  assert.equal(text(find(view, "wt-rm-/w/env")), "d Delete forever");
  assert.equal(find(view, "wt-patch-/w/env"), null, "git has nothing of these files to save");
  click(find(view, "wt-/w/dirty"), cx);
  view = ui();
  assert.equal(text(find(view, "wt-patch-/w/dirty")), "s Save patch");
  assert.equal(text(find(view, "wt-delete-/w/dirty")), "d Delete forever");
  assert.equal(find(view, "wt-rm-/w/dirty"), null);
  assert.equal(calls(REMOVE).length, 0);
});

test("Delete forever on a merged row with ignored files names them and asks again before git runs", async () => {
  const { inbox, cx, ui, key } = await open([merged("env", { ignored: [".env.local"] })]);
  fake.exec = (cmd, args) => (cmd === "sh" ? { stdout: "/w/env\t1\n" } : args.includes("--ignored") ? { stdout: ".env.local\0" } : null);
  inbox.sel = "wt-/w/env";
  ui();
  key("d");
  await settled();
  assert.equal(inbox.confirm, "/w/env");
  assert.match(text(find(ui(), "wt-note-/w/env")), /deletes \.env\.local/);
  assert.equal(text(find(ui(), "wt-rm-/w/env")), "Confirm");
  // A second d is not an answer.
  key("d");
  await settled();
  assert.equal(calls(REMOVE).length, 0);
  key("enter");
  await settled();
  assert.equal(calls(REMOVE).length, 1);
  assert.match(fake.execs.find((l) => l.includes("deletions.log")), /Remove, deletes \.env\.local/);
});

test("Esc takes back a row's question before it leaves the row", async () => {
  const { inbox, ui, key } = await open([merged("a")]);
  inbox.sel = "wt-/w/a";
  ui();
  key("d");
  await settled();
  assert.equal(inbox.confirm, "/w/a");
  key("escape");
  assert.equal(inbox.confirm, null);
  assert.equal(inbox.sel, "wt-/w/a");
  key("enter");
  await settled();
  assert.equal(calls(REMOVE).length, 0);
});

test("x selects the focused row and X every merged safe row without a space; the bar counts them and their size", async () => {
  const { inbox, ui, key } = await open([...board(), merged("spaced", { space: "sp1" })], { states: STATES, sizes: SIZES });
  assert.equal(find(ui(), "bulk-bar"), null);
  inbox.sel = "wt-/w/a";
  let view = key("x");
  assert.deepEqual([...inbox.marked], ["/w/a"]);
  assert.equal(text(find(view, "bulk-bar")), "1 selected 212 MB esc Cancel d Remove 1");
  assert.equal(find(view, "wt-mark-/w/a").items[0].fill, "#accent");
  assert.equal(find(view, "wt-mark-/w/b").items[0].fill, null);
  assert.equal(find(view, "wt-rm-/w/a"), null, "while selecting, the edge holds the checkbox");
  view = key("x");
  assert.equal(inbox.marked.size, 0);
  assert.equal(find(view, "bulk-bar"), null);
  view = key("x", { shift: true });
  assert.deepEqual([...inbox.marked], ["/w/a", "/w/b"], "never a worktree that is not merged, nor one with a space");
  assert.equal(text(find(view, "bulk-bar")), "2 selected 410 MB esc Cancel d Remove 2");
  click(find(view, "wt-mark-/w/b"), fakeCx());
  assert.deepEqual([...inbox.marked], ["/w/a"]);
  inbox.navKey({ key: "X", modifiers: {} }, fakeCx());
  assert.equal(inbox.marked.size, 2);
});

test("d asks once for the lot; Enter removes each through its own checks and log", async () => {
  const { inbox, ui, key } = await open(board(), { states: STATES, sizes: SIZES });
  key("x", { shift: true });
  let view = key("d");
  assert.equal(find(view, "bulk-bar"), null);
  assert.equal(text(find(view, "bulk-sheet")), "Remove 2 merged worktrees? Removes each folder and its local branch. Their work is merged on GitHub. Nothing unsaved is lost. Logged in deletions.log. esc Cancel Remove 2");
  assert.equal(calls(REMOVE).length, 0);
  key("enter");
  await settled();
  assert.deepEqual(calls(REMOVE).map((l) => l.split(" ").at(-1)), ["/w/a", "/w/b"]);
  for (const name of ["a", "b"]) {
    assert.ok(calls(/ls-files --stage/).length >= 2, "each row was read again");
    assert.ok(fake.execs.some((l) => l.includes("deletions.log") && l.includes(`"path":"/w/${name}"`)), name);
  }
  assert.deepEqual(inbox.worktrees.map((w) => w.name), ["env", "idle", "dirty", "pushed", "new"]);
  assert.equal(inbox.marked.size, 0);
  assert.equal(fake.notices.at(-1).title, "Removed 2 worktrees");
  assert.equal(find(ui(), "bulk-bar"), null);
});

test("a row git refuses is reported on its row and stays selected; the others still go", async () => {
  const { inbox, ui, key } = await open([merged("a"), merged("b"), merged("c")]);
  git({ refuse: ["/w/b"] });
  key("x", { shift: true });
  key("d");
  click(find(ui(), "bulk-confirm"), fakeCx());
  await settled();
  assert.equal(calls(REMOVE).length, 3);
  assert.deepEqual(inbox.worktrees.map((w) => w.name), ["b"]);
  assert.equal(text(find(ui(), "wt-note-/w/b")), "fatal: cannot remove");
  assert.deepEqual([...inbox.marked], ["/w/b"]);
  assert.deepEqual([fake.notices.at(-1).title, fake.notices.at(-1).level], ["Removed 2 of 3", "warning"]);
  assert.ok(!fake.execs.some((l) => l.includes("deletions.log") && l.includes('"path":"/w/b"')), "what stayed is not logged");
});

test("Cancel and Esc remove nothing: first the question goes, then the selection", async () => {
  const { inbox, ui, key } = await open([merged("a"), merged("b")]);
  key("x", { shift: true });
  key("d");
  click(find(ui(), "bulk-sheet-cancel"), fakeCx());
  assert.equal(inbox.bulkAsk, null);
  assert.equal(inbox.marked.size, 2);
  key("d");
  let view = key("escape");
  assert.equal(find(view, "bulk-sheet"), null);
  assert.ok(find(view, "bulk-bar"));
  view = key("escape");
  assert.equal(inbox.marked.size, 0);
  assert.equal(find(view, "bulk-bar"), null);
  key("enter");
  await settled();
  assert.equal(calls(REMOVE).length, 0);
  assert.equal(inbox.worktrees.length, 2);
});

test("a selection with a row that is not safe can't be removed, and says which", async () => {
  const { inbox, ui, key } = await open(board(), { states: STATES, sizes: SIZES });
  key("x", { shift: true });
  inbox.sel = "wt-/w/env";
  let view = key("x");
  assert.equal(find(view, "bulk-remove").isDisabled, true);
  assert.equal(text(find(view, "bulk-why")), "app env is not safe to remove. Unselect it first.");
  view = key("d");
  assert.equal(inbox.bulkAsk, null);
  assert.equal(find(view, "bulk-sheet"), null);
  key("enter");
  await settled();
  assert.equal(calls(REMOVE).length, 0);
  view = key("x");
  assert.equal(find(view, "bulk-remove").isDisabled, false);
});

test("a row that stops being safe after the question is asked stops the removal", async () => {
  const { inbox, key } = await open([merged("a"), merged("b")]);
  key("x", { shift: true });
  key("d");
  inbox.worktrees[1].dirty = true;
  key("enter");
  await settled();
  assert.equal(calls(REMOVE).length, 0);
});

test("a marked row with a space says so in the question, and only that space closes", async () => {
  fake.spaces = [{ id: "sp1", folder: "/w/a", tabs: [] }];
  const { inbox, key } = await open([merged("a", { space: "sp1" }), merged("b")]);
  inbox.sel = "wt-/w/a";
  key("x");
  inbox.sel = "wt-/w/b";
  key("x");
  assert.match(text(find(key("d"), "bulk-sheet")), /Remove 2 merged worktrees\? .* 1 space closes\./);
  key("enter");
  await settled();
  assert.deepEqual(fake.runs.filter(([name]) => name === "space.close"), [["space.close", { id: "sp1", confirmed: true }]]);
  assert.equal(calls(REMOVE).length, 2);
});

test("x, X and d do nothing in Now, and leaving Maintenance drops the selection", async () => {
  const { inbox, cx, ui, key } = await open([merged("a"), merged("b")]);
  key("x", { shift: true });
  assert.equal(inbox.marked.size, 2);
  click(find(ui(), "view-now"), cx);
  assert.equal(inbox.marked.size, 0);
  key("x", { shift: true });
  key("d");
  assert.equal(inbox.marked.size, 0);
  assert.equal(inbox.bulkAsk ?? null, null);
  assert.equal(find(ui(), "bulk-bar"), null);
});

test("sizes are measured for merged and loose worktrees alike, once per use", async () => {
  const { inbox, cx } = await open([merged("a"), tree("idle"), tree("spaced", { open: true })]);
  inbox.treeStates = new Map();
  inbox.treeSizes = new Map();
  inbox.expanded.loose = true;
  fake.exec = (cmd, args) => (cmd === "du" ? { stdout: `2048\t${args[1]}\n` } : null);
  inbox.loadTreeStates(cx);
  await settled();
  assert.deepEqual(calls(/^du -sk \/w\//), ["du -sk /w/a", "du -sk /w/idle"]);
  const lanes = inbox.treeLanes(inbox.worktrees);
  assert.deepEqual([...lanes.safe, ...lanes.look].map((w) => [w.name, w.kb]), [["a", 2048], ["idle", 2048]]);
  inbox.loadTreeStates(cx);
  await settled();
  assert.equal(calls(/^du -sk \/w\//).length, 2);
});

test("a narrow panel keeps glyphs, counts and actions, and drops labels and sizes", async () => {
  const { inbox, cx, ui, key } = await open(board(), { states: STATES, sizes: SIZES });
  const size = find(ui(), "relevo-inbox").handlers.on_size_change;
  size({ width: 320, height: 600 }, cx);
  assert.deepEqual([inbox.narrowInbox, inbox.tightInbox], [true, false]);
  assert.match(text(find(ui(), "wt-/w/a")), /212 MB/);
  size({ width: 300, height: 600 }, cx);
  assert.equal(inbox.tightInbox, true);
  const view = ui();
  assert.equal(text(find(view, "maintenance-legend")).replace(/\s+/g, " "), "2 4 0");
  assert.equal(find(view, "maintenance-legend-ready").tip, "Safe to remove");
  assert.equal(text(find(view, "leg-safe")), "SAFE TO REMOVE 2 Remove 2");
  assert.equal(text(find(view, "wt-/w/a")), "app a · merged #38 Remove");
  assert.equal(text(find(view, "wt-/w/env")), "app env · merged #38, but has files git ignores Look");
  assert.equal(text(find(key("x", { shift: true }), "bulk-bar")), "2 selected esc Cancel d Remove 2");
});

test("the help lists the Maintenance keys", () => {
  const rows = buildShortcutHelpRows(INBOX_SHORTCUT_ACTIONS).filter((r) => r.section === "Maintenance");
  assert.deepEqual(rows.map((r) => [r.id, r.shortcut]), [
    ["inbox.mark", "X"], ["inbox.mark-safe", "⇧X"], ["inbox.remove-marked", "D"], ["inbox.unmark", "escape"],
    ["inbox.tree-save", "S"], ["inbox.tree-folder", "O"],
  ]);
});

const REFS = ["main 100 ", `feat/live ${NOW - 2 * DAY} [ahead 1]`, `old/gone ${NOW - 52 * DAY} [gone]`, `old/kept ${NOW - 31 * DAY} [ahead 2, behind 1]`,
  `old/plain ${NOW - 90 * DAY} `, `old/open ${NOW - 60 * DAY} `, `edge ${NOW - 30 * DAY + 60} `].join("\n");

test("staleBranches: past 30 days, never the default branch or one checked out, oldest first", () => {
  const skip = checkedOut("worktree /r/app\nHEAD abc\nbranch refs/heads/main\n\nworktree /wt/x\nHEAD def\nbranch refs/heads/old/open\n\nworktree /wt/y\nHEAD 123\ndetached\n");
  assert.deepEqual([...skip], ["main", "old/open"]);
  const list = staleBranches(REFS, { now: NOW, skip });
  assert.deepEqual(list.map((b) => [b.name, b.gone]), [["old/plain", false], ["old/gone", true], ["old/kept", false]]);
  assert.equal(staleReason(list[1], NOW), "last commit 52 days ago · gone upstream");
  assert.equal(staleReason(list[0], NOW), "last commit 90 days ago");
  assert.deepEqual(staleBranches("\n  \nbroken\n", { now: NOW }), []);
});

test("a branch delete is -d unless its caller asks to force, and the stale branches never ask", async () => {
  await deleteLocalBranch("/r/app", "old/gone");
  await deleteLocalBranch("/r/app", "feat", true);
  assert.deepEqual(calls(/ branch /), ["git -C /r/app branch -d old/gone", "git -C /r/app branch -D feat"]);
  for (const file of ["../branches.js", "../inbox-branches.js", "../lib/branches.js"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /"-D"|--force|deleteLocalBranch\([^)]*,[^)]*,/, file);
  }
});

// One clone under ROOT whose refs are REFS, with old/open checked out in a worktree.
function repo(name, { refuse = null } = {}) {
  const main = `/home/test/work/${name}`;
  fake.exec = (cmd, args) => {
    if (cmd === "gh") return { stdout: JSON.stringify({ data: { viewer: { login: "me", merged: { nodes: [] }, pullRequests: { nodes: [] } }, search: { nodes: [] } } }) };
    if (cmd === "sh") return args[1].includes('|| printf') ? { stdout: `${main}\n` } : null;
    if (args.includes("for-each-ref") && args.some((a) => a.includes("committerdate"))) return { stdout: `${REFS}\n` };
    if (args.includes("worktree") && args.includes("list")) return { stdout: `worktree ${main}\nbranch refs/heads/main\n\nworktree /wt/x\nbranch refs/heads/old/open\n` };
    if (args.includes("symbolic-ref")) return { stdout: "origin/main\n" };
    if (args.includes("branch") && args.includes("-d")) return refuse ? { code: 1, stderr: refuse } : { stdout: `Deleted branch ${args.at(-1)} (was abc1234).\n` };
    return null;
  };
  return main;
}

test("the scan reads each repo with read-only git, and again only after 15 minutes or a refresh", async () => {
  const main = repo("cached");
  const list = await scanStale();
  assert.deepEqual(list.map((b) => [b.repo, b.main, b.name]), [["cached", main, "old/plain"], ["cached", main, "old/gone"], ["cached", main, "old/kept"]]);
  const read = calls(/for-each-ref --format=%\(refname:short\) %\(committerdate:unix\) %\(upstream:track\) refs\/heads/);
  assert.equal(read.length, 1);
  assert.match(read[0], /^git --no-optional-locks -c core\.fsmonitor=false /);
  await scanStale();
  assert.equal(calls(/committerdate/).length, 1);
  await scanStale(true);
  assert.equal(calls(/committerdate/).length, 2);
});

test("git's refusal comes back as git said it, and nothing is forced", async () => {
  const refusal = "error: the branch 'old/kept' is not fully merged";
  const main = repo("refused", { refuse: `${refusal}\n` });
  assert.deepEqual(await deleteBranch({ main, name: "old/kept" }), { error: refusal });
  assert.deepEqual(calls(/ branch /), [`git -C ${main} branch -d old/kept`]);
  assert.equal(fake.execs.some((l) => /\s-D(\s|$)|--force/.test(l)), false);
});

test("the fold reads the branches when it opens; Delete branch runs git branch -d and says what git said", async () => {
  const main = repo("fold");
  const { inbox, cx, ui } = await open();
  let view = ui();
  assert.match(text(find(view, "stale-branches")), /^Branches nobody touched in 30 days Show$/);
  assert.equal(calls(/committerdate/).length, 0, "nothing is read before the fold opens");
  click(find(view, "stale-show"), cx);
  await settled();
  view = ui();
  assert.match(text(find(view, "stale-branches")), /^3 branches nobody touched in 30 days Hide$/);
  assert.equal(text(find(view, "leg-old")), "OLD 3");
  assert.match(text(find(view, "maintenance-legend")), /Old 3$/);
  assert.equal(text(find(view, "view-maintenance")), "Maintenance 3");
  const id = `br-${main}:old/gone`;
  assert.equal(text(find(view, id)), "fold old/gone · last commit 52 days ago · gone upstream Delete branch");
  assert.deepEqual(inbox.nav.map((n) => n.id), ["old/plain", "old/gone", "old/kept"].map((n) => `br-${main}:${n}`));
  click(find(view, `br-del-${main}:old/gone`), cx);
  await settled();
  assert.deepEqual(calls(/ branch /), [`git -C ${main} branch -d old/gone`]);
  assert.deepEqual([fake.notices.at(-1).title, fake.notices.at(-1).body], ["Deleted branch old/gone", "Deleted branch old/gone (was abc1234)."]);
  view = ui();
  assert.equal(find(view, id), null);
  assert.match(text(find(view, "stale-branches")), /^2 branches/);
  // Enter on a branch row never deletes.
  inbox.sel = `br-${main}:old/kept`;
  inbox.navKey({ key: "enter" }, cx);
  await settled();
  assert.equal(calls(/ branch /).length, 1);
});

test("a refused delete shows git's words on the row and keeps the branch listed", async () => {
  const main = repo("kept", { refuse: "error: the branch 'old/kept' is not fully merged\nhint: If you are sure you want to delete it, run 'git branch -D old/kept'\n" });
  const { cx, ui } = await open();
  click(find(ui(), "stale-branches"), cx);
  await settled();
  click(find(ui(), `br-del-${main}:old/kept`), cx);
  await settled();
  const row = find(ui(), `br-${main}:old/kept`);
  assert.match(text(row), /error: the branch 'old\/kept' is not fully merged/);
  assert.equal(calls(/ branch /).every((l) => l.includes(" branch -d ")), true);
});
