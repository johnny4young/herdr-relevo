import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { WORKTREES } from '../lib/run-folder.js';

const execFile = promisify(nodeExecFile);
const git = (cwd, args, env) => execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) });
// A checkout an agent writes to must not make git start a program of its own.
// Nested repositories keep their own config, and git starts itself inside them to look: submodules are left alone.
export const QUIET = ['-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'diff.ignoreSubmodules=all',
  '-c', 'submodule.recurse=false', '-c', 'status.submoduleSummary=false'];

// A run's agents can rewrite its worktree, the `.git` file in it too, and point it at a config of theirs. Git reads the
// worktree's own folder, found from the base repository, which the agents can't write.
export async function trustedEnv(wt) {
  const common = path.resolve(wt.base, (await git(wt.base, ['rev-parse', '--git-common-dir'])).stdout.trim());
  const want = fs.realpathSync(wt.path), admin = path.join(common, 'worktrees');
  if (fs.realpathSync(path.dirname(common)) === want && path.basename(common) === '.git') return { GIT_DIR: common, GIT_WORK_TREE: want };
  for (const name of fs.existsSync(admin) ? fs.readdirSync(admin) : []) {
    try {
      const pointer = fs.readFileSync(path.join(admin, name, 'gitdir'), 'utf8').trim();
      if (fs.realpathSync(path.dirname(pointer)) === want) return { GIT_DIR: path.join(admin, name), GIT_WORK_TREE: want };
    } catch { /* another worktree, gone */ }
  }
  throw Error("This run's worktree is not registered in its repository; inspect it before continuing");
}
const wtGit = async (wt, args, extra) => git(wt.path, [...QUIET, ...args], { ...(await trustedEnv(wt)), ...extra });

export const RUN_BRANCH = /^run\/[a-z0-9][a-z0-9-]{0,80}$/;
export const BASE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;
const SHA = /^[0-9a-f]{40}$/, TASK_ID = /^[A-Za-z0-9-]{1,100}$/;

export const runSlug = (title) => {
  const words = String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return `${words || 'run'}-${randomUUID().slice(0, 6)}`;
};

// Same place Herdr's worktree mod uses, so the sidebar nests it under the repo.
export function worktreePath(root, slug, home = os.homedir()) {
  return path.join(home, ...WORKTREES, path.basename(root), slug);
}

// Ignored files the repo lists in .worktreeinclude (an .env, say) follow the run, like cwt does.
async function copyIncluded(root, dest) {
  const list = path.join(root, '.worktreeinclude');
  if (!fs.existsSync(list)) return 0;
  const { stdout } = await git(root, ['ls-files', '-z', '--others', '--ignored', `--exclude-from=${list}`]);
  return copyListed(root, dest, stdout.split('\0').filter((name) => name && !name.endsWith('/')));
}

// A listed path never lands outside dest, through ".." or a symlinked directory inside it.
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

export function copyListed(root, dest, rels) {
  const realDest = fs.realpathSync(dest), within = (p) => p === realDest || p.startsWith(`${realDest}${path.sep}`);
  // The nearest existing ancestor is resolved before mkdir, which would otherwise follow a symlink out.
  const resolvedAncestor = (p) => {
    while (!fs.existsSync(p) && !isLink(p)) { if (p === realDest) return null; p = path.dirname(p); }
    try { return fs.realpathSync(p); } catch { return null; }
  };
  let copied = 0;
  for (const rel of rels) {
    const target = path.resolve(realDest, rel);
    if (!within(path.dirname(target)) || target === realDest) continue;
    try { fs.lstatSync(target); continue; } catch { /* free to copy */ }
    const ancestor = resolvedAncestor(path.dirname(target));
    if (!ancestor || !within(ancestor)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (!within(fs.realpathSync(path.dirname(target)))) continue;
    fs.cpSync(path.join(root, rel), target, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    copied++;
  }
  return copied;
}

// `pr` { headRef }: the run starts from that pull request's branch on origin, to fix it, instead of from HEAD.
export async function prepareWorktree({ root, title, home, pr = null }) {
  if (!path.isAbsolute(root ?? '')) throw Error('Choose a repository');
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim();
  if (fs.realpathSync(top) !== fs.realpathSync(root)) throw Error('Choose the repository root');
  const slug = runSlug(title), branch = `run/${slug}`, dest = worktreePath(top, slug, home);
  if (fs.existsSync(dest)) throw Error('A worktree already exists for this run');
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  if (pr && (!BASE_BRANCH.test(pr.headRef ?? '') || pr.headRef.includes('..'))) throw Error("This pull request's branch can't be used");
  if (pr) await git(top, [...QUIET, 'fetch', '--no-tags', 'origin', `refs/heads/${pr.headRef}`]);
  const baseCommit = (await git(top, ['rev-parse', pr ? 'FETCH_HEAD' : 'HEAD'])).stdout.trim();
  const current = (await git(top, ['branch', '--show-current'])).stdout.trim(), baseBranch = pr ? pr.headRef : BASE_BRANCH.test(current) ? current : '';
  await git(top, ['worktree', 'add', '-b', branch, dest, baseCommit]);
  const copied = await copyIncluded(top, dest);
  return { path: fs.realpathSync(dest), branch, base: top, baseCommit, baseBranch, copied, ...(pr ? { prHead: pr.headRef } : {}) };
}

// A pull request's exact head in a detached worktree of its own, for a review that changes nothing. Forks too.
export async function prepareReview({ root, pr, who, home }) {
  if (!path.isAbsolute(root ?? '')) throw Error('Choose a repository');
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim();
  if (fs.realpathSync(top) !== fs.realpathSync(root)) throw Error('Choose the repository root');
  if (!Number.isInteger(pr?.number) || pr.number < 1 || !SHA.test(pr.head ?? '') || !BASE_BRANCH.test(pr.base ?? '') || pr.base.includes('..')
    || !/^[a-z]{1,20}$/.test(who ?? '')) throw Error("This pull request can't be reviewed here");
  const ref = `refs/relevo/pr/${pr.number}`, baseRef = `refs/remotes/origin/${pr.base}`;
  await git(top, [...QUIET, 'fetch', '--no-tags', 'origin', `+refs/pull/${pr.number}/head:${ref}`, `+refs/heads/${pr.base}:${baseRef}`]);
  if ((await git(top, ['rev-parse', ref])).stdout.trim() !== pr.head) throw Error('The pull request has new commits; refresh and review again');
  const base = (await git(top, ['merge-base', baseRef, pr.head])).stdout.trim();
  const dest = worktreePath(top, `review-${pr.number}-${pr.head.slice(0, 7)}-${who}`, home);
  if (fs.existsSync(dest)) {
    if ((await git(dest, ['rev-parse', 'HEAD'])).stdout.trim() !== pr.head) throw Error(`${dest} holds other work; remove it first`);
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    await git(top, ['worktree', 'add', '--detach', dest, pr.head]);
    if (!pr.untrusted) await copyIncluded(top, dest);
  }
  return { path: fs.realpathSync(dest), head: pr.head, base };
}

const ahead = async (wt) => wt.baseCommit ? Number((await wtGit(wt, ['rev-list', '--count', `${wt.baseCommit}..HEAD`])).stdout.trim()) : null;

export async function worktreeStatus(wt) {
  if (!wt?.path || !fs.existsSync(wt.path)) return { exists: false };
  const dirty = Boolean((await wtGit(wt, ['status', '--porcelain', '--ignore-submodules=all'])).stdout.trim());
  const origin = await wtGit(wt, ['remote', 'get-url', 'origin']).then(() => true, () => false);
  return { exists: true, dirty, ahead: await ahead(wt), origin };
}

// The accepted result becomes one commit on the run branch; ignored files (.env) stay out.
// `git add` looks inside a nested repository whatever the config says, so those (submodules, or one an agent made)
// stay as HEAD has them.
async function nestedRepos(dir, env) {
  const linked = (await git(dir, [...QUIET, 'ls-tree', '-r', '-z', 'HEAD'], env)).stdout.split('\0')
    .filter((line) => line.startsWith('160000 ')).map((line) => line.slice(line.indexOf('\t') + 1));
  // Without --directory git names each untracked repository at any depth as `path/`, and goes no further into it.
  const made = (await git(dir, [...QUIET, 'ls-files', '-z', '--others', '--exclude-standard'], env)).stdout.split('\0')
    .filter((name) => name.endsWith('/') && fs.existsSync(path.join(dir, name, '.git'))).map((name) => name.slice(0, -1));
  return [...new Set([...linked, ...made])];
}

export async function snapshotTree(dir, env, indexDir = null) {
  const own = indexDir ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-index-'));
  const index = path.join(own ?? indexDir, `relevo-index-${randomUUID()}`);
  try {
    const skip = (await nestedRepos(dir, env)).map((name) => `:(top,literal,exclude)${name}`);
    await git(dir, [...QUIET, 'read-tree', 'HEAD'], { ...env, GIT_INDEX_FILE: index });
    await git(dir, [...QUIET, 'add', '-A', '--', '.', ...skip], { ...env, GIT_INDEX_FILE: index });
    return (await git(dir, [...QUIET, 'write-tree'], { ...env, GIT_INDEX_FILE: index })).stdout.trim();
  } finally {
    fs.rmSync(index, { force: true });
    fs.rmSync(`${index}.lock`, { force: true });
    if (own) fs.rmSync(own, { recursive: true, force: true });
  }
}

// An implementer attempt's tree, kept as a commit on a ref of its own in the base repository. The run branch, HEAD
// and the agents' index stay as they are, no hook runs, and nothing pushes it.
export const ATTEMPT_REF = /^refs\/relevo\/attempts\/[A-Za-z0-9-]{1,100}\/[1-9][0-9]{0,3}$/;
const SNAPSHOT_AUTHOR = { GIT_AUTHOR_NAME: 'Relevo', GIT_AUTHOR_EMAIL: 'relevo@localhost', GIT_COMMITTER_NAME: 'Relevo', GIT_COMMITTER_EMAIL: 'relevo@localhost' };
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

export async function snapshotAttempt(wt, { taskId, number, tree, at = Date.now() }) {
  const ref = `refs/relevo/attempts/${taskId}/${number}`;
  if (!ATTEMPT_REF.test(ref) || !SHA.test(tree ?? '')) throw Error('This attempt cannot be named as a snapshot');
  const when = new Date(at).toISOString(), head = (await wtGit(wt, ['rev-parse', 'HEAD'])).stdout.trim();
  const commit = await commitTree(wt, tree, head, [`Relevo attempt ${number}`], { ...SNAPSHOT_AUTHOR, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
  await wtGit(wt, [...NO_HOOKS, 'update-ref', '--no-deref', ref, commit]);
  return { ref, commit, at: when };
}

// One snapshot ref, only while it still points at that commit.
export async function dropAttemptRef(base, { ref, commit }) {
  if (!ATTEMPT_REF.test(ref ?? '') || !SHA.test(commit ?? '')) return;
  await git(base, [...NO_HOOKS, 'update-ref', '--no-deref', '-d', ref, commit]);
}

// Every snapshot ref of a task goes; the commits go with git's next gc.
export async function dropAttemptRefs(base, taskId) {
  if (!TASK_ID.test(taskId ?? '') || !fs.existsSync(base ?? '')) return 0;
  const refs = (await git(base, ['for-each-ref', '--format=%(refname)', `refs/relevo/attempts/${taskId}/`])).stdout.split('\n').filter((ref) => ATTEMPT_REF.test(ref));
  for (const ref of refs) await git(base, [...NO_HOOKS, 'update-ref', '--no-deref', '-d', ref]);
  return refs.length;
}

const MAX_DIFF_FILES = 500;
// Reads objects only: no checkout, no diff program.
const commitDiff = async (base, from, to, format) => {
  if (!SHA.test(from ?? '') || !SHA.test(to ?? '')) throw Error('Two commits are needed to compare');
  return (await git(base, ['--no-optional-locks', ...QUIET, 'diff', ...format, '--no-renames', '--no-ext-diff', '--no-textconv', from, to, '--'])).stdout;
};

// How many files changed and lines were added and removed between two commits.
export async function diffCounts(base, from, to) {
  const text = await commitDiff(base, from, to, ['--shortstat']), count = (word) => Number(new RegExp(`(\\d+) ${word}`).exec(text)?.[1] ?? 0);
  return { files: count('file'), added: count('insertion'), removed: count('deletion') };
}

// The same, with each file.
export async function diffStat(base, from, to) {
  const list = (await commitDiff(base, from, to, ['--numstat', '-z'])).split('\0').filter(Boolean).map((line) => {
    const [added, removed, ...name] = line.split('\t'), binary = added === '-';
    return { path: name.join('\t'), added: binary ? 0 : Number(added), removed: binary ? 0 : Number(removed), ...(binary ? { binary: true } : {}) };
  });
  return { files: list.length, added: list.reduce((n, f) => n + f.added, 0), removed: list.reduce((n, f) => n + f.removed, 0),
    list: list.slice(0, MAX_DIFF_FILES), truncated: list.length > MAX_DIFF_FILES };
}

// One attempt against an earlier one, or against where the run started when `from` is missing.
// A snapshot counts only while its ref still points at the recorded commit.
export async function attemptDiff(wt, from, to) {
  const kept = async (snapshot) => {
    const at = ATTEMPT_REF.test(snapshot?.ref ?? '') ? await git(wt.base, ['rev-parse', '--verify', '--quiet', `${snapshot.ref}^{commit}`]).then((r) => r.stdout.trim(), () => '') : '';
    if (!at || at !== snapshot.commit) throw Error('The snapshot of this attempt is no longer kept');
    return at;
  };
  const target = await kept(to);
  const start = from ? await kept(from) : SHA.test(wt.baseCommit ?? '') ? wt.baseCommit : (await git(wt.base, ['rev-parse', '--verify', '--quiet', `${target}^`])).stdout.trim();
  return { fromCommit: start, toCommit: target, ...(await diffStat(wt.base, start, target)) };
}

// What a run changed: from where it started to the accepted commit, else to the tree the reviewer saw, else to the
// last attempt's snapshot.
export async function taskDiff(wt, attempts = []) {
  const snapshot = [...attempts].reverse().find((attempt) => attempt.snapshot?.commit)?.snapshot;
  const to = [wt.commit, wt.reviewedTree, snapshot?.commit].find((sha) => SHA.test(sha ?? ''));
  if (!to || !SHA.test(wt.baseCommit ?? '')) throw Error('No change of this task is kept');
  return { fromCommit: wt.baseCommit, toCommit: to, ...(await diffStat(wt.base, wt.baseCommit, to)) };
}

// A commit of a tree made without `git commit`, so no commit hook runs and the worktree's index is not read.
const commitTree = async (wt, tree, parent, messages, env) =>
  (await wtGit(wt, ['commit-tree', tree, '-p', parent, ...messages.flatMap((message) => ['-m', message])], env)).stdout.trim();

// Commits the reviewed tree itself: later edits stay uncommitted and no hook runs.
export async function commitReviewedTree(wt, tree, title, body) {
  if (!RUN_BRANCH.test(wt.branch ?? '') || !SHA.test(tree ?? '')) throw Error('This run has no reviewed tree to commit');
  const head = (await wtGit(wt, ['rev-parse', 'HEAD'])).stdout.trim();
  if ((await wtGit(wt, ['rev-parse', 'HEAD^{tree}'])).stdout.trim() === tree) return null;
  const sha = await commitTree(wt, tree, head, body ? [title, body] : [title]);
  await wtGit(wt, ['update-ref', `refs/heads/${wt.branch}`, sha, head]);
  await wtGit(wt, ['reset', '-q']);
  return sha;
}

// Without a reviewed tree, the worktree as it stands, by the same path: no `git commit`, so no hook and no status run.
export async function commitWorktree(wt, title, body) {
  if (!(await worktreeStatus(wt)).dirty) return null;
  return commitReviewedTree(wt, await snapshotTree(wt.path, await trustedEnv(wt)), title, body);
}

export async function openPullRequest(wt, title, body, run = execFile) {
  const status = await worktreeStatus(wt);
  if (!status.exists || status.dirty) throw Error('Commit the worktree before opening a PR');
  if (status.ahead === 0) throw Error('The run branch has no commits to propose');
  if (!RUN_BRANCH.test(wt.branch ?? '')) throw Error('Only a run branch can be proposed');
  try { await wtGit(wt, ['remote', 'get-url', 'origin']); } catch { throw Error('This repository has no origin remote to push the run branch to'); }
  await wtGit(wt, ['push', '-u', 'origin', wt.branch]);
  const { stdout } = await run('gh', ['pr', 'create', '--draft', '--head', wt.branch, ...(BASE_BRANCH.test(wt.baseBranch ?? '') ? ['--base', wt.baseBranch] : []), '--title', title, '--body', body || title],
    { cwd: wt.path, encoding: 'utf8', timeout: 60000 });
  return stdout.trim().split('\n').at(-1);
}

// The accepted commits go onto the pull request's branch. Never forced: a branch that moved on GitHub refuses it.
export async function pushToPullRequest(wt) {
  const status = await worktreeStatus(wt);
  if (!status.exists || status.dirty) throw Error('Commit the worktree before pushing');
  if (status.ahead === 0) throw Error('The run branch has nothing to push');
  if (!BASE_BRANCH.test(wt.prHead ?? '') || wt.prHead.includes('..')) throw Error('This run fixes no pull request');
  try { await wtGit(wt, ['push', 'origin', `HEAD:refs/heads/${wt.prHead}`]); }
  catch (e) { throw Error(/rejected|non-fast-forward|fetch first/.test(String(e.stderr ?? e.message)) ? `${wt.prHead} moved on GitHub since the run started; nothing was pushed` : String(e.stderr || e.message).trim().slice(0, 300)); }
  return (await wtGit(wt, ['rev-parse', 'HEAD'])).stdout.trim();
}

// Uncommitted work is never removed; a branch with no commits of its own goes with its worktree.
export async function removeRunWorktree(wt, { discard = false } = {}) {
  const status = await worktreeStatus(wt);
  if (!status.exists) {
    let branchDeleted = false;
    if (wt?.base && fs.existsSync(wt.base)) {
      await git(wt.base, ['worktree', 'prune']).catch(() => null);
      if (RUN_BRANCH.test(wt.branch ?? '') && SHA.test(wt.baseCommit ?? '')) {
        const count = await git(wt.base, ['rev-list', '--count', `${wt.baseCommit}..refs/heads/${wt.branch}`]).then((r) => Number(r.stdout.trim()), () => -1);
        if (count === 0) branchDeleted = await git(wt.base, ['branch', '-D', wt.branch]).then(() => true, () => false);
      }
    }
    return { removed: false, branchDeleted };
  }
  if (status.dirty && !discard) throw Error('The worktree has uncommitted changes');
  const listed = (await git(wt.base, ['worktree', 'list', '--porcelain'])).stdout.split('\n').includes(`worktree ${wt.path}`);
  if (!RUN_BRANCH.test(wt.branch ?? '') || !listed) throw Error('This is not a run worktree of its repository');
  await git(wt.base, ['worktree', 'remove', ...(discard ? ['--force'] : []), wt.path]);
  const drop = status.ahead === 0;
  if (drop) await git(wt.base, ['branch', '-D', wt.branch]);
  return { removed: true, branchDeleted: drop };
}
