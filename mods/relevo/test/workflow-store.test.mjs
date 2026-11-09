import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyState, privateDir, readState, stateDir, transaction } from '../runtime/store.mjs';

async function fixture(fn) {
  const home = await fs.promises.realpath(await mkdtemp(join(tmpdir(), 'relevo-store-')));
  try { await fn(home); } finally { await rm(home, { recursive: true, force: true }); }
}

test('nested mutations fail busy and preserve the last committed bytes', async () => fixture(async (home) => {
  transaction(home, (doc) => { doc.engine.enabled = true; });
  const file = join(stateDir(home), 'state.json'), before = await readFile(file, 'utf8');
  assert.throws(() => transaction(home, (doc) => {
    doc.engine.enabled = false;
    transaction(home, (nested) => { nested.revision = 999; });
  }), /Workflow is busy/);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(readState(home).engine.enabled, true);
}));

test('a live write owner blocks mutation without changing state or owner data', async () => fixture(async (home) => {
  const dir = privateDir(stateDir(home)), lock = join(dir, 'write.lock');
  const initial = emptyState(); initial.engine.enabled = true;
  await writeFile(join(dir, 'state.json'), JSON.stringify(initial, null, 2));
  await mkdir(lock); const ownerPath = join(lock, 'owner.json');
  const owner = JSON.stringify({ pid: process.pid, token: 'live-writer' }); await writeFile(ownerPath, owner);
  const before = await readFile(join(dir, 'state.json'), 'utf8');
  assert.throws(() => transaction(home, (doc) => { doc.engine.enabled = false; }), /Workflow is busy/);
  assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), before);
  assert.equal(await readFile(ownerPath, 'utf8'), owner);
}));

test('a stale write owner is reclaimed and the new mutation commits', async () => fixture(async (home) => {
  const dir = privateDir(stateDir(home)), lock = join(dir, 'write.lock'); await mkdir(lock);
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 0, token: 'stale' }));
  const result = transaction(home, (doc) => { doc.engine.enabled = true; });
  assert.equal(result.doc.revision, 1); assert.equal(readState(home).engine.enabled, true);
  assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(join(dir, 'write.acquire')), false);
}));

test('a symlink lock is rejected without touching its target', async () => fixture(async (home) => {
  const dir = privateDir(stateDir(home)), target = join(home, 'outside-lock'); await mkdir(target);
  const ownerPath = join(target, 'owner.json'), owner = JSON.stringify({ pid: 0, token: 'outside' }); await writeFile(ownerPath, owner);
  await symlink(target, join(dir, 'write.lock'));
  assert.throws(() => transaction(home, (doc) => { doc.engine.enabled = true; }), /Unsafe workflow lock/);
  assert.equal(await readFile(ownerPath, 'utf8'), owner);
  assert.equal(fs.lstatSync(join(dir, 'write.lock')).isSymbolicLink(), true);
  assert.equal(fs.existsSync(join(dir, 'write.acquire')), false);
}));

test('failed mutations leave the prior state intact and release both locks', async () => fixture(async (home) => {
  transaction(home, (doc) => { doc.engine.enabled = true; });
  const dir = stateDir(home), file = join(dir, 'state.json'), before = await readFile(file, 'utf8');
  assert.throws(() => transaction(home, (doc) => { doc.engine.enabled = false; throw Error('abort'); }), /abort/);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(fs.existsSync(join(dir, 'write.lock')), false); assert.equal(fs.existsSync(join(dir, 'write.acquire')), false);
}));
