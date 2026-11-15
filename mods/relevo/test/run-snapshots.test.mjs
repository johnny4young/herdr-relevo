// Attempt snapshots on real git: where they land, what they leave alone, how they compare and when they go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRuntime } from '../runtime/coordinator.mjs';
import { main } from '../runtime/cli.mjs';
import { transaction } from '../runtime/store.mjs';
import { attemptDiff, diffStat, dropAttemptRefs, prepareWorktree, snapshotAttempt } from '../runtime/worktree.mjs';

const out = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const refs = (root) => out(root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/relevo/').split('\n').filter(Boolean);

async function repo(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'relevo-snap-'))), root = path.join(base, 'app'), home = path.join(base, 'home');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(root); fs.mkdirSync(home);
  out(root, 'init', '-q'); out(root, 'config', 'user.email', 't@example.invalid'); out(root, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(root, '.gitignore'), '.env\n'); fs.writeFileSync(path.join(root, 'README.md'), 'one\ntwo\nthree\n');
  out(root, 'add', '.'); out(root, 'commit', '-qm', 'init');
  const wt = await prepareWorktree({ root, title: 'Try it', home });
  const indexDir = path.join(base, 'state-tmp'); fs.mkdirSync(indexDir);
  return { base, root, home, wt, indexDir };
}

test('a snapshot is a commit on its own ref; the branch, HEAD, the index and the hooks are left alone', async (t) => {
  const { base, root, wt, indexDir } = await repo(t);
  const marker = path.join(base, 'hook-ran'), hooks = path.join(root, '.git', 'hooks');
  for (const name of ['pre-commit', 'post-commit', 'commit-msg', 'reference-transaction']) fs.writeFileSync(path.join(hooks, name), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  out(root, 'update-ref', 'refs/probe/x', 'HEAD');
  assert.equal(fs.existsSync(marker), true, 'this git runs the hook on an ordinary ref update');
  out(root, 'update-ref', '-d', 'refs/probe/x'); fs.rmSync(marker);

  fs.writeFileSync(path.join(wt.path, 'README.md'), 'one\n2\nthree\nfour\n'); fs.writeFileSync(path.join(wt.path, 'NOTE.md'), 'note\n');
  fs.writeFileSync(path.join(wt.path, '.env'), 'TOKEN=local\n');
  const inner = path.join(wt.path, 'vendor', 'inner'); fs.mkdirSync(inner, { recursive: true });
  out(inner, 'init', '-q'); fs.writeFileSync(path.join(inner, 'secret.txt'), 'inner\n');
  out(wt.path, 'add', 'NOTE.md');
  const seen = () => [out(wt.path, 'rev-parse', 'HEAD'), out(wt.path, 'symbolic-ref', 'HEAD'), out(root, 'for-each-ref', 'refs/heads'), out(root, 'rev-parse', 'HEAD'),
    out(wt.path, 'status', '--porcelain'), out(wt.path, 'diff', '--cached', '--name-only'), out(wt.path, 'ls-files', '--stage')];
  const before = seen();

  const snapshot = await snapshotAttempt(wt, { taskId: 'task-1', number: 1, indexDir, at: Date.parse('2026-03-04T05:06:07Z') });
  assert.deepEqual(Object.keys(snapshot), ['ref', 'commit', 'tree', 'at']);
  assert.equal(snapshot.ref, 'refs/relevo/attempts/task-1/1'); assert.equal(snapshot.at, '2026-03-04T05:06:07.000Z');
  assert.deepEqual(refs(root), [`${snapshot.ref} ${snapshot.commit}`], 'the ref lives in the base repository');
  assert.equal(out(root, 'rev-parse', `${snapshot.commit}^{tree}`), snapshot.tree);
  assert.equal(out(root, 'log', '-1', '--format=%an <%ae> %cn %p', snapshot.commit), `Relevo <relevo@localhost> Relevo ${wt.baseCommit.slice(0, 7)}`);
  assert.deepEqual(out(root, 'ls-tree', '-r', '--name-only', snapshot.tree).split('\n'), ['.gitignore', 'NOTE.md', 'README.md'], 'no ignored file and no nested repository');
  assert.deepEqual(seen(), before, 'branch, HEAD, staged files and status are unchanged');
  assert.equal(fs.existsSync(marker), false, 'no hook ran');
  assert.deepEqual(fs.readdirSync(indexDir), [], 'the temporary index is gone');
  await assert.rejects(snapshotAttempt(wt, { taskId: '../heads/main', number: 1, indexDir }), /cannot be named/);
});

test('two snapshots compare by files and lines, each compares to where the run started, and dropped refs end it', async (t) => {
  const { root, wt, indexDir } = await repo(t);
  fs.writeFileSync(path.join(wt.path, 'README.md'), 'one\n2\nthree\nfour\n'); fs.writeFileSync(path.join(wt.path, 'NOTE.md'), 'note\n');
  const first = await snapshotAttempt(wt, { taskId: 'task-1', number: 1, indexDir });
  fs.rmSync(path.join(wt.path, 'NOTE.md')); fs.writeFileSync(path.join(wt.path, 'logo.bin'), Buffer.from([0, 1, 2, 0, 255]));
  fs.writeFileSync(path.join(wt.path, 'README.md'), 'one\n2\nthree\nfour\nfive\n');
  const second = await snapshotAttempt(wt, { taskId: 'task-1', number: 2, indexDir });
  const other = await snapshotAttempt(wt, { taskId: 'task-2', number: 1, indexDir });

  assert.deepEqual(await attemptDiff(wt, null, first), { fromCommit: wt.baseCommit, toCommit: first.commit, files: 2, added: 3, removed: 1,
    list: [{ path: 'NOTE.md', added: 1, removed: 0 }, { path: 'README.md', added: 2, removed: 1 }], truncated: false });
  const between = await attemptDiff(wt, first, second);
  assert.deepEqual([between.files, between.added, between.removed], [3, 1, 1]);
  assert.deepEqual(between.list, [{ path: 'NOTE.md', added: 0, removed: 1 }, { path: 'README.md', added: 1, removed: 0 }, { path: 'logo.bin', added: 0, removed: 0, binary: true }]);
  assert.equal((await attemptDiff({ ...wt, baseCommit: undefined }, null, first)).fromCommit, wt.baseCommit, 'an older run compares to the snapshot\'s parent');
  await assert.rejects(diffStat(root, 'HEAD', second.commit), /Two commits/);
  await assert.rejects(attemptDiff(wt, first, { ...second, commit: first.commit }), /no longer kept/);

  assert.equal(await dropAttemptRefs(root, 'task-1'), 2);
  assert.deepEqual(refs(root), [`${other.ref} ${other.commit}`], 'another task keeps its own');
  await assert.rejects(attemptDiff(wt, null, first), /no longer kept/);
  assert.equal(await dropAttemptRefs(root, '../../heads'), 0); assert.equal(await dropAttemptRefs(path.join(root, 'gone'), 'task-2'), 0);
});

async function run(t, { snapshotImpl } = {}) {
  const f = await repo(t), sends = [], cwds = new Map();
  fs.writeFileSync(path.join(f.home, 'relevo-goals.json'), JSON.stringify({ goals: [{ id: 'g1', state: 'open' }] }));
  const runCommand = async ([, ...args]) => {
    if (args[0] === 'get') return { code: 0, stdout: JSON.stringify({ state: 'live', status: { state: 'idle' }, cwd: cwds.get(args[2]) ?? f.wt.path, turn: 1,
      labels: { 'agent.transcript': `/h/.claude/projects/p/${args[2]}-session.jsonl`, 'agent.account': 'personal' } }) };
    if (args[0] === 'send') { sends.push(args); return { code: 0, stdout: '', stderr: '' }; }
    throw Error(`unexpected hc ${args[0]}`);
  };
  let now = Date.parse('2026-01-02T03:04:05Z');
  const runtime = createRuntime({ home: f.home, runCommand, clock: () => now++, ...(snapshotImpl ? { snapshotImpl } : {}) });
  const create = async (extra = {}) => (await runtime.command({ action: 'create', start: true, task: { goalId: 'g1', title: 'Try it', criteria: 'Works', root: f.wt.path,
    executor: { address: 'exec-1' }, reviewer: { address: 'review-1' }, checks: [],
    worktree: { branch: f.wt.branch, base: f.wt.base, baseCommit: f.wt.baseCommit }, ...extra } })).result.taskId;
  const task = (id) => runtime.read().tasks.find((item) => item.id === id);
  // Ticks until the given role has a running attempt, then writes its report and ticks until it is taken.
  const report = async (id, role, status, summary = 'Done') => {
    for (let i = 0; i < 5 && !(task(id).attempts.at(-1)?.role === role && task(id).attempts.at(-1).state === 'running'); i++) await runtime.tick();
    const attempt = task(id).attempts.at(-1);
    assert.equal(attempt.role, role);
    const token = sends.map((args) => args.at(-1)).find((text) => text.includes(attempt.id)).match(/"token":"([^"]+)"/)[1];
    fs.writeFileSync(path.join(f.home, 'relevo-workflow', 'reports', `${attempt.id}.json`), JSON.stringify({ attemptId: attempt.id, token, status, summary }));
    for (let i = 0; i < 5 && task(id).attempts.find((a) => a.id === attempt.id).state === 'running'; i++) await runtime.tick();
    return task(id).attempts.find((a) => a.id === attempt.id);
  };
  return { ...f, runtime, create, task, report, cwds, setNow(value) { now = value; } };
}

test('each implementer report keeps a snapshot and the size of its change; the diff command reads them as JSON', async (t) => {
  const f = await run(t), id = await f.create();
  await f.runtime.tick();
  fs.writeFileSync(path.join(f.wt.path, 'NOTE.md'), 'note\n');
  const first = await f.report(id, 'executor', 'completed');
  assert.equal(first.snapshot.ref, `refs/relevo/attempts/${id}/1`);
  assert.deepEqual(Object.keys(first.snapshot), ['ref', 'commit', 'tree', 'at']);
  assert.deepEqual(first.change, { files: 1, added: 1, removed: 0 });
  assert.match(first.endedAt, /^2026-01-02T/); assert.equal(first.account, 'personal'); assert.match(first.transcript, /exec-1-session\.jsonl$/);
  assert.equal(first.snapshotError, undefined);
  assert.equal(out(f.root, 'rev-parse', first.snapshot.ref), first.snapshot.commit);
  assert.equal(out(f.wt.path, 'rev-parse', 'HEAD'), f.wt.baseCommit, 'the run branch did not move');

  const review = await f.report(id, 'reviewer', 'changes_requested', 'Needs a title');
  assert.equal(review.snapshot, undefined, 'a review changes nothing to keep'); assert.ok(review.endedAt);
  await f.runtime.tick();
  fs.writeFileSync(path.join(f.wt.path, 'NOTE.md'), '# Note\nnote\n'); fs.writeFileSync(path.join(f.wt.path, 'MORE.md'), 'more\n');
  const second = await f.report(id, 'executor', 'completed');
  assert.equal(second.snapshot.ref, `refs/relevo/attempts/${id}/2`);
  assert.deepEqual(second.change, { files: 2, added: 3, removed: 0 });
  assert.equal(refs(f.root).length, 2);

  const cli = (payload) => main(['--home', f.home, 'command', JSON.stringify(payload)], { runtimeFactory: () => f.runtime });
  const between = await cli({ action: 'attempt-diff', taskId: id, from: first.id, to: second.id });
  assert.equal(between.code, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(between.output)), { result: { taskId: id, from: first.id, to: second.id, fromCommit: first.snapshot.commit, toCommit: second.snapshot.commit,
    files: 2, added: 2, removed: 0, list: [{ path: 'MORE.md', added: 1, removed: 0 }, { path: 'NOTE.md', added: 1, removed: 0 }], truncated: false } });
  const fromBase = await cli({ action: 'attempt-diff', taskId: id, to: first.id });
  assert.deepEqual([fromBase.output.result.from, fromBase.output.result.fromCommit, fromBase.output.result.files], [null, f.wt.baseCommit, 1]);
  const none = await cli({ action: 'attempt-diff', taskId: id, from: review.id, to: second.id });
  assert.equal(none.code, 1); assert.match(none.output.error, /No snapshot is kept/);
});

test('a run on existing sessions keeps no snapshot', async (t) => {
  const f = await run(t);
  f.cwds.set('exec-2', f.root); f.cwds.set('review-2', f.root);
  const id = await f.create({ root: f.root, worktree: undefined, executor: { address: 'exec-2' }, reviewer: { address: 'review-2' } });
  const attempt = await f.report(id, 'executor', 'completed');
  assert.equal(attempt.snapshot, undefined); assert.equal(attempt.snapshotError, undefined); assert.equal(attempt.change, undefined);
  assert.deepEqual(refs(f.root), []);
  assert.equal(f.task(id).attempts.at(-1).role, 'reviewer', 'and goes on to review');
});

test('a snapshot that fails is recorded and the run goes on to review', async (t) => {
  const f = await run(t, { snapshotImpl: async () => { throw Error('fatal: unable to write new index file'); } }), id = await f.create();
  const attempt = await f.report(id, 'executor', 'completed');
  assert.equal(attempt.snapshotError, 'fatal: unable to write new index file'); assert.equal(attempt.snapshot, undefined);
  assert.equal(attempt.state, 'reported');
  await f.report(id, 'reviewer', 'completed');
  assert.equal(f.task(id).state, 'needs_you');
  assert.ok(f.runtime.read().events.some((e) => e.type === 'Attempt snapshot not kept'));
});

test('discarding a run\'s worktree and archiving a run both drop its snapshot refs', async (t) => {
  const f = await run(t), dropped = await f.create();
  fs.writeFileSync(path.join(f.wt.path, 'NOTE.md'), 'note\n');
  await f.report(dropped, 'executor', 'blocked', 'Cannot go on');
  assert.equal(refs(f.root).length, 1, 'a blocked attempt is kept too');
  await f.runtime.command({ action: 'cancel', taskId: dropped });
  await f.runtime.command({ action: 'worktree-remove', taskId: dropped });
  assert.deepEqual(refs(f.root), []);
  const attempt = f.task(dropped).attempts[0];
  assert.equal(attempt.snapshot, undefined); assert.deepEqual(attempt.change, { files: 1, added: 1, removed: 0 }, 'the size of the change stays as history');
  await assert.rejects(f.runtime.command({ action: 'attempt-diff', taskId: dropped, to: attempt.id }), /No snapshot is kept/);

  // A worktree deleted outside the app: the archive is what cleans up.
  const wt = await prepareWorktree({ root: f.root, title: 'Second', home: f.home });
  f.cwds.set('exec-3', wt.path); f.cwds.set('review-3', wt.path);
  const archived = await f.create({ root: wt.path, executor: { address: 'exec-3' }, reviewer: { address: 'review-3' }, worktree: { branch: wt.branch, base: wt.base, baseCommit: wt.baseCommit } });
  await snapshotAttempt(wt, { taskId: archived, number: 1, indexDir: f.indexDir });
  assert.equal(refs(f.root).length, 1);
  out(f.root, 'worktree', 'remove', '--force', wt.path);
  transaction(f.home, (doc) => { for (const task of doc.tasks) task.state = task.id === archived ? 'accepted' : task.state; });
  f.setNow(Date.parse('2026-03-01T00:00:00Z'));
  assert.equal((await f.runtime.command({ action: 'archive', olderThanDays: 0 })).result.archived, 2);
  assert.deepEqual(refs(f.root), []);
});
