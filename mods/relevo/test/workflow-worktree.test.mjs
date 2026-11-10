import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareWorktree, runSlug, worktreePath } from '../runtime/worktree.mjs';

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
