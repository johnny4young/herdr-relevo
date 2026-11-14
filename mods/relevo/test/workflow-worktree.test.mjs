import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitReviewedTree, commitWorktree, copyListed, openPullRequest, prepareWorktree, removeRunWorktree, runSlug, snapshotTree, worktreePath, worktreeStatus } from '../runtime/worktree.mjs';

function repo() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-wt-'))), root = path.join(base, 'app'), home = path.join(base, 'home');
  fs.mkdirSync(root); fs.mkdirSync(home);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q'); git('config', 'user.email', 't@example.invalid'); git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(root, '.gitignore'), '.env\nnode_modules/\n'); fs.writeFileSync(path.join(root, 'README.md'), 'app\n');
  fs.writeFileSync(path.join(root, '.worktreeinclude'), '.env\n'); git('add', '.'); git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=local\n'); fs.mkdirSync(path.join(root, 'node_modules')); fs.writeFileSync(path.join(root, 'node_modules', 'x'), 'x');
  return { base, root, home };
}

test('a run worktree gets its own branch from HEAD under Herdr worktrees and copies listed ignored files', async (t) => {
  const { base, root, home } = repo(); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const result = await prepareWorktree({ root, title: 'Fix the search filter!', home });
  assert.match(result.branch, /^run\/fix-the-search-filter-[0-9a-f]{6}$/);
  assert.equal(result.path, fs.realpathSync(worktreePath(root, result.branch.slice(4), home)));
  assert.equal(fs.readFileSync(path.join(result.path, '.env'), 'utf8'), 'TOKEN=local\n');
  assert.equal(fs.existsSync(path.join(result.path, 'node_modules')), false, 'only listed files follow');
  assert.equal(result.copied, 1); assert.equal(result.base, root);
  assert.equal(execFileSync('git', ['-C', result.path, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), result.branch);
});

test('a run worktree needs the repository root and names itself safely', async (t) => {
  const { base, root, home } = repo(); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  await assert.rejects(prepareWorktree({ root: path.join(root, 'src'), title: 'x', home }), /repository root/);
  assert.match(runSlug('../../etc/passwd'), /^etc-passwd-[0-9a-f]{6}$/);
  assert.match(runSlug(''), /^run-[0-9a-f]{6}$/);
});

test('an accepted run commits, opens a draft PR on its branch and removes its worktree but keeps a branch with work', async (t) => {
  const { base, root, home } = repo(); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const remote = path.join(base, 'remote.git'); execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote]);
  const wt = await prepareWorktree({ root, title: 'Add a note', home });
  assert.match(wt.baseCommit, /^[0-9a-f]{40}$/);
  assert.deepEqual(await worktreeStatus(wt), { exists: true, dirty: false, ahead: 0 });
  assert.equal(await commitWorktree(wt, 'Add a note', 'Body'), null, 'nothing to commit');
  fs.writeFileSync(path.join(wt.path, 'NOTE.md'), 'note\n');
  const sha = await commitWorktree(wt, 'Add a note', 'Body');
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(execFileSync('git', ['-C', wt.path, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim(), 'Add a note');
  assert.equal(fs.existsSync(path.join(wt.path, '.env')), true);
  assert.doesNotMatch(execFileSync('git', ['-C', wt.path, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' }), /\.env/);
  const calls = [];
  const url = await openPullRequest(wt, 'Add a note', 'Body', async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: 'https://github.com/o/r/pull/7\n' }; });
  assert.equal(url, 'https://github.com/o/r/pull/7');
  assert.deepEqual(calls[0].slice(0, 6), ['gh', 'pr', 'create', '--draft', '--head', wt.branch]);
  assert.match(execFileSync('git', ['-C', remote, 'branch'], { encoding: 'utf8' }), new RegExp(wt.branch.replace('/', '\\/')));
  assert.deepEqual(await removeRunWorktree(wt), { removed: true, branchDeleted: false });
  assert.equal(fs.existsSync(wt.path), false);
});

test('removing an empty run deletes its branch and uncommitted work is never removed', async (t) => {
  const { base, root, home } = repo(); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const empty = await prepareWorktree({ root, title: 'Nothing', home });
  assert.deepEqual(await removeRunWorktree(empty), { removed: true, branchDeleted: true });
  assert.doesNotMatch(execFileSync('git', ['-C', root, 'branch'], { encoding: 'utf8' }), /run\/nothing/);
  const dirty = await prepareWorktree({ root, title: 'Dirty', home });
  fs.writeFileSync(path.join(dirty.path, 'x.txt'), 'x');
  await assert.rejects(removeRunWorktree(dirty), /uncommitted/);
  await assert.rejects(openPullRequest(dirty, 't', 'b', async () => ({ stdout: '' })), /Commit the worktree/);
});

test('a draft PR without an origin remote says so in one line', async (t) => {
  const { base, root, home } = repo(); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const wt = await prepareWorktree({ root, title: 'No remote', home });
  fs.writeFileSync(path.join(wt.path, 'N.md'), 'n\n'); await commitWorktree(wt, 'No remote', '');
  await assert.rejects(openPullRequest(wt, 't', 'b', async () => ({ stdout: '' })), /^Error: This repository has no origin remote/);
});

test('a listed file never lands outside the worktree through .. or a symlinked directory', (t) => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'relevo-copy-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // dest sits one level deeper than root, so ".." names a different, missing file on each side.
  const root = path.join(base, 'root'), dest = path.join(base, 'deep', 'dest'), outside = path.join(base, 'outside');
  for (const dir of [root, dest, outside, path.join(root, 'link', 'sub'), path.join(root, 'ok')]) fs.mkdirSync(dir, { recursive: true });
  for (const rel of ['link/.env', 'link/sub/.env', 'ok/.env']) fs.writeFileSync(path.join(root, rel), rel);
  fs.writeFileSync(path.join(base, 'escape'), 'e');
  fs.symlinkSync(outside, path.join(dest, 'link'));
  fs.symlinkSync(path.join(base, 'missing'), path.join(dest, 'dangling'));
  const copied = copyListed(root, dest, ['link/.env', 'link/sub/.env', '../escape', 'dangling/x', 'ok/.env']);
  assert.equal(copied, 1);
  assert.equal(fs.readFileSync(path.join(dest, 'ok', '.env'), 'utf8'), 'ok/.env');
  assert.deepEqual(fs.readdirSync(outside), [], 'no file or directory created through the symlink');
  assert.equal(fs.existsSync(path.join(base, 'missing')), false);
  assert.equal(fs.existsSync(path.join(base, 'deep', 'escape')), false, '".." stays inside');
});

test('the reviewed tree is what gets committed, and only run worktrees can be removed', async (t) => {
  const { base, root, home } = repo(); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const wt = await prepareWorktree({ root, title: 'Tree', home });
  fs.writeFileSync(path.join(wt.path, 'A.md'), 'a\n');
  const tree = await snapshotTree(wt.path);
  fs.writeFileSync(path.join(wt.path, 'B.md'), 'b\n');
  const sha = await commitReviewedTree(wt, tree, 'Tree', '');
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(execFileSync('git', ['-C', wt.path, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' }).trim(), 'A.md');
  assert.equal(execFileSync('git', ['-C', wt.path, 'status', '--porcelain'], { encoding: 'utf8' }), '?? B.md\n');
  assert.equal(await commitReviewedTree(wt, sha && execFileSync('git', ['-C', wt.path, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(), 'Again', ''), null);
  await assert.rejects(removeRunWorktree({ ...wt, path: root, branch: 'main' }), /uncommitted|not a run worktree/);
  fs.rmSync(path.join(wt.path, 'B.md'));
  await assert.rejects(removeRunWorktree({ ...wt, branch: 'main' }), /not a run worktree/);
});

test("a run worktree whose .git file an agent rewrote is still read through its own folder, and nothing it names runs", async (t) => {
  const { trustedEnv, worktreeStatus, snapshotTree } = await import("../runtime/worktree.mjs");
  const { fingerprint } = await import("../runtime/evidence.mjs");
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relevo-trust-"))); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, "repo"), wtPath = path.join(base, "wt"), marker = path.join(base, "ran");
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  fs.mkdirSync(repo); git(repo, "init", "-q"); git(repo, "config", "user.email", "t@e.invalid"); git(repo, "config", "user.name", "T");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "i");
  git(repo, "worktree", "add", "-q", "-b", "run/trust-1", wtPath);
  const wt = { path: wtPath, base: repo, branch: "run/trust-1", baseCommit: git(repo, "rev-parse", "HEAD").trim() };
  const honest = await fingerprint(wtPath, await trustedEnv(wt));
  // The agent's own git folder: a config that runs a program on status, diff and add.
  const fake = path.join(wtPath, "fake");
  fs.cpSync(path.join(repo, ".git"), fake, { recursive: true });
  fs.appendFileSync(path.join(fake, "config"), `[core]\n\tfsmonitor = touch ${marker}\n[filter \"evil\"]\n\tclean = touch ${marker}; cat\n`);
  fs.writeFileSync(path.join(wtPath, ".gitattributes"), "*.txt filter=evil\n");
  fs.writeFileSync(path.join(wtPath, ".git"), `gitdir: ${fake}\n`);
  fs.writeFileSync(path.join(wtPath, "a.txt"), "b\n");
  const env = await trustedEnv(wt);
  assert.equal(env.GIT_DIR, path.join(repo, ".git", "worktrees", "wt"));
  assert.notEqual(await fingerprint(wtPath, env), honest);
  assert.equal((await worktreeStatus(wt)).dirty, true);
  assert.match(await snapshotTree(wtPath, env), /^[0-9a-f]{40}$/);
  assert.equal(fs.existsSync(marker), false);
  // Without the pinned folder git would have followed the agent's file.
  execFileSync("git", ["-C", wtPath, "status", "--porcelain"]);
  assert.equal(fs.existsSync(marker), true);
});

test("a folder that isn't a worktree of its base is refused", async (t) => {
  const { trustedEnv } = await import("../runtime/worktree.mjs");
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relevo-trust-"))); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, "repo"), other = path.join(base, "other");
  fs.mkdirSync(repo); fs.mkdirSync(other); execFileSync("git", ["-C", repo, "init", "-q"]);
  await assert.rejects(trustedEnv({ path: other, base: repo }), /not registered in its repository/);
});
