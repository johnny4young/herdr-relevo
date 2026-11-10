#!/usr/bin/env node
// Local development deployment only. Accounts, layouts and sessions are never modified.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const digest = (p) => fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null;
export function atomic(p, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const temp = `${p}.relevo-${crypto.randomUUID()}`;
  const fd = fs.openSync(temp, 'wx', mode);
  try {
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, p);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function files(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(prefix, e.name);
    if (e.isSymbolicLink()) throw Error(`Refusing symlink: ${rel}`);
    return e.isDirectory() ? (e.name === 'test' ? [] : files(root, rel)) : [rel];
  });
}
function engineAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export function stopCoordinator(appHome, target, { spawnSyncImpl = spawnSync, isAlive = engineAlive, wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), node = process.execPath } = {}) {
  const state = path.join(appHome, 'relevo-workflow', 'state.json');
  const cli = path.join(target, 'runtime', 'cli.mjs');
  if (!fs.existsSync(state) || !fs.existsSync(cli)) return false;
  let owner;
  const ownerFile = path.join(appHome, 'relevo-workflow', 'engine.lock', 'owner.json');
  try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch { return false; }
  if (!isAlive(owner.pid)) return false;
  const result = spawnSyncImpl(node, [cli, '--home', path.resolve(appHome), 'command', JSON.stringify({ action: 'stop' })], { encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error(result.stderr?.trim() || 'Could not stop the Relevo coordinator safely');
  const deadline = Date.now() + 20000;
  while (isAlive(owner.pid) && Date.now() < deadline) wait(50);
  if (isAlive(owner.pid)) throw new Error('Relevo coordinator did not exit; refusing to replace its runtime');
  return true;
}
function confined(root, rel) {
  if (path.isAbsolute(rel) || rel.split(path.sep).includes('..')) throw Error('Invalid manifest path');
  const target = path.join(root, rel);
  for (let p = target; p !== root; p = path.dirname(p)) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw Error(`Refusing symlink: ${p}`);
  }
  return target;
}
export function deploy(source, target, backup, options = {}) {
  source = path.resolve(source); target = path.resolve(target); backup = path.resolve(backup);
  if (!fs.statSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink()) throw Error('Expected an existing mod directory');
  if (fs.existsSync(backup)) throw Error('Backup exists; choose a new backup for each installation');
  stopCoordinator(options.appHome ?? path.dirname(path.dirname(target)), target, options.stopOptions);
  const changed = files(source).filter((rel) => /\.(?:m?js)$/.test(rel) && path.basename(rel) !== 'config.js' && digest(path.join(source, rel)) !== digest(confined(target, rel)))
    .sort((a, b) => Number(a === 'main.js') - Number(b === 'main.js') || a.localeCompare(b));
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  const manifest = { version: 1, target, created: new Date().toISOString(), files: {} };
  for (const rel of changed) {
    const dest = confined(target, rel), original = digest(dest);
    if (original !== null) atomic(path.join(backup, 'original', rel), fs.readFileSync(dest));
    manifest.files[rel] = { original, originalMode: original === null ? null : fs.statSync(dest).mode & 0o777, installed: digest(path.join(source, rel)) };
  }
  atomic(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2));
  // A standalone rollback launcher stays beside the immutable originals.
  atomic(path.join(backup, 'rollback.mjs'), fs.readFileSync(fileURLToPath(import.meta.url)));
  const quote = (v) => "'" + v.replaceAll("'", "'\\''") + "'";
  atomic(path.join(backup, 'rollback.command'), '#!/bin/bash\nset -euo pipefail\nexec ' + quote(process.execPath) + ' ' + quote(path.join(backup, 'rollback.mjs')) + ' rollback --backup ' + quote(backup) + '\n', 0o700);
  for (const rel of changed) {
    const dest = confined(target, rel);
    if (digest(dest) !== manifest.files[rel].original) throw Error(`Concurrent edit; rollback partial install: ${rel}`);
    atomic(dest, fs.readFileSync(path.join(source, rel)), manifest.files[rel].originalMode ?? 0o644);
  }
  return verify(backup, true);
}
export function update(source, backup, options = {}) {
  source = path.resolve(source); backup = path.resolve(backup);
  const manifestPath = path.join(backup, 'manifest.json');
  const manifest = load(backup);
  const target = manifest.target;
  if (!fs.statSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink()) throw Error('Expected an existing mod directory');

  const candidates = new Map(files(source)
    .filter((rel) => /\.(?:m?js)$/.test(rel) && path.basename(rel) !== 'config.js')
    .map((rel) => [rel, fs.readFileSync(path.join(source, rel))]));
  const rels = [...new Set([...Object.keys(manifest.files), ...candidates.keys()])]
    .sort((a, b) => Number(a === 'main.js') - Number(b === 'main.js') || a.localeCompare(b));
  const plan = [];
  for (const rel of rels) {
    const dest = confined(target, rel), existing = manifest.files[rel];
    const actual = digest(dest);
    const bytes = candidates.get(rel);
    const candidateHash = bytes ? crypto.createHash('sha256').update(bytes).digest('hex') : null;
    if (!existing && actual !== null && actual !== candidateHash) throw Error(`Refusing to replace untracked file: ${rel}`);
    const original = existing ? existing.original : actual;
    const prior = existing ? [...new Set([...(existing.acceptedInstalled ?? []), existing.installed, existing.original])] : [actual];
    if (!prior.includes(actual)) throw Error(`Local edit detected; refusing update: ${rel}`);
    const expectedMode = existing ? (existing.originalMode ?? 0o644) : (actual === null ? null : fs.statSync(dest).mode & 0o777);
    if (actual !== null && (fs.statSync(dest).mode & 0o777) !== expectedMode) throw Error(`Local mode change detected; refusing update: ${rel}`);
    if (existing && original !== null && digest(path.join(backup, 'original', rel)) !== original) throw Error(`Backup checksum mismatch: ${rel}`);
    const desired = bytes ? candidateHash : original;
    const acceptedInstalled = [...new Set([...prior, desired])];
    plan.push({ rel, dest, actual, bytes, desired, existing, original, acceptedInstalled });
  }

  for (const item of plan) {
    if (!item.existing && item.original !== null) {
      atomic(path.join(backup, 'original', item.rel), fs.readFileSync(item.dest));
      item.originalMode = fs.statSync(item.dest).mode & 0o777;
    }
  }

  // Commit the recovery hashes first. If interrupted while files are replaced,
  // rollback still recognizes either the old managed version or the candidate.
  for (const item of plan) {
    manifest.files[item.rel] = {
      original: item.original,
      originalMode: item.existing ? item.existing.originalMode : item.originalMode ?? null,
      installed: item.desired,
      acceptedInstalled: item.acceptedInstalled,
    };
  }
  if (plan.some((item) => item.actual !== item.desired)) {
    stopCoordinator(options.appHome ?? path.dirname(path.dirname(target)), target, options.stopOptions);
  }
  atomic(path.join(backup, 'rollback.mjs'), fs.readFileSync(fileURLToPath(import.meta.url)));
  atomic(manifestPath, JSON.stringify(manifest, null, 2));
  const writeTarget = options.writeTarget ?? atomic;
  for (const item of plan) {
    const current = digest(item.dest);
    if (current === item.desired) continue;
    if (current !== item.actual) throw Error(`Concurrent edit; refusing update: ${item.rel}`);
    if (item.desired === null) {
      if (fs.existsSync(item.dest)) fs.unlinkSync(item.dest);
    } else if (item.bytes) {
      writeTarget(item.dest, item.bytes, item.existing?.originalMode ?? item.originalMode ?? 0o644);
    } else {
      writeTarget(item.dest, fs.readFileSync(path.join(backup, 'original', item.rel)), item.existing.originalMode ?? 0o644);
    }
  }
  return verify(backup, true);
}
function load(backup) {
  const m = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'));
  if (m.version !== 1 || !path.isAbsolute(m.target) || !m.files) throw Error('Invalid manifest');
  if (fs.lstatSync(m.target).isSymbolicLink()) throw Error('Refusing target symlink');
  for (const rel of Object.keys(m.files)) { confined(m.target, rel); confined(path.join(backup, 'original'), rel); }
  return m;
}
export function verify(backup, installed = false) {
  const m = load(backup);
  for (const [rel, hashes] of Object.entries(m.files)) {
    if (digest(confined(m.target, rel)) !== hashes[installed ? 'installed' : 'original']) throw Error(`Verification mismatch: ${rel}`);
  }
  return Object.keys(m.files).length;
}
export function rollback(backup, options = {}) {
  const m = load(backup);
  stopCoordinator(options.appHome ?? path.dirname(path.dirname(m.target)), m.target, options.stopOptions);
  for (const [rel, hashes] of Object.entries(m.files)) {
    if (![hashes.installed, hashes.original, ...(hashes.acceptedInstalled ?? [])].includes(digest(confined(m.target, rel)))) throw Error(`New local edit preserved; resolve before rollback: ${rel}`);
    if (hashes.original !== null && digest(path.join(backup, 'original', rel)) !== hashes.original) throw Error(`Backup checksum mismatch: ${rel}`);
  }
  const entries = Object.keys(m.files).sort((a, b) => Number(a !== 'main.js') - Number(b !== 'main.js') || Number(m.files[a].original === null) - Number(m.files[b].original === null));
  for (const rel of entries) {
    const dest = confined(m.target, rel);
    if (m.files[rel].original === null) { if (fs.existsSync(dest)) fs.unlinkSync(dest); }
    else if (digest(dest) !== m.files[rel].original || (fs.statSync(dest).mode & 0o777) !== (m.files[rel].originalMode ?? 0o644)) {
      atomic(dest, fs.readFileSync(path.join(backup, 'original', rel)), m.files[rel].originalMode ?? 0o644);
    }
  }
  return verify(backup);
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [command, ...args] = process.argv.slice(2), options = {};
    if (args.length % 2) throw Error('Expected --option value pairs');
    for (let i = 0; i < args.length; i += 2) options[args[i]] = args[i + 1];
    const backup = options['--backup'];
    if (!backup) throw Error('--backup is required');
    let n;
    if (command === 'install') n = deploy(options['--source'] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../mods/relevo'), options['--target'] ?? path.join(os.homedir(), '.config/herdr-app/mods/relevo'), backup);
    else if (command === 'update') n = update(options['--source'] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../mods/relevo'), backup);
    else if (command === 'rollback') n = rollback(backup);
    else if (['verify-installed', 'verify-original'].includes(command)) n = verify(backup, command === 'verify-installed');
    else throw Error('Use install, update, rollback, verify-installed or verify-original');
    console.log(JSON.stringify({ action: command, verifiedFiles: n, backup }));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
