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
    if (![hashes.installed, hashes.original].includes(digest(confined(m.target, rel)))) throw Error(`New local edit preserved; resolve before rollback: ${rel}`);
    if (hashes.original !== null && digest(path.join(backup, 'original', rel)) !== hashes.original) throw Error(`Backup checksum mismatch: ${rel}`);
  }
  const entries = Object.keys(m.files).sort((a, b) => Number(a !== 'main.js') - Number(b !== 'main.js') || Number(m.files[a].original === null) - Number(m.files[b].original === null));
  for (const rel of entries) {
    const dest = confined(m.target, rel);
    if (m.files[rel].original === null) { if (fs.existsSync(dest)) fs.unlinkSync(dest); }
    else atomic(dest, fs.readFileSync(path.join(backup, 'original', rel)), m.files[rel].originalMode ?? 0o644);
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
    else if (command === 'rollback') n = rollback(backup);
    else if (['verify-installed', 'verify-original'].includes(command)) n = verify(backup, command === 'verify-installed');
    else throw Error('Use install, rollback, verify-installed or verify-original');
    console.log(JSON.stringify({ action: command, verifiedFiles: n, backup }));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
