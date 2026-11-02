// Removing a merged worktree on a fake app: what's checked again, and what the confirmation says.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake, calls } from "./fake/herdr.mjs";
import { fakeCx, flush, text } from "./fake/ui.mjs";

const { TreeViews } = await import("../inbox-trees.js");
const PATH = "/work/wt", REMOVE = /worktree remove/;
const tree = (over = {}) => ({ main: "/work/app", path: PATH, branch: "feat", repo: "app", name: "wt", merged: true, ...over });

function view(...worktrees) {
  const v = new TreeViews();
  Object.assign(v, { worktrees, removing: new Set(), gone: new Set(), wtError: {}, expanded: {}, confirm: null, selected: () => false });
  return v;
}

function files({ status = "", ignored = "" } = {}) {
  fake.exec = (cmd, args) => {
    if (args.includes("--porcelain")) return { stdout: status };
    if (args.includes("--ignored")) return { stdout: ignored };
    return null;
  };
}

async function clickRemove(v, w, cx) {
  v.removeTree(w, cx);
  await flush();
}

beforeEach(() => {
  resetFake();
  files();
});

test("Remove asks, then removes a clean worktree", async () => {
  const v = view(), w = tree(), cx = fakeCx();
  await clickRemove(v, w, cx);
  assert.equal(v.confirm, PATH);
  assert.equal(calls(REMOVE).length, 0);
  await clickRemove(v, w, cx);
  assert.equal(calls(REMOVE).length, 1);
});

test("ignored work is named before it goes, while rebuilt folders aren't", async () => {
  files({ ignored: ".env\0node_modules/\0packages/a/dist/\0" });
  const v = view(), w = tree(), cx = fakeCx();
  await clickRemove(v, w, cx);
  assert.deepEqual(w.ignored, [".env"]);
  assert.match(text(v.treeRow({}, w)), /deletes \.env/);
  await clickRemove(v, w, cx);
  assert.equal(calls(REMOVE).length, 1);
});

test("an ignored name with a newline is one file", async () => {
  files({ ignored: "a\nb.env\0" });
  const v = view(), w = tree(), cx = fakeCx();
  await clickRemove(v, w, cx);
  assert.deepEqual(w.ignored, ["a\nb.env"]);
});

test("files that appear after the question ask again", async () => {
  const v = view(), w = tree(), cx = fakeCx();
  await clickRemove(v, w, cx);
  files({ ignored: ".env\0" });
  await clickRemove(v, w, cx);
  assert.equal(calls(REMOVE).length, 0);
  assert.equal(v.confirm, PATH);
});

test("changes made since the scan stop it before its space closes", async () => {
  fake.spaces = [{ id: "sp1", folder: PATH }];
  const v = view(), w = tree({ space: "sp1" }), cx = fakeCx();
  await clickRemove(v, w, cx);
  files({ status: " M a.js\n" });
  await clickRemove(v, w, cx);
  assert.equal(v.wtError[PATH], "uncommitted changes");
  assert.deepEqual(fake.runs, []);
  assert.equal(calls(REMOVE).length, 0);
});

test("a terminal opened here since the scan stops it", async () => {
  const v = view(), w = tree(), cx = fakeCx();
  fake.panes = [{ pane: "p1", cwd: `${PATH}/src` }];
  await clickRemove(v, w, cx);
  assert.equal(v.wtError[PATH], "open in a terminal");
  assert.equal(calls(REMOVE).length, 0);
});

test("a space's own terminals close with it; one from another space stops it", async () => {
  fake.spaces = [{ id: "sp1", folder: PATH, tabs: [{ id: "tb1" }] }];
  fake.panes = [{ pane: "p1", cwd: PATH, tab: "tb1" }];
  const v = view(), w = tree({ space: "sp1" }), cx = fakeCx();
  await clickRemove(v, w, cx);
  assert.equal(v.wtError[PATH], undefined);
  fake.panes.push({ pane: "p2", cwd: `${PATH}/src`, tab: "tb2" });
  await clickRemove(v, w, cx);
  assert.equal(v.wtError[PATH], "open in a terminal");
});

test("a space opened after the question asks again before closing it", async () => {
  const v = view(), w = tree(), cx = fakeCx();
  await clickRemove(v, w, cx);
  fake.spaces = [{ id: "sp1", folder: PATH, tabs: [] }];
  await clickRemove(v, w, cx);
  assert.deepEqual(fake.runs, []);
  assert.equal(calls(REMOVE).length, 0);
  assert.match(text(v.treeRow({}, w)), /closes its space/);
});

test("Remove all leaves out worktrees with ignored work, even found after the scan", async () => {
  const a = tree(), b = tree({ path: "/work/wt2", ignored: [".env"] });
  const v = view(a, b), cx = fakeCx();
  assert.deepEqual(v.removable([a, b]), [a]);
  files({ ignored: "notes.md\0" });
  v.confirm = "all";
  v.removeAll([a], cx);
  await flush();
  assert.equal(calls(REMOVE).length, 0);
  assert.equal(v.wtError[PATH], "deletes notes.md");
});

test("Remove all leaves out a worktree that gained a space or a terminal after the scan", async () => {
  const a = tree(), b = tree({ path: "/work/wt2" });
  fake.spaces = [{ id: "sp1", folder: PATH, tabs: [] }];
  fake.panes = [{ pane: "p1", cwd: "/work/wt2", tab: "tb9" }];
  const v = view(a, b), cx = fakeCx();
  v.confirm = "all";
  v.removeAll([a, b], cx);
  await flush();
  assert.equal(calls(REMOVE).length, 0);
  assert.deepEqual(fake.runs, []);
  assert.equal(v.wtError[PATH], "has a space");
  assert.equal(v.wtError["/work/wt2"], "open in a terminal");
});

test("a branch git keeps is reported", async () => {
  fake.exec = (cmd, args) => (args.includes("branch") ? { code: 1, stderr: "error: not fully merged\n" } : null);
  const v = view(), w = tree(), cx = fakeCx();
  await clickRemove(v, w, cx);
  await clickRemove(v, w, cx);
  assert.equal(fake.notices[0].title, "Kept branch feat");
});
