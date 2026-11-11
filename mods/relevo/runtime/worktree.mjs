import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFile = promisify(nodeExecFile);
const git = (cwd, args, env) => execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) });

export const RUN_BRANCH = /^run\/[a-z0-9][a-z0-9-]{0,80}$/;
export const BASE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

export const runSlug = (title) => {
  const words = String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return `${words || 'run'}-${randomUUID().slice(0, 6)}`;
};

// Same place Herdr's worktree mod uses, so the sidebar nests it under the repo.
export function worktreePath(root, slug, home = os.homedir()) {
  return path.join(home, '.herdr', 'worktrees', path.basename(root), slug);
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

export async function prepareWorktree({ root, title, home }) {
  if (!path.isAbsolute(root ?? '')) throw Error('Choose a repository');
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).stdout.trim();
  if (fs.realpathSync(top) !== fs.realpathSync(root)) throw Error('Choose the repository root');
  const slug = runSlug(title), branch = `run/${slug}`, dest = worktreePath(top, slug, home);
  if (fs.existsSync(dest)) throw Error('A worktree already exists for this run');
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const baseCommit = (await git(top, ['rev-parse', 'HEAD'])).stdout.trim();
  const current = (await git(top, ['branch', '--show-current'])).stdout.trim(), baseBranch = BASE_BRANCH.test(current) ? current : '';
  await git(top, ['worktree', 'add', '-b', branch, dest, 'HEAD']);
  const copied = await copyIncluded(top, dest);
  return { path: fs.realpathSync(dest), branch, base: top, baseCommit, baseBranch, copied };
}

const ahead = async (wt) => wt.baseCommit ? Number((await git(wt.path, ['rev-list', '--count', `${wt.baseCommit}..HEAD`])).stdout.trim()) : null;

export async function worktreeStatus(wt) {
  if (!wt?.path || !fs.existsSync(wt.path)) return { exists: false };
  const dirty = Boolean((await git(wt.path, ['status', '--porcelain'])).stdout.trim());
  return { exists: true, dirty, ahead: await ahead(wt) };
}

// The accepted result becomes one commit on the run branch; ignored files (.env) stay out.
export async function snapshotTree(dir) {
  const index = path.join(os.tmpdir(), `relevo-index-${randomUUID()}`);
  try {
    await git(dir, ['read-tree', 'HEAD'], { GIT_INDEX_FILE: index });
    await git(dir, ['add', '-A'], { GIT_INDEX_FILE: index });
    return (await git(dir, ['write-tree'], { GIT_INDEX_FILE: index })).stdout.trim();
  } finally { fs.rmSync(index, { force: true }); }
}

// Commits the reviewed tree itself: later edits stay uncommitted and no hook runs.
export async function commitReviewedTree(wt, tree, title, body) {
  if (!RUN_BRANCH.test(wt.branch ?? '') || !/^[0-9a-f]{40}$/.test(tree ?? '')) throw Error('This run has no reviewed tree to commit');
  const head = (await git(wt.path, ['rev-parse', 'HEAD'])).stdout.trim();
  if ((await git(wt.path, ['rev-parse', 'HEAD^{tree}'])).stdout.trim() === tree) return null;
  const sha = (await git(wt.path, ['commit-tree', tree, '-p', head, '-m', title, ...(body ? ['-m', body] : [])])).stdout.trim();
  await git(wt.path, ['update-ref', `refs/heads/${wt.branch}`, sha, head]);
  await git(wt.path, ['reset', '-q']);
  return sha;
}

export async function commitWorktree(wt, title, body) {
  if (!(await worktreeStatus(wt)).dirty) return null;
  await git(wt.path, ['add', '-A']);
  await git(wt.path, ['commit', '-q', '-m', title, ...(body ? ['-m', body] : [])]);
  return (await git(wt.path, ['rev-parse', 'HEAD'])).stdout.trim();
}

export async function openPullRequest(wt, title, body, run = execFile) {
  const status = await worktreeStatus(wt);
  if (!status.exists || status.dirty) throw Error('Commit the worktree before opening a PR');
  if (status.ahead === 0) throw Error('The run branch has no commits to propose');
  if (!RUN_BRANCH.test(wt.branch ?? '')) throw Error('Only a run branch can be proposed');
  try { await git(wt.path, ['remote', 'get-url', 'origin']); } catch { throw Error('This repository has no origin remote to push the run branch to'); }
  await git(wt.path, ['push', '-u', 'origin', wt.branch]);
  const { stdout } = await run('gh', ['pr', 'create', '--draft', '--head', wt.branch, ...(BASE_BRANCH.test(wt.baseBranch ?? '') ? ['--base', wt.baseBranch] : []), '--title', title, '--body', body || title],
    { cwd: wt.path, encoding: 'utf8', timeout: 60000 });
  return stdout.trim().split('\n').at(-1);
}

// Uncommitted work is never removed; a branch with no commits of its own goes with its worktree.
export async function removeRunWorktree(wt) {
  const status = await worktreeStatus(wt);
  if (!status.exists) return { removed: false, branchDeleted: false };
  if (status.dirty) throw Error('The worktree has uncommitted changes');
  const listed = (await git(wt.base, ['worktree', 'list', '--porcelain'])).stdout.split('\n').includes(`worktree ${wt.path}`);
  if (!RUN_BRANCH.test(wt.branch ?? '') || !listed) throw Error('This is not a run worktree of its repository');
  await git(wt.base, ['worktree', 'remove', wt.path]);
  const drop = status.ahead === 0;
  if (drop) await git(wt.base, ['branch', '-D', wt.branch]);
  return { removed: true, branchDeleted: drop };
}
