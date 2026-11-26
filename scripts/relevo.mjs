#!/usr/bin/env node
// Installs, updates, checks and removes Relevo in a Herdr app folder. `relevo.mjs help` says how.
// It records a sha256 of each file it writes, so an update replaces only what the person left as installed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { needsEngine } from '../mods/relevo/lib/engine.js';
import { RELEVO_MODS, SMOKE_FILE, smoke, smokeDue, smokeRecord } from '../mods/relevo/lib/smoke.js';
import { PANELS_FILE, PANEL_KEYS, applyPanels, panelsText, parsePanels, readPanels } from '../mods/relevo/lib/panels.js';

const MODS = RELEVO_MODS;
const LAYOUTS = ['layouts/relevo.json', 'layouts/relevo.svg'];
// The person's own settings: created once from the example, then never read, replaced or recorded.
const CONFIG = 'mods/relevo/config.js';
const STATE = 'relevo-install';
const COMMUNITY = ['issues'];
const HELP = `Usage: relevo.mjs <install|doctor|smoke|uninstall> [options]

  install     Install Relevo, or update it. A file you changed is kept, with the new one beside it as <file>.new.
  doctor      Check the installed files, the keys and the programs Relevo runs. Exits 1 when something is wrong.
  smoke       Load each installed mod in Herdr and try the hc calls Relevo reads. Run it after Herdr updates.
  uninstall   Remove the files install wrote and you did not change. Your config.js, keys and data stay.

  --dry-run        Say what would change and write nothing
  --root <dir>     The Herdr app folder (default: $HERDR_APP_HOME, else ~/.config/herdr-app)
  --source <dir>   A Relevo checkout (default: the one this script is in)
  --files-only     doctor: only the installed files, not the programs or the keys
  --only <panels>  install: the panels to show, of spaces, agents, tabs, files, reviews (or all). Settings changes it later
`;

const sha = (data) => createHash('sha256').update(data).digest('hex');
const read = (file) => { try { return fs.readFileSync(file); } catch { return null; } };
const skipped = (rel) => rel.split('/').some((part) => part.startsWith('.') || part === 'test') || /\.d\.ts$|\.new$|(^|\/)jsconfig\.json$/.test(rel);

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : entry.isFile() ? [path.relative(base, full)] : [];
  });
}

// Every panel on keeps the shipped bytes; otherwise the installed layout hides the blocks of the ones turned off.
const withPanels = (data, on) => on.length === PANEL_KEYS.length ? data : Buffer.from(`${JSON.stringify(applyPanels(JSON.parse(data.toString()), on), null, 2)}\n`);
export const storedPanels = (root) => readPanels(read(path.join(root, PANELS_FILE))?.toString());

// Every file Relevo ships, by its path under the app folder. A checkout with nothing to install is an error.
export function sourceFiles(source, on = PANEL_KEYS) {
  const files = new Map();
  for (const mod of MODS) {
    const dir = path.join(source, 'mods', mod);
    if (!fs.existsSync(path.join(dir, 'mod.json'))) throw Error(`${source} is not a Relevo checkout: mods/${mod}/mod.json is missing`);
    for (const rel of walk(dir)) if (!skipped(rel)) files.set(`mods/${mod}/${rel}`, fs.readFileSync(path.join(dir, rel)));
  }
  for (const rel of LAYOUTS) {
    const data = read(path.join(source, rel));
    if (!data) throw Error(`${source} is not a Relevo checkout: ${rel} is missing`);
    files.set(rel, rel === 'layouts/relevo.json' ? withPanels(data, on) : data);
  }
  return files;
}

export const versionOf = (source) => /^## (\d+\.\d+\.\d+)/m.exec(read(path.join(source, 'CHANGELOG.md'))?.toString() ?? '')?.[1] ?? 'unknown';
const manifestPath = (root) => path.join(root, STATE, 'installed.json');
export function readManifest(root) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath(root), 'utf8'));
    return manifest && typeof manifest.files === 'object' ? manifest : null;
  } catch { return null; }
}

// What an install would do to each file: new, same, update, adopt (there before any record, replaced with a
// backup), keep (the person's; the new one goes beside it as .new), remove (no longer shipped) or stay.
// A kept file records the version offered, so the same .new is not written again once the person dealt with it.
export function plan(source, root, on = storedPanels(root)) {
  const files = sourceFiles(source, on), recorded = readManifest(root)?.files ?? {}, steps = [];
  for (const [rel, data] of files) {
    if (rel === CONFIG) { if (!fs.existsSync(path.join(root, rel))) steps.push({ rel, how: 'new', data, unrecorded: true }); continue; }
    const now = read(path.join(root, rel)), want = sha(data), was = recorded[rel];
    const how = !now ? 'new' : sha(now) === want ? 'same' : !was ? 'adopt' : sha(now) === was ? 'update' : want === was ? 'stay' : 'keep';
    steps.push({ rel, how, data, hash: how === 'stay' ? was : want });
  }
  for (const [rel, was] of Object.entries(recorded)) {
    if (files.has(rel)) continue;
    const now = read(path.join(root, rel));
    if (now) steps.push({ rel, how: sha(now) === was ? 'remove' : 'stay', hash: was, gone: true });
  }
  return steps;
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.relevo-tmp-${randomUUID()}`;
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const confinedPath = (root, rel) => {
  const base = path.resolve(root), full = path.resolve(base, rel);
  if (full === base || !full.startsWith(`${base}${path.sep}`)) throw Error(`Unsafe path in install manifest: ${rel}`);
  return full;
};

// Relevo's keys the person's file lacks. A key or a command they already bound is theirs, and the example's
// launch keys only count for the accounts their config.js names. A key still on the command Relevo gave it
// before moves to the new one; with no record of that, any Relevo command on one of Relevo's keys counts.
export function missingKeys(source, root) {
  const ours = JSON.parse(fs.readFileSync(path.join(source, 'keys.json'), 'utf8'))['layout:relevo'] ?? {};
  const file = path.join(root, 'keys.json'), raw = read(file);
  let theirs = {};
  if (raw) { try { theirs = JSON.parse(raw.toString()); } catch { return { file, ours, unreadable: true, add: {}, moved: [], taken: [] }; } }
  const config = read(path.join(root, CONFIG))?.toString() ?? read(path.join(source, CONFIG))?.toString() ?? '';
  const wanted = Object.entries(ours).filter(([, command]) => {
    const account = /^relevo\.launch-(.+)$/.exec(command)?.[1];
    return !account || account === 'best' || new RegExp(`key:\\s*"${escapeRegex(account)}"`).test(config);
  });
  const shipped = readManifest(root)?.keys, section = { ...theirs['layout:relevo'] }, add = {}, moved = [], taken = [];
  for (const [combo, command] of wanted) {
    const now = section[combo];
    if (!now || now === command || !(shipped ? shipped[combo] === now : now.startsWith('relevo.'))) continue;
    section[combo] = command; moved.push(`${combo}: ${now} → ${command}`);
  }
  const bound = new Set([...Object.entries(theirs).filter(([name]) => name !== 'layout:relevo').flatMap(([, keys]) => Object.values(keys ?? {})), ...Object.values(section)]);
  for (const [combo, command] of wanted) {
    if (bound.has(command)) continue;
    if (section[combo]) taken.push(`${combo} (${command})`);
    else { section[combo] = command; add[combo] = command; }
  }
  return { file, ours, theirs, section, add, moved, taken };
}

// The newest backups stay; older ones go. Only folders named by an install's timestamp are touched.
export const KEEP_BACKUPS = 10;
export function pruneBackups(root, keep = KEEP_BACKUPS) {
  const dir = path.join(root, STATE, 'backups');
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T[\dZ-]+$/.test(e.name)).map((e) => e.name).sort(); } catch { return []; }
  const gone = names.slice(0, Math.max(0, names.length - keep));
  for (const name of gone) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  return gone;
}

// A coordinator that is running keeps the code it started with. An idle one is stopped, so the next run starts
// the new version; a busy one finishes its runs first and then rests on its own.
export function stopIdleCoordinator(root, { log = () => {}, kill = process.kill,
  ps = (pid) => spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '' } = {}) {
  const dir = path.join(root, 'relevo-workflow');
  let pid, tasks = null;
  try { pid = JSON.parse(fs.readFileSync(path.join(dir, 'engine.lock', 'owner.json'), 'utf8')).pid; } catch { return 'none'; }
  const command = Number.isSafeInteger(pid) && pid > 0 ? String(ps(pid)) : '';
  if (!command.includes(path.join(root, 'mods/relevo/runtime/cli.mjs')) || !command.includes(`--home ${root} serve`)) return 'none';
  try { tasks = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).tasks; } catch { /* unreadable: leave it running */ }
  if (!Array.isArray(tasks) || needsEngine(tasks)) { log('runs   the Runs coordinator keeps the previous version until its runs are done'); return 'busy'; }
  try { kill(pid, 'SIGTERM'); } catch { return 'none'; }
  log('runs   stopped the idle Runs coordinator: the next run starts the new version');
  return 'stopped';
}

export function install({ source, root, dry = false, log = () => {}, coordinator = {}, panels }) {
  if (!fs.existsSync(root)) throw Error(`${root} does not exist. Open the Herdr app once, or pass --root.`);
  const on = panels ?? storedPanels(root);
  if (panels) log(`panels ${PANEL_KEYS.map((k) => `${k} ${on.includes(k) ? 'on' : 'off'}`).join(', ')}`);
  if (panels && !dry) writeAtomic(path.join(root, PANELS_FILE), panelsText(on));
  const steps = plan(source, root, on), stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(root, STATE, 'backups', stamp), files = {};
  const count = {};
  for (const step of steps) {
    count[step.how] = (count[step.how] ?? 0) + 1;
    const target = path.join(root, step.rel);
    if (step.how !== 'same') log(`${step.how.padEnd(6)} ${step.rel}${step.how === 'keep' ? ' (yours; the new one is beside it as .new)' : step.how === 'stay' && step.gone ? ' (no longer shipped; you changed it)' : ''}`);
    if (!dry) {
      if (step.how === 'update' || step.how === 'adopt' || step.how === 'remove') writeAtomic(path.join(backup, step.rel), fs.readFileSync(target));
      if (step.how === 'new' || step.how === 'update' || step.how === 'adopt') writeAtomic(target, step.data);
      if (step.how === 'keep') writeAtomic(`${target}.new`, step.data);
      if (step.how === 'remove') fs.rmSync(target);
      if (step.how !== 'keep' && step.how !== 'stay') fs.rmSync(`${target}.new`, { force: true });
    }
    if (!step.unrecorded && step.how !== 'remove') files[step.rel] = step.hash;
  }
  const keys = missingKeys(source, root);
  if (keys.unreadable) log(`keys   ${keys.file} is not plain JSON: add Relevo's keys from keys.json by hand`);
  for (const [combo, command] of Object.entries(keys.add)) log(`key    ${combo} → ${command}`);
  for (const move of keys.moved) log(`key    ${move}`);
  for (const taken of keys.taken) log(`key    ${taken} not added: you use that key for something else`);
  if (!dry) {
    if (Object.keys(keys.add).length || keys.moved.length) {
      // A linked keys.json stays linked: the file it points to is the one replaced.
      const real = fs.existsSync(keys.file) ? fs.realpathSync(keys.file) : keys.file;
      if (fs.existsSync(real)) writeAtomic(path.join(backup, 'keys.json'), fs.readFileSync(real));
      writeAtomic(real, `${JSON.stringify({ ...keys.theirs, 'layout:relevo': keys.section }, null, 2)}\n`);
    }
    writeAtomic(manifestPath(root), `${JSON.stringify({ version: versionOf(source), installedAt: new Date().toISOString(), files, keys: keys.ours }, null, 2)}\n`);
    // The Herdr app's PATH has no node from fnm or nvm: Runs start the node this install ran with.
    writeAtomic(path.join(root, STATE, 'node'), `${process.execPath}\n`);
    if (steps.some((step) => !['same', 'keep', 'stay'].includes(step.how) && /^mods\/relevo\/(runtime|lib)\//.test(step.rel))) stopIdleCoordinator(root, { log, ...coordinator });
  }
  const summary = [...Object.entries(count).filter(([how]) => how !== 'same' && how !== 'stay').map(([how, n]) => `${n} ${how}`),
    ...(Object.keys(keys.add).length + keys.moved.length ? [`${Object.keys(keys.add).length + keys.moved.length} keys`] : [])].join(', ');
  log(`${dry ? 'Would install' : 'Installed'} Relevo ${versionOf(source)} in ${root}: ${summary || 'nothing to change'}.`);
  if (!dry && fs.existsSync(backup)) log(`What it replaced is in ${backup}`);
  if (!dry) pruneBackups(root);
  return { steps, keys, count };
}

export function uninstall({ root, dry = false, log = () => {} }) {
  const manifest = readManifest(root);
  if (!manifest) throw Error(`No install record in ${root}: nothing to remove`);
  let removed = 0, kept = 0;
  for (const [rel, was] of Object.entries(manifest.files)) {
    const target = confinedPath(root, rel), now = read(target);
    if (!now) continue;
    if (sha(now) !== was) { kept++; log(`kept   ${rel} (you changed it)`); continue; }
    removed++;
    if (!dry) { fs.rmSync(target); fs.rmSync(`${target}.new`, { force: true }); }
  }
  if (!dry) {
    fs.rmSync(manifestPath(root));
    // Folders it emptied go; one that still holds config.js, icons or a kept file stays.
    for (const mod of MODS) for (const dir of walkDirs(path.join(root, 'mods', mod))) { try { fs.rmdirSync(dir); } catch { /* not empty */ } }
  }
  log(`${dry ? 'Would remove' : 'Removed'} ${removed} files from ${root}${kept ? `; kept ${kept}` : ''}. Your config.js, keys and Relevo's data stay.`);
  return { removed, kept };
}

function walkDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return [...fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => walkDirs(path.join(dir, entry.name))), dir];
}

const onPath = (name, env = process.env) => (env.PATH ?? '').split(path.delimiter).some((dir) => { try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch { return false; } });

const readSmoke = (root) => { try { return JSON.parse(fs.readFileSync(path.join(root, SMOKE_FILE), 'utf8')); } catch { return null; } };
const versionOut = (name, env) => onPath(name, env) ? /\d+\.\d+\.\d+\S*/.exec(spawnSync(name, ['--version'], { env, encoding: 'utf8' }).stdout ?? '')?.[0] ?? null : null;
const currentVersions = (env) => ({ app: versionOut('herdr-app', env), core: versionOut('hc', env) });

// Records the result whatever it is, so the mod does not run it again for the same Herdr.
export async function smokeTest({ root, env = process.env, log = () => {}, run }) {
  run ??= async (command, args) => {
    const r = spawnSync(command, args, { env, encoding: 'utf8', timeout: 120000 });
    if (r.error) throw r.error;
    return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const modsDir = path.join(root, 'mods');
  const installed = MODS.filter((mod) => fs.existsSync(path.join(modsDir, mod, 'mod.json')));
  const result = await smoke({ run, modsDir, installed });
  for (const r of result.results) log(`${r.level === 'fail' ? 'FAIL' : r.level.padEnd(4)}  ${r.text}`);
  if (result.app && result.core) writeAtomic(path.join(root, SMOKE_FILE), `${JSON.stringify(smokeRecord(result), null, 2)}\n`);
  log(result.failed ? `Smoke failed: ${result.failed} ${result.failed === 1 ? 'problem' : 'problems'}.` : 'Smoke passed.');
  return result;
}

export function doctor({ source, root, filesOnly = false, env = process.env, log = () => {} }) {
  let failed = 0;
  const ok = (text) => log(`ok    ${text}`), warn = (text) => log(`warn  ${text}`), fail = (text) => { failed++; log(`FAIL  ${text}`); };
  const manifest = readManifest(root);
  if (!manifest) { fail(`Relevo is not installed in ${root} (no install record). Run install.`); return { failed }; }
  const missing = [], changed = [], pending = [];
  for (const [rel, was] of Object.entries(manifest.files)) {
    const now = read(path.join(root, rel));
    if (!now) missing.push(rel); else if (sha(now) !== was) changed.push(rel);
    if (fs.existsSync(path.join(root, `${rel}.new`))) pending.push(rel);
  }
  const total = Object.keys(manifest.files).length;
  if (!total) fail('The install record lists no files. Run install.');
  for (const rel of missing) fail(`missing: ${rel}. Run install.`);
  for (const rel of changed) warn(`changed since install (kept as yours): ${rel}`);
  for (const rel of pending) warn(`${rel}.new waits: merge it into your file, then delete it`);
  if (total && !missing.length) ok(`${total} files of Relevo ${manifest.version}${changed.length ? `, ${changed.length} changed by you` : ''}`);
  if (fs.existsSync(path.join(root, CONFIG))) ok('config.js is there'); else fail(`${CONFIG} is missing. Run install.`);
  const node = read(path.join(root, STATE, 'node'))?.toString().trim();
  if (!node) fail('Relevo does not know which node runs its Runs. Run install.');
  else { try { fs.accessSync(node, fs.constants.X_OK); ok(`Runs use ${node}`); } catch { fail(`Runs use ${node}, which is gone. Run install again.`); } }
  const current = source && fs.existsSync(path.join(source, 'CHANGELOG.md')) ? versionOf(source) : null;
  if (current && current !== manifest.version) warn(`installed ${manifest.version}, this checkout is ${current}: run install to update`);
  // The same version can still lag: merged work lands before a release.
  const behind = current ? plan(source, root).filter((step) => ["new", "update", "adopt", "remove"].includes(step.how) && !step.unrecorded).length : 0;
  if (behind) warn(`the install is behind this checkout: ${behind} ${behind === 1 ? "file differs" : "files differ"}. Run install to update`);
  if (filesOnly) return { failed };

  for (const mod of COMMUNITY) if (fs.existsSync(path.join(root, 'mods', mod))) ok(`mod ${mod}`); else fail(`mod ${mod} is missing: install it from herdr.dev`);
  const herdr = currentVersions(env), record = readSmoke(root);
  if (smokeDue(record, herdr)) warn(`herdr-app ${herdr.app} / hc ${herdr.core} not smoke-tested yet: run smoke`);
  else if (record && !record.passed) fail(`smoke failed on herdr-app ${record.app} / hc ${record.core}: ${record.failures[0] ?? 'see smoke'}`);
  else if (record) ok(`smoke passed on herdr-app ${record.app} / hc ${record.core}`);
  if (fs.existsSync(path.join(root, 'mods/space-folders'))) warn(`the space-folders mod is no longer needed: Spaces keeps the same folders. Remove ${path.join(root, 'mods/space-folders')}`);
  if (source) {
    const keys = missingKeys(source, root);
    if (keys.unreadable) warn('keys.json is not plain JSON: check Relevo\'s keys by hand');
    else if (Object.keys(keys.add).length + keys.moved.length) warn(`${Object.keys(keys.add).length + keys.moved.length} of Relevo's keys are not in keys.json (${[...Object.values(keys.add), ...keys.moved].join(', ')}): run install`);
    else ok('keys');
  }
  for (const name of ['git', 'gh', 'hc', 'jq']) if (onPath(name, env)) ok(name); else fail(`${name} is not on PATH`);
  if (!onPath('claude', env) && !onPath('codex', env)) fail('neither claude nor codex is on PATH'); else ok(['claude', 'codex'].filter((name) => onPath(name, env)).join(' and '));
  if (!onPath('terminal-notifier', env)) warn('terminal-notifier is not installed: a click on an alert will not land on the agent');
  const wanted = Number(read(path.join(source ?? '', '.nvmrc'))?.toString().trim()), have = Number(process.versions.node.split('.')[0]);
  if (wanted && have < wanted) fail(`Node ${have} runs this; Runs need Node ${wanted} or newer`); else ok(`node ${process.versions.node}`);
  if (onPath('gh', env) && spawnSync('gh', ['auth', 'status'], { env, stdio: 'ignore' }).status !== 0) warn('gh is not signed in: run gh auth login');
  const hook = path.join(root, 'mods/relevo/hooks/relevo-labels.sh');
  if (fs.existsSync(hook) && onPath('jq', env)) {
    const check = spawnSync('bash', [hook, '--check'], { env, encoding: 'utf8' });
    if (check.status === 0) ok('hook installed in every account');
    else {
      const q = /[^\w./@-]/.test(hook) ? `'${hook.replaceAll("'", "'\\''")}'` : hook;
      warn(`the optional hook is not installed in every account (account chips, resumed handoffs, whole permission cards): ${(check.stdout ?? '').trim().split('\n').join('; ')}. To set it up: bash ${q} --install (see hooks/HOOK.md)`);
    }
  }
  return { failed };
}

export function main(argv, { log = console.log, env = process.env } = {}) {
  const [command, ...rest] = argv, options = { source: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    root: env.HERDR_APP_HOME || path.join(env.HOME ?? os.homedir(), '.config/herdr-app') };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dry-run') options.dry = true;
    else if (rest[i] === '--files-only') options.filesOnly = true;
    else if (rest[i] === '--only' && rest[i + 1]) { try { options.panels = parsePanels(rest[++i]); } catch (error) { log(`relevo: ${error.message}`); return 2; } }
    else if ((rest[i] === '--root' || rest[i] === '--source') && rest[i + 1]) options[rest[i].slice(2)] = path.resolve(rest[++i]);
    else { log(`Unknown option: ${rest[i]}\n\n${HELP}`); return 2; }
  }
  try {
    if (command === 'install') install({ ...options, log });
    else if (command === 'uninstall') uninstall({ ...options, log });
    else if (command === 'doctor') return doctor({ ...options, env, log }).failed ? 1 : 0;
    else if (command === 'smoke') return smokeTest({ root: options.root, env, log }).then((r) => (r.failed ? 1 : 0), (error) => { log(`relevo: ${error.message}`); return 1; });
    else { log(HELP); return command === 'help' || command === '--help' || command === '-h' ? 0 : 2; }
    return 0;
  } catch (error) { log(`relevo: ${error.message}`); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) Promise.resolve(main(process.argv.slice(2))).then((code) => { process.exitCode = code; });
