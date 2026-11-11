#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extract, text } from './snapshot-data.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.dirname(HERE);
// The real home is passed only by this launcher; child environments use the isolated HOME.
const HOME = process.env.RELEVO_SOURCE_HOME || os.homedir();
const ROOT = `/private/tmp/herdr-relevo-snapshot-${process.getuid()}`;
const APP = path.join(HOME, 'Applications/Herdr.app/Contents/MacOS/Herdr'), CORE_ROOT = path.join(HOME, '.local/share/herdr-core');
const CORE = path.join(CORE_ROOT, 'current/Contents/MacOS/herdr-core'), NODE = fs.realpathSync(process.execPath);
const SOURCE = path.join(HOME, '.local/state/herdr-core/default');
const join = (p) => path.join(ROOT, p), write = (p, v) => fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
export const INERT_CONFIG = `// Inert snapshot configuration, never copied from user settings.
export const ACCOUNTS = [];
export const CODEX = {key:"codex",label:"Copia local",letter:"C",launcher:"",bg:"#4fd6be",fg:"#1e2030"};
export const CONTEXTS = [{key:"snapshot",label:"Snapshot",account:null,color:"ansi4"}];
export const FALLBACK = [];
export const REPOS_ROOT = "workspaces";
export const BACKUPS_ROOT = "backups";
export const SKILLS = {};
export const REPLIES = [];
`;
export function profile(extraction = false) {
  const q = JSON.stringify;
  let s = `(version 1)\n(allow default)\n(deny network*)\n(deny file-write*)\n(allow file-write* (subpath ${q(ROOT)}))\n(allow file-write-data (literal "/dev/null"))\n(deny file-read* (subpath ${q(HOME)}))\n`;
  for (const p of [NODE]) s += `(allow file-read* (literal ${q(p)}))\n`;
  if (extraction) s += `(allow file-read* (literal ${q(path.join(SOURCE, 'docs.json'))}) (literal ${q(path.join(SOURCE, 'terminals.json'))}))\n(deny process-fork)\n(deny process-exec)\n(allow process-exec (literal ${q(NODE)}))\n`;
  else s += `(allow file-read* (subpath ${q(path.join(HOME, 'Applications/Herdr.app'))}) (subpath ${q(CORE_ROOT)}))\n(allow network* (local unix-socket (subpath ${q(ROOT)})) (remote unix-socket (subpath ${q(ROOT)})))\n(allow file-write-data (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$"))\n`;
  return s;
}
function environment() {
  return { HOME: join('home'), RELEVO_SOURCE_HOME: HOME, USER: String(process.getuid()), LOGNAME: String(process.getuid()), PATH: `${join('bin')}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: '/bin/sh', TMPDIR: join('tmp/'), XDG_CONFIG_HOME: join('config'), XDG_STATE_HOME: join('state'), XDG_DATA_HOME: join('data'), XDG_CACHE_HOME: join('cache'), XDG_RUNTIME_DIR: join('run'), HERDR_APP_HOME: join('app'), HERDR_APP_ID: 'dev.herdr.relevo.snapshot', HC_SESSION: 'relevo-snapshot', HC_SOCKET: join('run/core.sock'), HC_LAUNCHD_DIRECT: '1', DO_NOT_TRACK: '1', HERDR_TELEMETRY: '0', HERDR_APP_NO_SOUND: '1', HERDR_RELEASES_URL: 'http://127.0.0.1:9' };
}
function run(args, extraction = false, capture = false) {
  return spawnSync('/usr/bin/sandbox-exec', ['-f', join(extraction ? 'extract.sb' : 'preview.sb'), ...args], { env: environment(), cwd: join('home'), encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
}
function ensure() {
  if (fs.lstatSync(ROOT).isSymbolicLink() || fs.readFileSync(join('.snapshot-owner'), 'utf8').trim() !== String(process.getuid())) throw Error('Snapshot ownership marker differs');
}
function inactive() {
  if (fs.existsSync(join('preview.sb')) && run([APP, 'status'], false, true).status === 0) throw Error('Snapshot app is running; no state overwritten');
  if (fs.existsSync(join('run/core.sock'))) throw Error('Snapshot core socket exists; stop this isolated core before refresh');
}
function readSnapshot() {
  const before = {}, objects = {};
  for (const key of ['docs', 'terminals']) {
    const p = path.join(SOURCE, `${key}.json`), raw = fs.readFileSync(p);
    before[key] = { sha256: crypto.createHash('sha256').update(raw).digest('hex'), mtimeNs: fs.statSync(p, { bigint: true }).mtimeNs.toString() };
    objects[key] = JSON.parse(raw);
  }
  const result = extract(objects.docs, objects.terminals.terminals ?? {});
  for (const [key, stamp] of Object.entries(before)) {
    const p = path.join(SOURCE, `${key}.json`);
    if (sha(p) !== stamp.sha256 || fs.statSync(p, { bigint: true }).mtimeNs.toString() !== stamp.mtimeNs) throw Error('Source changed; no snapshot published');
  }
  result.capturedAt = new Date().toISOString();
  result.sourceMtimes = Object.fromEntries(Object.entries(before).map(([k, v]) => [k, new Date(Number(BigInt(v.mtimeNs) / 1000000n)).toISOString()]));
  write(join('app/data/relevo-snapshot.json'), result);
  const tabs = result.spaces.flatMap((s) => s.tabs);
  write(join('app/shared.json'), { layout: 'relevo-snapshot', 'frame.welcomed': 'skipped', 'relevo.snapshot': result, 'relevo.inbox.count': tabs.length });
  write(join('source-verification.json'), { unchangedDuringRead: true, files: before });
  console.log(JSON.stringify({ spaces: result.spaces.length, tabs: tabs.length, terminals: tabs.flatMap((t) => t.terminals).length, sourceUnchanged: true }));
}
function walk(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(root, e.name)) : e.isFile() && e.name !== 'config.js' ? [path.join(root, e.name)] : []);
}
function setup(refresh) {
  if (fs.existsSync(ROOT)) {
    ensure(); inactive();
    if (!refresh && fs.existsSync(join('app/data/relevo-snapshot.json'))) throw Error('Already prepared: use run, or refresh to archive and reimport');
    if (refresh) fs.renameSync(ROOT, `${ROOT}-archive-${Date.now()}`);
  }
  if (!fs.existsSync(ROOT)) { fs.mkdirSync(ROOT, { mode: 0o700 }); write(join('.snapshot-owner'), String(process.getuid())); }
  for (const d of ['home', 'bin', 'config/herdr-core', 'state', 'data', 'cache', 'run', 'tmp', 'app/mods', 'app/layouts', 'app/data', 'archives', 'tools']) fs.mkdirSync(join(d), { recursive: true });
  for (const name of ['snapshot-herdr.mjs', 'snapshot-data.mjs', 'isolation-check.mjs']) fs.copyFileSync(path.join(HERE, name), join(`tools/${name}`));
  for (const name of ['extract.sb', 'preview.sb']) write(join(name), profile(name === 'extract.sb'));
  if (fs.existsSync(join('app/shared.json'))) {
    const archive = join(`archives/${Date.now()}`); fs.mkdirSync(archive);
    for (const name of ['shared.json', 'data/relevo-snapshot.json']) if (fs.existsSync(join(`app/${name}`))) fs.copyFileSync(join(`app/${name}`), path.join(archive, path.basename(name)));
  }
  fs.cpSync(path.join(REPO, 'mods'), join('app/mods'), { recursive: true, filter: (p) => !['config.js', 'node_modules', '.git'].includes(path.basename(p)) });
  write(join('app/mods/relevo/config.js'), INERT_CONFIG);
  fs.copyFileSync(path.join(REPO, 'layouts/relevo-snapshot.json'), join('app/layouts/relevo-snapshot.json'));
  for (const [name, target] of [['hc', CORE], ['herdr-core', CORE], ['herdr-app', APP]]) if (!fs.existsSync(join(`bin/${name}`))) fs.symlinkSync(target, join(`bin/${name}`));
  write(join('config/herdr-core/config.toml'), 'notes = false\nshell = ["/bin/sh"]\n');
  write(join('app/settings.json'), { telemetry: false, clipboard_write: false, appearance: 'dark' });
  const hashes = Object.fromEntries([...walk(path.join(REPO, 'mods')), path.join(REPO, 'layouts/relevo-snapshot.json')].map((p) => [path.relative(REPO, p), sha(p)]));
  write(join('plugin-source-manifest.json'), { source: 'local development checkout; not asserted identical to installed plugin', sha256: hashes });
  if (run([NODE, join('tools/snapshot-herdr.mjs'), 'extract-internal'], true).status !== 0) throw Error('Sandboxed extraction failed; GUI not launched');
}
function call(exe, ...args) {
  const r = spawnSync(exe, args, { encoding: 'utf8' });
  if (r.status !== 0) throw Error('Snapshot command failed; stopped without retry');
  return JSON.parse(r.stdout);
}
function seed() {
  call(APP, 'status');
  const mapping = join('mapping.json');
  if (fs.existsSync(mapping)) throw Error('Snapshot already seeded or partial; no duplicates created');
  if (call(CORE, 'ls', '--json').terminals?.length) throw Error('Snapshot core not empty');
  const snap = JSON.parse(fs.readFileSync(join('app/data/relevo-snapshot.json'), 'utf8'));
  const mapped = { spaces: {}, tabs: {}, terminals: {}, complete: false }, save = () => write(mapping, mapped); save();
  const fixed = 'printf "%s\\n" "$1"; if [ "$2" = "agent" ]; then printf "\\033]7501;state=idle:app=relevo-snapshot:msg=SGlzdG9yaWNhbCBtZXRhZGF0YSBjb3B5OyBubyBsaXZlIGFnZW50\\007"; fi; trap "exit 0" TERM INT HUP; while :; do /bin/sleep 3600 & wait $!; done';
  const argv = (t) => ['/bin/sh', '-c', fixed, 'snapshot-viewer', `METADATA SNAPSHOT ONLY | NOT A LIVE AGENT\n${text(t.title)}\nSource ID: ${text(t.sourceId)}\nStatus at capture: ${t.status ?? 'unknown'}\nOriginal agent is not connected. No source command, messages or terminal output copied.`, t.reported === true ? 'agent' : 'plain'];
  for (const [i, s] of snap.spaces.entries()) {
    let space; const folder = join(`home/workspace-${i}`); fs.mkdirSync(folder, { recursive: true });
    for (const t of s.tabs) {
      const first = t.terminals[0] ?? { title: 'No terminal metadata', sourceId: '' };
      const args = space ? { space, name: `Copia · ${t.title}`, folder, argv: argv(first) } : { name: s.title, tab: `Copia · ${t.title}`, folder, machine: '', argv: argv(first) };
      const made = call(APP, 'do', space ? 'tab.new' : 'space.new', JSON.stringify(args));
      space = made.space ?? space; mapped.spaces[s.sourceId] = space; mapped.tabs[t.sourceId] = made.tab;
      if (t.terminals.length) mapped.terminals[first.sourceId] = made.terminal; save();
      let pane = made.pane;
      for (const leaf of t.terminals.slice(1)) {
        const split = call(APP, 'do', 'pane.split', JSON.stringify({ direction: 'right', pane, argv: argv(leaf) }));
        pane = split.pane; mapped.terminals[leaf.sourceId] = split.terminal; save();
      }
    }
  }
  mapped.complete = true; save(); console.log('Snapshot shell seeded; original IDs map only to isolated copies.');
}
async function main(command = 'help') {
  if (command === 'extract-internal') return readSnapshot();
  if (command === 'seed-internal') return seed();
  if (['setup', 'refresh'].includes(command)) return setup(command === 'refresh');
  if (command === 'help') return console.log('snapshot-herdr.sh setup|refresh|preflight|check|run|status|seed|shot|stop');
  ensure();
  if (command === 'run' && run([APP, 'status'], false, true).status === 0) throw Error('Snapshot already running');
  if (['run', 'seed'].includes(command) && fs.readFileSync(join('app/mods/relevo/config.js'), 'utf8') !== INERT_CONFIG) throw Error('Inert configuration differs; refresh required');
  if (command === 'preflight') {
    for (const source of ['docs.json', 'terminals.json']) if (run(['/bin/cat', path.join(SOURCE, source)], false, true).status === 0) throw Error('Runtime can read source');
    for (const extraction of [false, true]) if (run([NODE, join('tools/isolation-check.mjs'), ROOT, ...(extraction ? ['extract'] : [])], extraction).status !== 0) throw Error('Isolation preflight failed');
    if (run(['/usr/bin/true'], true, true).status === 0) throw Error('Extractor other executable permitted');
    return;
  }
  if (command === 'stop') {
    run([APP, 'do', 'app.quit'], false, true);
    process.exitCode = run([CORE, 'server', 'stop']).status ?? 1; return;
  }
  const args = { check: [APP, 'check', join('app/mods/relevo')], run: [APP], status: [APP, 'status'], shot: [APP, 'shot', join('snapshot.png')], seed: [NODE, join('tools/snapshot-herdr.mjs'), 'seed-internal'] }[command];
  if (!args) throw Error('Unknown command');
  process.exitCode = run(args).status ?? 1;
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main(process.argv[2]).catch((e) => { console.error(e.message); process.exitCode = 1; });
