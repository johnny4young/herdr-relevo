#!/usr/bin/env node
// Opt-in layout migration. Preserve unrelated nodes and the first rollback baseline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomic, digest } from './live-relevo.mjs';

export function simplifyLayout(input) {
  const tree = JSON.parse(JSON.stringify(input)), nodes = new Map();
  function visit(node) {
    if (nodes.has(node.id)) throw Error(`Duplicate layout id: ${node.id}`);
    nodes.set(node.id, node);
    for (const child of node.children ?? []) visit(child);
  }
  visit(tree);
  const sidebar = nodes.get('sidebar'), nav = nodes.get('inbox-button'), status = nodes.get('status');
  if (!sidebar?.children || nav?.content?.props?.role !== 'inbox-button' || !status) throw Error('Expected a Relevo layout');
  const accounts = nodes.get('accounts');
  if (accounts && (accounts.content?.mod !== 'relevo' || accounts.content?.props?.role !== 'accounts' || !sidebar.children.includes(accounts))) throw Error('Accounts block was customized; refusing automatic migration');
  if (status.type !== 'block' || status.content?.mod !== 'workspace-status') {
    if (!nodes.has('account-status')) throw Error('Status bar was customized; refusing automatic migration');
    return tree;
  }
  if (nodes.has('account-status') || nodes.has('workspace-status')) throw Error('Status layout ids already in use');
  sidebar.children = sidebar.children.filter((node) => node !== accounts);
  if (Number.isFinite(nav.size?.px)) nav.size = { ...nav.size, px: Math.max(nav.size.px, 184) };
  else nav.min = Math.max(nav.min ?? 0, 184);
  const originalStatus = { ...status, id: 'workspace-status' };
  delete originalStatus.size;
  delete status.content;
  status.type = 'row'; status.resizable = false;
  status.children = [originalStatus, { id: 'account-status', type: 'block', size: { px: 440 }, min: 150,
    content: { mod: 'relevo', props: { role: 'account-status' } } }];
  const bar = nodes.get('panel-bar');
  if (bar) bar.hidden = nodes.get('panel-body')?.active === 'inbox';
  return tree;
}

function manifest(backup) {
  const entry = JSON.parse(fs.readFileSync(path.join(backup, 'layout.json'), 'utf8'));
  if (entry.version !== 1 || !path.isAbsolute(entry.target)) throw Error('Invalid layout backup');
  if (fs.lstatSync(entry.target).isSymbolicLink()) throw Error('Refusing layout symlink');
  if (digest(path.join(backup, 'original-layout.json')) !== entry.original) throw Error('Layout backup checksum mismatch');
  return entry;
}
export function verifyLayout(backup) {
  const entry = manifest(backup), actual = digest(entry.target);
  if (actual !== entry.original && actual !== entry.installed) throw Error('Layout changed outside this migration; refusing overwrite');
  return entry;
}
export function installLayout(target, backup) {
  target = path.resolve(target); backup = path.resolve(backup);
  if (fs.lstatSync(target).isSymbolicLink()) throw Error('Refusing layout symlink');
  const raw = fs.readFileSync(target), before = digest(target);
  const next = JSON.stringify(simplifyLayout(JSON.parse(raw)), null, 2) + '\n';
  const record = path.join(backup, 'layout.json');
  let entry;
  if (fs.existsSync(record)) {
    entry = verifyLayout(backup);
    if (entry.target !== target) throw Error('Layout backup belongs to another target');
  } else {
    entry = { version: 1, target, original: before, mode: fs.statSync(target).mode & 0o777 };
    if (fs.existsSync(backup)) throw Error('Choose an unused layout backup directory');
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    atomic(path.join(backup, 'original-layout.json'), raw);
  }
  // Save recovery metadata before replacement, retaining the immutable baseline.
  const candidate = path.join(backup, 'candidate-layout.json');
  atomic(candidate, next); entry.installed = digest(candidate);
  atomic(record, JSON.stringify(entry, null, 2));
  if (digest(target) !== before) throw Error('Concurrent layout edit');
  if (before !== entry.installed) atomic(target, next, entry.mode);
  return verifyLayout(backup);
}
export function rollbackLayout(backup) {
  const entry = verifyLayout(backup);
  if (digest(entry.target) !== entry.original) atomic(entry.target, fs.readFileSync(path.join(backup, 'original-layout.json')), entry.mode);
  return entry;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, target, backup] = process.argv.slice(2);
  if (action === 'install' && target && backup) installLayout(target, backup);
  else if (action === 'rollback' && target) rollbackLayout(target);
  else if (action === 'verify' && target) verifyLayout(target);
  else throw Error('Usage: relevo-layout.mjs install <layout> <backup> | rollback|verify <backup>');
}
