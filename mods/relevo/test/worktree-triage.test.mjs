// What the rows without a space offer, by what removing one would lose.
import "./fake/register.mjs";
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fake, resetFake, calls, theme } from "./fake/herdr.mjs";
import { fakeCx, find, flush, text } from "./fake/ui.mjs";
import { groupOf, whyOf, sizeOf } from "../lib/trees.js";

const { TreeViews } = await import("../inbox-trees.js");
const { removalCheck, treeState } = await import("../worktrees.js");

const NOW = 2_000_000_000, DAY = 86400, OLD = NOW - 30 * DAY;
const clean = { branch: "feat", locked: false, files: 0, unpushed: 0, unique: 0, ignored: [] };

test("groupOf: work counts first, whatever its age", () => {
  assert.equal(groupOf({ ...clean, files: 2 }, OLD, NOW), "work");
  assert.equal(groupOf({ ...clean, unpushed: 75 }, OLD, NOW), "work");
  assert.equal(groupOf({ ...clean, locked: true }, OLD, NOW), "work");
  assert.equal(groupOf({ ...clean, files: 2 }, NOW, NOW), "work");
});

test("groupOf: what can't be read is work, never safe", () => {
  assert.equal(groupOf({ unreadable: true }, OLD, NOW), "work");
  assert.equal(groupOf(undefined, OLD, NOW), "work");
});

test("groupOf: used within 7 days, or at an unknown time, is recent", () => {
  assert.equal(groupOf(clean, NOW - DAY, NOW), "recent");
  assert.equal(groupOf(clean, 0, NOW), "recent");
  assert.equal(groupOf(clean, NOW - 7 * DAY, NOW), "safe");
});

test("groupOf: commits outside main are pushed on a branch, and work when detached", () => {
  assert.equal(groupOf({ ...clean, unique: 3 }, OLD, NOW), "pushed");
  assert.equal(groupOf({ ...clean, unique: 3, branch: null }, OLD, NOW), "work");
  assert.equal(groupOf(clean, OLD, NOW), "safe");
});

test("whyOf and sizeOf say it in few words", () => {
  assert.equal(whyOf({ ...clean, files: 1, unpushed: 75 }), "1 file uncommitted · 75 commits not pushed");
  assert.equal(whyOf({ ...clean, unique: 3 }), "3 commits on GitHub");
  assert.equal(whyOf({ ...clean, unique: 1, branch: null }), "1 commit not in main");
  assert.equal(whyOf(clean), null);
  assert.equal(whyOf({ unreadable: true }), "could not check");
  assert.equal(sizeOf(4 * 1048576), "4.0 GB");
  assert.equal(sizeOf(2048), "2 MB");
  assert.equal(sizeOf(0), "");
});

const row = (name, at = OLD) => ({ main: "/w/app", path: `/w/${name}`, branch: name, repo: "app", name, merged: false, open: false, at });

function view(states) {
  const v = new TreeViews(), worktrees = Object.keys(states).map((n) => row(n));
  Object.assign(v, {
    worktrees, removing: new Set(), gone: new Set(), wtError: {}, expanded: { loose: true }, confirm: null, selected: () => false,
    treeStates: new Map(Object.entries(states).map(([n, state]) => [`/w/${n}`, { at: OLD, state }])),
  });
  return { v, worktrees };
}

beforeEach(() => {
  resetFake();
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: NOW * 1000 });
});

const draw = (v, worktrees) => ({ items: v.treeGroups(theme(), worktrees).filter(Boolean), handlers: {}, key: null });

test("only rows with nothing to lose or already on GitHub offer Remove", () => {
  const { v, worktrees } = view({
    gone: clean, pushed: { ...clean, unique: 2 }, dirty: { ...clean, files: 3 }, ahead: { ...clean, unpushed: 1 }, broken: { unreadable: true },
  });
  const ui = draw(v, worktrees);
  assert.ok(find(ui, "wt-rm-/w/gone"));
  assert.ok(find(ui, "wt-rm-/w/pushed"));
  for (const n of ["dirty", "ahead", "broken"]) {
    assert.ok(find(ui, `wt-/w/${n}`), n);
    assert.equal(find(ui, `wt-rm-/w/${n}`), null, n);
  }
  const shown = text(ui);
  assert.match(shown, /Nothing to lose/);
  assert.match(shown, /Pushed, not merged/);
  assert.match(shown, /With work/);
  assert.match(shown, /3 files uncommitted/);
  assert.match(shown, /could not check/);
});

test("a row not read yet offers nothing", () => {
  const v = new TreeViews(), worktrees = [row("new")];
  Object.assign(v, { worktrees, removing: new Set(), gone: new Set(), wtError: {}, expanded: { loose: true }, confirm: null, selected: () => false, treeStates: new Map() });
  const ui = draw(v, worktrees);
  assert.match(text(ui), /Checking/);
  assert.equal(find(ui, "wt-rm-/w/new"), null);
});

test("recent rows fold, and the keyboard doesn't reach them until they show", () => {
  const { v, worktrees } = view({ used: clean, gone: clean });
  worktrees[0].at = NOW - DAY;
  v.treeStates.get("/w/used").at = worktrees[0].at;
  const ui = draw(v, worktrees);
  assert.match(text(ui), /1 recent/);
  assert.equal(find(ui, "wt-/w/used"), null);
  assert.deepEqual(v.looseRows(worktrees).map((w) => w.name), ["gone"]);
  v.expanded["loose-recent"] = true;
  assert.ok(find(draw(v, worktrees), "wt-/w/used"));
  assert.equal(v.looseRows(worktrees).length, 2);
});

test("Remove all takes only rows with no ignored files to keep, and asks first", async () => {
  const { v, worktrees } = view({ a: clean, b: clean, kept: { ...clean, ignored: ["output"] } });
  const ui = draw(v, worktrees), cx = fakeCx();
  const all = find(ui, "wt-rm-all-safe");
  assert.match(text(all), /Remove 2/);
  all.handlers.on_click({}, cx);
  assert.equal(v.confirm, "all-safe");
  assert.equal(calls(/worktree remove/).length, 0);
});

test("opening the section reads each state once, and again only for one used since", async () => {
  const { v } = view({});
  v.worktrees = [row("a")];
  fake.exec = () => ({ code: 0, stdout: "" });
  const cx = fakeCx();
  v.loadTreeStates(cx);
  await flush();
  const first = calls(/status --porcelain/).length;
  assert.equal(first, 1);
  v.loadTreeStates(cx);
  await flush();
  assert.equal(calls(/status --porcelain/).length, first);
  v.worktrees = [row("a", NOW)];
  v.loadTreeStates(cx);
  await flush();
  assert.equal(calls(/status --porcelain/).length, first + 1);
});

// A worktree off a clone with a real origin.
function realTree(t) {
  mock.timers.reset();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "relevo-triage-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" });
  const origin = join(root, "origin.git"), main = join(root, "main"), path = join(root, "wt");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git(root, "clone", "-q", origin, main);
  git(main, "checkout", "-q", "-b", "main");
  writeFileSync(join(main, "a.txt"), "a\n");
  git(main, "add", ".");
  git(main, "commit", "-qm", "i");
  git(main, "push", "-q", "-u", "origin", "main");
  git(main, "worktree", "add", "-q", path, "-b", "feat");
  fake.exec = (cmd, args, options) => {
    const r = spawnSync(cmd, args, { cwd: options?.cwd, encoding: "utf8" });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const w = { main, path, branch: "feat" };
  const commit = (name) => {
    writeFileSync(join(path, name), "x\n");
    git(path, "add", ".");
    git(path, "commit", "-qm", name);
  };
  return { w, path, commit, git: (...args) => git(path, ...args), originGit: (...args) => git(origin, ...args) };
}
const later = () => {
  const at = Date.now() + 30 * DAY * 1000;
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date"], now: at });
};

test("real git: state counts changes, unpushed commits and commits outside main", async (t) => {
  const { w, path, commit, git } = realTree(t);
  assert.deepEqual(await treeState(w), { ...clean, files: 0 });
  writeFileSync(join(path, "new.txt"), "x");
  assert.equal((await treeState(w)).files, 1);
  rmSync(join(path, "new.txt"));
  commit("b.txt");
  let s = await treeState(w);
  assert.equal(s.unpushed, 1);
  assert.equal(s.unique, 1);
  git("push", "-q", "origin", "feat");
  s = await treeState(w);
  assert.equal(s.unpushed, 0);
  assert.equal(s.unique, 1);
});

test("real git: a clone with no origin can't be read, so it can't be removed", async (t) => {
  const { path, git } = realTree(t);
  git("remote", "remove", "origin");
  assert.deepEqual(await treeState({ main: join(path, "..", "nope"), path, branch: "feat" }), { unreadable: true });
});

test("real git: Remove stops when the row changed since it was drawn", async (t) => {
  const { w, path } = realTree(t);
  later();
  assert.equal((await removalCheck({ ...w, group: "safe" })).error, undefined);
  writeFileSync(join(path, "new.txt"), "x");
  assert.ok((await removalCheck({ ...w, group: "safe" })).error);
  rmSync(join(path, "new.txt"));
  mock.timers.reset();
  assert.equal((await removalCheck({ ...w, group: "safe" })).error, "changed, look again");
});

test("real git: pushed commits need GitHub to still have them", async (t) => {
  const { w, commit, git, originGit } = realTree(t);
  commit("b.txt");
  git("push", "-q", "origin", "feat");
  later();
  assert.equal((await removalCheck({ ...w, group: "pushed" })).error, undefined);
  // The remote branch goes, while the local ref still says it's there.
  originGit("update-ref", "-d", "refs/heads/feat");
  assert.equal((await removalCheck({ ...w, group: "pushed" })).error, "not on GitHub anymore");
});
