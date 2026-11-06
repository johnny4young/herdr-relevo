// What the rows without a space offer, by what removing one would lose.
import "./fake/register.mjs";
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fake, resetFake, calls, theme } from "./fake/herdr.mjs";
import { fakeCx, find, flush, text } from "./fake/ui.mjs";
import { actionsOf, groupOf, whyOf, sizeOf } from "../lib/trees.js";
import { githubRepo, withoutLogin } from "../lib/git.js";

const { TreeViews } = await import("../inbox-trees.js");
const { removalCheck, treeState } = await import("../worktrees.js");
const { backupsSize, deleteCheck, deleteWorktree, logRemoval, pushBackup, pushPlan, savedState, saveCommits, savePatch } = await import("../worktree-actions.js");
const settled = async () => { for (let i = 0; i < 12; i++) await flush(); };

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

test("groupOf: commits outside main that are pushed count as pushed, detached too", () => {
  assert.equal(groupOf({ ...clean, unique: 3 }, OLD, NOW), "pushed");
  assert.equal(groupOf({ ...clean, unique: 3, branch: null }, OLD, NOW), "pushed");
  assert.equal(groupOf(clean, OLD, NOW), "safe");
});

test("whyOf and sizeOf say it in few words", () => {
  assert.equal(whyOf({ ...clean, files: 1, unpushed: 75 }), "1 file uncommitted · 75 commits not pushed");
  assert.equal(whyOf({ ...clean, unique: 3 }), "3 commits on GitHub");
  assert.equal(whyOf({ ...clean, files: 2, patchSaved: true }), "2 files uncommitted, saved");
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
  writeFileSync(join(main, "bin.dat"), Buffer.from([9, 9, 0, 9]));
  git(main, "add", ".");
  git(main, "commit", "-qm", "i");
  git(main, "push", "-q", "-u", "origin", "main");
  git(main, "worktree", "add", "-q", path, "-b", "feat");
  fake.exec = (cmd, args, options) => {
    const r = spawnSync(cmd, args, { cwd: options?.cwd, encoding: "utf8" });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  fake.read = (file) => { try { return readFileSync(file, "utf8"); } catch { return null; } };
  const w = { main, path, branch: "feat" };
  const commit = (name) => {
    writeFileSync(join(path, name), "x\n");
    git(path, "add", ".");
    git(path, "commit", "-qm", name);
  };
  return { w, path, commit, git: (...args) => git(path, ...args), originGit: (...args) => git(origin, ...args), originPath: origin };
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

test("actionsOf: only what applies, and Delete only once idle", () => {
  const dirty = { ...clean, files: 2 }, ahead = { ...clean, unpushed: 3 };
  assert.deepEqual(actionsOf(dirty, OLD, NOW), ["patch", "delete"]);
  assert.deepEqual(actionsOf(ahead, OLD, NOW), ["commits", "push", "delete"]);
  assert.deepEqual(actionsOf({ ...dirty, patchSaved: true }, OLD, NOW), ["delete"]);
  assert.deepEqual(actionsOf({ ...ahead, commitsSaved: true }, OLD, NOW), ["push", "delete"]);
  assert.deepEqual(actionsOf(dirty, NOW - DAY, NOW), ["patch"]);
  assert.deepEqual(actionsOf({ ...dirty, locked: true }, OLD, NOW), ["patch"]);
  assert.deepEqual(actionsOf({ unreadable: true }, OLD, NOW), []);
});

test("a row with work opens its actions; nothing runs until a button is pressed", () => {
  const { v, worktrees } = view({ dirty: { ...clean, files: 3 } });
  const cx = fakeCx();
  const more = find(draw(v, worktrees), "wt-more-/w/dirty");
  assert.equal(find(draw(v, worktrees), "wt-delete-/w/dirty"), null);
  more.handlers.on_click({}, cx);
  const ui = draw(v, worktrees);
  assert.ok(find(ui, "wt-patch-/w/dirty"));
  assert.ok(find(ui, "wt-delete-/w/dirty"));
  assert.equal(find(ui, "wt-push-/w/dirty"), null);
  assert.equal(fake.execs.length, 0);
});

const rootOf = (w) => join(w.path, "..", "backups");
const write = (path, name, body = "x\n") => writeFileSync(join(path, name), body);
function dirtyTree(path, git) {
  write(path, "a.txt", "changed\n");
  write(path, "new.txt");
  writeFileSync(join(path, "bin.dat"), Buffer.from([0, 1, 2, 255, 254, 0]));
  git("add", "new.txt");
  write(path, "new.txt", "changed after staging\n");
  write(path, "untracked.txt");
}
const statusNow = (git) => git("--no-optional-locks", "-c", "diff.autoRefreshIndex=false", "status", "--porcelain");

test("real git: Save patch rebuilds the same files in a clean checkout, and leaves the worktree alone", async (t) => {
  const { w, path, git } = realTree(t);
  dirtyTree(path, git);
  const gitDir = git("rev-parse", "--absolute-git-dir").trim(), before = statSync(join(gitDir, "index")).mtimeMs, status = statusNow(git);
  const root = rootOf(w), r = await savePatch({ ...w, repo: "app" }, root);
  assert.equal(r.error, undefined);
  assert.equal(statusNow(git), status);
  assert.equal(statSync(join(gitDir, "index")).mtimeMs, before);
  assert.equal(statSync(r.file).mode & 0o777, 0o600);
  git("worktree", "add", "-q", "--detach", join(path, "..", "fresh"), "main");
  const fresh = join(path, "..", "fresh");
  execFileSync("git", ["apply", "--index", r.file], { cwd: fresh });
  assert.equal(readFileSync(join(fresh, "a.txt"), "utf8"), "changed\n");
  assert.equal(readFileSync(join(fresh, "new.txt"), "utf8"), "changed after staging\n");
  assert.deepEqual([...readFileSync(join(fresh, "bin.dat"))], [0, 1, 2, 255, 254, 0]);
  assert.ok(existsSync(join(fresh, "untracked.txt")));
});

test("real git: saved holds until something changes", async (t) => {
  const { w, path, git } = realTree(t), root = rootOf(w), tree = { ...w, repo: "app" };
  dirtyTree(path, git);
  await savePatch(tree, root);
  assert.equal((await savedState(tree, { files: 3, unpushed: 0 }, root)).patchSaved, true);
  write(path, "a.txt", "edited again\n");
  assert.equal((await savedState(tree, { files: 3, unpushed: 0 }, root)).patchSaved, false);
});

test("real git: Save patch refuses a repo it couldn't capture", async (t) => {
  const { w, path } = realTree(t), inner = join(path, "vendor");
  mkdirSync(inner);
  execFileSync("git", ["init", "-q"], { cwd: inner });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "i"], { cwd: inner });
  const r = await savePatch({ ...w, repo: "app" }, rootOf(w));
  assert.equal(r.error, "holds a repo");
  assert.equal(existsSync(rootOf(w)), false);
});

test("real git: Save commits restores them in a fresh clone, detached too", async (t) => {
  const { w, commit, git, originPath } = realTree(t), root = rootOf(w), tree = { ...w, repo: "app" };
  commit("b.txt");
  git("checkout", "-q", "--detach");
  const head = git("rev-parse", "HEAD").trim(), r = await saveCommits(tree, root);
  assert.equal(r.error, undefined);
  assert.equal(statSync(r.file).mode & 0o777, 0o600);
  const clone = join(w.path, "..", "clone");
  execFileSync("git", ["clone", "-q", originPath, clone]);
  execFileSync("git", ["fetch", "-q", r.file, "HEAD"], { cwd: clone });
  assert.equal(execFileSync("git", ["rev-parse", "FETCH_HEAD"], { cwd: clone, encoding: "utf8" }).trim(), head);
  assert.equal((await savedState(tree, { files: 0, unpushed: 1 }, root)).commitsSaved, true);
});

test("real git: Push backup lands on GitHub and never overwrites", async (t) => {
  const { w, commit, git, originGit } = realTree(t), tree = { ...w, repo: "app" };
  commit("b.txt");
  const head = git("rev-parse", "HEAD").trim();
  assert.deepEqual(await pushBackup(tree, head), { ref: "backup/wt" });
  assert.equal(originGit("rev-parse", "refs/heads/backup/wt").trim(), head);
  assert.equal(git("rev-list", "--count", "HEAD", "--not", "--remotes").trim(), "0");
  git("reset", "-q", "--hard", "HEAD~1");
  commit("other.txt");
  assert.ok((await pushBackup(tree, git("rev-parse", "HEAD").trim())).error);
  assert.equal(originGit("rev-parse", "refs/heads/backup/wt").trim(), head);
});

test("githubRepo: only github.com itself", () => {
  assert.equal(githubRepo("git@github.com:me/app.git"), "me/app");
  assert.equal(githubRepo("https://github.com/me/app"), "me/app");
  assert.equal(githubRepo("ssh://git@github.com/me/app.git"), "me/app");
  for (const url of ["https://evil.com/github.com/me/app", "git@github.com.evil.com:me/app", "https://github.com.evil.com/me/app", "https://github.com/me/app/x", "/srv/app.git", ""]) {
    assert.equal(githubRepo(url), null, url);
  }
});

const remoteIs = (url, seen = "PRIVATE") => (cmd, args) => {
  if (cmd === "gh") return seen === null ? { code: 1, stderr: "no" } : { code: 0, stdout: `${seen}\n` };
  return { code: 0, stdout: args.includes("rev-parse") ? "abc\n" : `${url}\n` };
};

test("pushPlan names where a push really goes, and only a known private repo isn't public", async () => {
  const w = { path: "/w/a", repo: "app" };
  fake.exec = remoteIs("https://github.com/me/app.git", null);
  assert.equal((await pushPlan(w, { unpushed: 75 })).text, "Publishes 75 commits to public me/app");
  fake.exec = remoteIs("https://github.com/me/app.git");
  const closed = await pushPlan(w, { unpushed: 1 });
  assert.equal(closed.text, "Pushes 1 commit to private me/app");
  assert.equal(closed.label, "Push");
  fake.exec = remoteIs("https://evil.com/github.com/me/app");
  const odd = await pushPlan(w, { unpushed: 1 });
  assert.equal(odd.text, "Publishes 1 commit to https://evil.com/github.com/me/app");
  assert.equal(calls(/^gh /).length, 2);
  assert.notEqual(odd.sign, closed.sign);
});

test("real git: the question follows the push URL, not the fetch URL", async (t) => {
  const { w, commit, git } = realTree(t);
  commit("b.txt");
  git("remote", "set-url", "--push", "origin", "https://elsewhere.example/x.git");
  assert.equal((await pushPlan({ ...w, repo: "app" }, { unpushed: 1 })).text, "Publishes 1 commit to https://elsewhere.example/x.git");
});

test("real git: a remote that pushes to several places isn't pushed", async (t) => {
  const { w, git, originPath } = realTree(t);
  git("remote", "set-url", "--add", "--push", "origin", originPath);
  git("remote", "set-url", "--add", "--push", "origin", "https://elsewhere.example/x.git");
  assert.equal((await pushPlan({ ...w, repo: "app" }, { unpushed: 1 })).error, "origin pushes to 2 places");
});

test("a token in a remote URL is never shown", async () => {
  fake.exec = remoteIs("https://me:s3cret@git.example.com/me/app.git");
  const plan = await pushPlan({ path: "/w/a", repo: "app" }, { unpushed: 1 });
  assert.equal(plan.text, "Publishes 1 commit to https://git.example.com/me/app.git");
  assert.equal(withoutLogin("fatal: unable to access 'https://x-token:abc@github.com/me/app/': 403"), "fatal: unable to access 'https://github.com/me/app/': 403");
  fake.exec = remoteIs("https://tok@github.com/me/app.git");
  assert.equal((await pushPlan({ path: "/w/a", repo: "app" }, { unpushed: 1 })).text, "Publishes 1 commit to https://github.com/me/app.git");
});

test("withoutLogin never makes a URL look like another host", () => {
  for (const url of ["https://evil.example?@github.com/x", "https://evil.example#@github.com/x", "https://evil.example\\@github.com/x", "https://evil.example/@github.com/x"]) {
    assert.equal(withoutLogin(url), url);
  }
  assert.equal(withoutLogin("https://a@b:c@git.example.com/x"), "https://git.example.com/x");
  assert.equal(githubRepo("https://evil.example?@github.com/me/app"), null);
});

test("real git: a second click pushes only what the question showed", async (t) => {
  const { w, path, commit, git, originGit } = realTree(t), tree = { ...w, repo: "app" };
  commit("b.txt");
  const v = new TreeViews(), cx = fakeCx();
  Object.assign(v, { worktrees: [tree], removing: new Set(), gone: new Set(), wtError: {}, expanded: { loose: true }, confirm: null, selected: () => false, treeStates: new Map() });
  v.askPush(tree, cx);
  await settled();
  const shown = git("rev-parse", "HEAD").trim();
  assert.equal(v.pushAsk.head, shown);
  assert.equal(spawnSync("git", ["rev-parse", "-q", "--verify", "refs/heads/backup/wt"], { cwd: join(path, "..", "origin.git") }).status, 1);
  commit("later.txt");
  v.askPush(tree, cx);
  await settled();
  assert.notEqual(v.pushAsk.head, shown);
  assert.equal(spawnSync("git", ["rev-parse", "-q", "--verify", "refs/heads/backup/wt"], { cwd: join(path, "..", "origin.git") }).status, 1);
  v.askPush(tree, cx);
  await settled();
  assert.equal(originGit("rev-parse", "refs/heads/backup/wt").trim(), git("rev-parse", "HEAD").trim());
  assert.equal(v.pushAsk, null);
});

test("real git: Delete says what goes, refuses what's in use, then takes everything", async (t) => {
  const { w, path, commit } = realTree(t), root = rootOf(w), tree = { ...w, repo: "app" };
  commit("b.txt");
  write(path, "a.txt", "changed\n");
  assert.equal((await deleteCheck(tree, root)).error, "used in the last 7 days");
  later();
  fake.panes = [{ pane: "p", cwd: path, status: "working" }];
  assert.equal((await deleteCheck(tree, root)).error, "an agent is working here");
  fake.panes = [];
  const check = await deleteCheck(tree, root);
  assert.match(check.text, /^Delete forever: 1 file uncommitted, 1 commit/);
  write(path, "a.txt", "changed more\n");
  assert.notEqual((await deleteCheck(tree, root)).sign, check.sign);
  assert.equal(await deleteWorktree(tree), null);
  assert.equal(existsSync(path), false);
  assert.equal(spawnSync("git", ["rev-parse", "-q", "--verify", "refs/heads/feat"], { cwd: w.main }).status, 1);
  assert.equal(spawnSync("git", ["rev-parse", "-q", "--verify", "refs/heads/main"], { cwd: w.main }).status, 0);
});

test("real git: Delete through the row logs what it said, and the commit restores the branch", async (t) => {
  const { w, path, commit, git } = realTree(t), root = rootOf(w), tree = { ...w, repo: "app" };
  commit("b.txt");
  const head = git("rev-parse", "HEAD").trim();
  later();
  const real = fake.exec;
  fake.exec = (cmd, args, options) => real(cmd, args.map((a) => (a === "/home/test/relevo-backups" ? root : a)), options);
  const { v } = view({});
  v.worktrees = [tree];
  const cx = fakeCx();
  v.askDelete(tree, cx);
  await settled();
  const shown = v.deleteAsk.text;
  v.askDelete(tree, cx);
  await settled();
  assert.equal(existsSync(path), false);
  const log = join(root, "deletions.log"), [entry, ...rest] = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rest, []);
  assert.deepEqual({ ...entry, at: null }, { at: null, said: shown, repo: "app", path, branch: "feat", head });
  assert.equal(statSync(log).mode & 0o777, 0o600);
  execFileSync("git", ["branch", "feat", entry.head], { cwd: w.main });
});

test("real git: the log only grows, keeps odd paths on one line and has no commit when none could be read", async (t) => {
  const { w } = realTree(t), root = join(rootOf(w), "new", "backups");
  const odd = { repo: "app", path: "/w/a \"b\"\n$(touch x)", branch: null };
  assert.equal(await logRemoval(odd, "", "Remove", root), true);
  assert.equal(await logRemoval({ ...odd, path: "/w/second", branch: "feat" }, "abc", "Delete: nothing unsaved", root), true);
  const lines = readFileSync(join(root, "deletions.log"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((e) => [e.path, e.branch, e.head]), [[odd.path, null, null], ["/w/second", "feat", "abc"]]);
  assert.equal(statSync(root).mode & 0o777, 0o700);
});

test("real git: once saved, Delete says nothing is lost; a later edit says otherwise", async (t) => {
  const { w, path, commit, git } = realTree(t), root = rootOf(w), tree = { ...w, repo: "app" };
  commit("b.txt");
  dirtyTree(path, git);
  await savePatch(tree, root);
  await saveCommits(tree, root);
  later();
  assert.match((await deleteCheck(tree, root)).text, /^Delete: nothing unsaved/);
  write(path, "a.txt", "again\n");
  assert.match((await deleteCheck(tree, root)).text, /^Delete forever: 4 files uncommitted/);
});

test("real git: Delete refuses a repo inside, a lock and an open space", async (t) => {
  const { w, path } = realTree(t), root = rootOf(w), tree = { ...w, repo: "app" };
  later();
  fake.spaces = [{ id: "s", folder: path, tabs: [] }];
  assert.equal((await deleteCheck(tree, root)).error, "close its space first");
  fake.spaces = [];
  execFileSync("git", ["worktree", "lock", path], { cwd: w.main });
  assert.equal((await deleteCheck(tree, root)).error, "locked");
  execFileSync("git", ["worktree", "unlock", path], { cwd: w.main });
  mkdirSync(join(path, "vendor"));
  execFileSync("git", ["init", "-q"], { cwd: join(path, "vendor") });
  assert.match((await deleteCheck(tree, root)).error, /^holds a repo: vendor/);
});

test("real git: a pushed detached worktree can be removed only while GitHub has that commit", async (t) => {
  const { w, commit, git, originGit } = realTree(t), tree = { ...w, branch: null, repo: "app" };
  commit("b.txt");
  git("checkout", "-q", "--detach");
  await pushBackup(tree, git("rev-parse", "HEAD").trim());
  later();
  assert.equal((await removalCheck({ ...tree, group: "pushed" })).error, undefined);
  originGit("update-ref", "-d", "refs/heads/backup/wt");
  assert.equal((await removalCheck({ ...tree, group: "pushed" })).error, "not on GitHub anymore");
});

test("the merged-PR lookup and a push read a remote URL the same way", () => {
  const repoOf = (url) => githubRepo(withoutLogin(url));
  assert.equal(repoOf("git@github.com:me/app.git\n"), "me/app");
  assert.equal(repoOf("https://tok@github.com/me/app.git"), "me/app");
  for (const url of ["https://notgithub.com/me/app", "https://github.com.evil.com/me/app", "https://evil.example?@github.com/me/app"]) {
    assert.equal(repoOf(url), null, url);
  }
});

test("a row's note has its own line, so the buttons can't cut it", () => {
  const v = Object.assign(new TreeViews(), { expanded: {}, removing: new Set(), gone: new Set(), wtError: {}, selected: () => false });
  const why = "12 files uncommitted, saved · 75 commits not pushed, saved";
  const drawn = v.treeRow(theme(), { path: "/w/a", repo: "app", branch: "feat", why });
  const holder = (node, id) => node.items?.find((c) => c?.key === id) ? node : node.items?.map((c) => holder(c, id)).find(Boolean);
  assert.ok(text(drawn).includes(why));
  assert.ok(!text(holder(drawn, "wt-open-/w/a")).includes(why));
});

test("backups: the folder's size, and no row before anything is saved", async () => {
  fake.exec = () => ({ code: 0, stdout: "2048\t/h/relevo-backups\n" });
  assert.equal(await backupsSize("/h/relevo-backups"), 2048);
  fake.exec = () => ({ code: 1, stderr: "no such file" });
  assert.equal(await backupsSize("/h/relevo-backups"), 0);
  const v = Object.assign(new TreeViews(), { expanded: {}, removing: new Set(), gone: new Set(), wtError: {} });
  assert.equal(v.treeGroups(theme(), []).length, 0);
  v.backupsKb = 2048;
  const rows = v.treeGroups(theme(), []);
  assert.equal(rows.length, 1);
  assert.match(text(rows[0]), /Backups.*2 MB.*Open/s);
});

test("a load asked for during another runs after it, for what's open now", async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  fake.exec = async (cmd, args) => {
    if (args.includes("cherry")) await held;
    return null;
  };
  const merged = { path: "/w/m", main: "/w", repo: "m", at: OLD, merged: true, dirty: true };
  const loose = { path: "/w/l", main: "/w", repo: "l", at: OLD, merged: false, open: false };
  const v = Object.assign(new TreeViews(), { worktrees: [merged, loose], expanded: {}, wtError: {} });
  const cx = fakeCx();
  v.loadTreeStates(cx);
  await settled();
  v.expanded.loose = true;
  v.loadTreeStates(cx);
  assert.ok(!v.treeStates?.has(loose.path));
  release();
  await settled();
  await settled();
  assert.ok(v.treeStates.has(loose.path));
});

test("a merged worktree used in the last day offers no Remove and says why", async () => {
  const v = Object.assign(new TreeViews(), { expanded: {}, removing: new Set(), gone: new Set(), wtError: {}, selected: () => false });
  const row = (at) => v.treeRow(theme(), { path: "/w/a", repo: "app", branch: "feat", merged: true, at });
  assert.equal(find(row(NOW - 3600), "wt-rm-/w/a"), null);
  assert.match(text(row(NOW - 3600)), /used 1h ago/);
  assert.equal(find(row(0), "wt-rm-/w/a"), null);
  assert.ok(find(row(NOW - DAY), "wt-rm-/w/a"));
  const clean = (at) => ({ path: `/w/${at}`, merged: true, at });
  assert.deepEqual(v.removable([clean(NOW - 3600), clean(NOW - DAY)]).map((w) => w.at), [NOW - DAY]);
  fake.exec = (cmd) => (cmd === "sh" ? { stdout: `/w/a\t${NOW - 3600}\n` } : null);
  assert.equal((await removalCheck({ path: "/w/a", main: "/w", merged: true })).error, "used in the last day");
});

test("a worktree in use says its age once, on the note", () => {
  const { v } = view({});
  const shown = text(v.treeRow(theme(), { ...row("a", NOW - 3600), merged: true }));
  assert.match(shown, /used 1h ago/);
  assert.equal(shown.match(/1h/g).length, 1, shown);
});

test("merged worktrees fold under one line with Remove all on it; one with uncommitted files stays out", () => {
  const v = Object.assign(new TreeViews(), {
    expanded: {}, removing: new Set(), gone: new Set(), wtError: {}, confirm: null, selected: () => false, backupsKb: 2048,
  });
  const merged = (name, more = {}) => ({ ...row(name), merged: true, ...more });
  const worktrees = [merged("a"), merged("b"), merged("dirty", { dirty: true })];
  let ui = draw(v, worktrees);
  assert.match(text(find(ui, "merged-trees")), /▸ 3 merged worktrees.*Remove 2/s);
  assert.equal(find(ui, "wt-/w/a"), null);
  assert.ok(find(ui, "wt-/w/dirty"));
  assert.doesNotMatch(text(ui), /Backups/);
  find(ui, "merged-trees").handlers.on_click({}, fakeCx());
  ui = draw(v, worktrees);
  assert.ok(find(ui, "wt-/w/a"));
  assert.match(text(ui), /Backups/);
  assert.deepEqual(fake.stored["relevo.inbox.folds"], { merged: true });
});
