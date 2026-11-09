import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [root, app, core] = process.argv.slice(2);
const manifest = path.join(root, 'demo-seed.json');
const call = (exe, ...args) => {
  const r = spawnSync(exe, args, { encoding: 'utf8' });
  if (r.status !== 0) throw Error(`Command failed; no retry: ${r.stderr}`);
  return JSON.parse(r.stdout);
};
const listed = () => {
  const result = call(core, 'ls', '--json');
  if (!Array.isArray(result.terminals)) throw Error('Unexpected core listing');
  return result.terminals;
};
const existing = listed();
if (fs.existsSync(manifest)) {
  const saved = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const expected = new Set((saved.created ?? []).map((r) => r.terminal));
  if (saved.complete && expected.size === 2 && existing.length === 2 && existing.every((r) => expected.has(r.address))) {
    console.log('Already seeded; nothing changed.'); process.exit(0);
  }
  throw Error('Previous seed partial or changed; inspect demo-seed.json');
}
if (existing.length) throw Error('Preview core not empty; refusing to alter terminals');
const pty = spawnSync('/usr/bin/script', ['-q', '/dev/null', '/usr/bin/true'], { stdio: ['inherit', 'pipe', 'pipe'] });
if (pty.status !== 0) throw Error('PTY preflight failed');
const saved = { complete: false, created: [], synthetic: true };
const save = () => fs.writeFileSync(manifest, JSON.stringify(saved, null, 2)); save();
const fixtures = [
  ['Preview Example A', 'Demo agent · decision', 'blocked', 'Synthetic decision: inspect Inbox'],
  ['Preview Example B', 'Demo agent · review', 'idle', 'Synthetic checks complete; no tests or agents executed'],
];
const program = 'printf "\\033]0;%s\\007" "$1"; printf "\\nRELEVO NATIVE PREVIEW | SYNTHETIC DATA ONLY\\n%s\\nNo agent, account, repository or paid API is connected.\\n" "$2"; printf "\\033]7501;%s\\007" "$3"; trap "exit 0" TERM INT HUP; while :; do /bin/sleep 3600 & wait $!; done';
for (const [index, [space, tab, state, message]] of fixtures.entries()) {
  const folder = path.join(root, 'home', `demo-${index + 1}`); fs.mkdirSync(folder, { recursive: true });
  const report = `state=${state}:app=relevo-demo:msg=${Buffer.from(message).toString('base64')}${state === 'blocked' ? ':kind=question' : ''}`;
  const made = call(app, 'do', 'space.new', JSON.stringify({ name: space, tab, folder, machine: '', argv: ['/bin/sh', '-c', program, 'preview', tab, message, report] }));
  if (!['space', 'tab', 'terminal'].every((k) => typeof made[k] === 'string')) throw Error('Unexpected creation result; inspect partial manifest');
  saved.created.push(made); save();
  call(core, 'label', made.terminal, 'relevo.preview=synthetic', `relevo.fixture=${index + 1}`);
}
saved.observed = listed(); saved.details = saved.created.map((r) => call(core, 'get', r.terminal, '--json'));
saved.complete = saved.observed.length === 2 && saved.details.every((d, i) => d.reported && d.status?.state === fixtures[i][2]);
save(); console.log(JSON.stringify(saved, null, 2));
if (!saved.complete) throw Error('Native fixture count/status differs; no automatic retry');
