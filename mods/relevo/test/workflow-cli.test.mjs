import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as immediate } from 'node:timers';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ensureEngine, main, parseArgs, serve } from '../runtime/cli.mjs';

async function fixture(fn) {
  const home = await fs.promises.realpath(await mkdtemp(join(tmpdir(), 'relevo-cli-')));
  try { await fn(home); } finally { await rm(home, { recursive: true, force: true }); }
}

test('CLI parser requires an absolute home and one JSON command payload', () => {
  assert.throws(() => parseArgs(['--home', 'relative', 'command', '{}']), /absolute/);
  assert.throws(() => parseArgs(['--home', '/tmp/h', 'command', '{']), /valid JSON/);
  assert.deepEqual(parseArgs(['--home', '/tmp/h', 'command', '{"action":"read"}']), {
    home: '/tmp/h', action: 'command', payload: { action: 'read' },
  });
});

test('import-safe CLI entrypoint prints JSON and uses exit code one for command errors', async () => fixture(async (home) => {
  const cli = fileURLToPath(new URL('../runtime/cli.mjs', import.meta.url));
  const ok = spawnSync(process.execPath, [cli, '--home', home, 'command', '{"action":"read"}'], { encoding: 'utf8' });
  assert.equal(ok.status, 0); assert.ok(JSON.parse(ok.stdout).doc);
  const bad = spawnSync(process.execPath, [cli, '--home', home, 'command', '{"action":"missing"}'], { encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(JSON.parse(bad.stdout).error, /Task is no longer available/);
}));

test('command returns document JSON and reports errors with exit code one', async () => fixture(async (home) => {
  const runtimeFactory = () => ({ command: async () => ({ doc: { engine: { enabled: false }, tasks: [] }, result: { ok: true } }), read: () => ({}) });
  const success = await main(['--home', home, 'command', '{"action":"read"}'], { runtimeFactory });
  assert.equal(success.code, 0); assert.equal(success.output.doc.engine.enabled, false);
  const failure = await main(['--home', home, 'command', '{}'], { runtimeFactory: () => ({ command: async () => { throw Error('rejected'); } }) });
  assert.deepEqual(failure, { code: 1, output: { error: 'rejected' } });
}));

test('only explicit work starts attach an engine, and start failures report the saved command result', async () => fixture(async (home) => {
  const doc = { engine: { enabled: true }, tasks: [{ id: 'task-1', state: 'ready' }] };
  const runtimeFactory = () => ({ command: async () => ({ doc, result: { taskId: 'task-1' } }), read: () => doc });
  const passive = await main(['--home', home, 'command', '{"action":"create"}'], { runtimeFactory, ensureEngine: async () => assert.fail('create must not start the engine') });
  assert.equal(passive.code, 0); assert.equal(passive.output.doc, doc);
  const active = await main(['--home', home, 'command', '{"action":"start"}'], { runtimeFactory, ensureEngine: async () => { throw Error('hc unavailable'); } });
  assert.equal(active.code, 1); assert.deepEqual(active.output, { doc, result: { taskId: 'task-1' }, error: 'hc unavailable', saved: true });
  let ensured = 0;
  const retry = await main(['--home', home, 'command', '{"action":"retry-review","taskId":"task-1"}'], { runtimeFactory, ensureEngine: async () => { ensured++; } });
  assert.equal(retry.code, 0); assert.equal(ensured, 1);
}));

test('engine launch uses hc background name and does not duplicate a live lock owner', async () => fixture(async (home) => {
  const calls = [], runCommand = async (argv) => {
    calls.push(argv);
    if (argv[1] === 'get') return { code: 0, stdout: JSON.stringify({ state: 'idle', argv: ['/abs/node', '/abs/cli.mjs', '--home', home, 'serve'] }) };
    return { code: 0, stdout: '', stderr: '' };
  };
  const options = { runCommand, cli: '/abs/cli.mjs', node: '/abs/node' };
  await ensureEngine(home, options);
  assert.deepEqual(calls[0].slice(0, 9), ['hc', 'run', '--bg', '--name', calls[0][4], '--outlive-parent', '--no-notify', '--', '/abs/node']);
  assert.deepEqual(calls[0].slice(9), ['/abs/cli.mjs', '--home', home, 'serve']);
  const lock = join(home, 'relevo-workflow', 'engine.lock'); await mkdir(lock, { recursive: true });
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'active' }));
  await ensureEngine(home, options); assert.equal(calls.length, 2); assert.equal(calls[1][1], 'get');
}));

test('acceptance restores an enabled coordinator only for already-started eligible follow-ups', async () => fixture(async (home) => {
  let launches = 0;
  const doc = { engine: { enabled: true }, tasks: [{ id: 'a', state: 'accepted' }, { id: 'b', state: 'ready', dependsOn: ['a'], paused: false }] };
  const deps = { runtimeFactory: () => ({ command: async () => ({ doc }), read: () => doc }), ensureEngine: async () => { launches++; } };
  const command = ['--home', home, 'command', '{"action":"decide","taskId":"a","outcome":"accept"}'];
  assert.equal((await main(command, deps)).code, 0); assert.equal(launches, 1);
  doc.engine.enabled = false; await main(command, deps); assert.equal(launches, 1, 'explicit stop remains stopped');
  doc.engine.enabled = true; doc.tasks[1].state = 'planned'; await main(command, deps); assert.equal(launches, 1, 'unstarted work remains unstarted');
  doc.tasks[1].state = 'ready'; doc.tasks[1].paused = true; await main(command, deps); assert.equal(launches, 1, 'paused work remains paused');
}));

test('a same-name terminal with a different command is never treated as this home engine', async () => fixture(async (home) => {
  let calls = 0;
  await assert.rejects(ensureEngine(home, { cli: '/abs/cli.mjs', node: '/abs/node', runCommand: async () => {
    calls++;
    return calls === 1 ? { code: 1, stderr: 'name already used' } : { code: 0, stdout: JSON.stringify({ state: 'idle', argv: ['/abs/node', '/other/cli.mjs', '--home', home, 'serve'] }) };
  } }), /name already used/);
}));

test('serve recovers once, serializes report and agent wakes, and exits when engine is disabled', async () => fixture(async (home) => {
  await mkdir(join(home, 'relevo-workflow', 'reports'), { recursive: true });
  const processRef = new EventEmitter(), timeouts = [], intervals = [], spawnCalls = [], killed = [];
  const timers = {
    setTimeout(fn) { const t = { fn }; timeouts.push(t); return t; }, clearTimeout() {},
    setInterval(fn) { const t = { fn }; intervals.push(t); return t; }, clearInterval() {},
  };
  const doc = { engine: { enabled: true }, tasks: [
    { state: 'ready', paused: false, executor: { address: 't1' }, reviewer: { address: 't2' } },
    { state: 'blocked', paused: true, attempts: [{ role: 'executor', state: 'running', delivery: 'uncertain' }], executor: { address: 't3' }, reviewer: { address: 't4' } },
    { state: 'planned', paused: false, attempts: [], messages: [{ status: 'queued' }], executor: { address: 't5' }, reviewer: { address: 't6' } },
  ] };
  let recoveries = 0, active = 0, maxActive = 0, ticks = 0, reportsChanged, wakeChanged;
  const runtimeFactory = () => ({
    recover() { recoveries++; }, read: () => doc,
    async tick() { active++; maxActive = Math.max(maxActive, active); ticks++; await Promise.resolve(); active--; },
  });
  const spawnImpl = (command, args) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = (signal) => killed.push(signal);
    spawnCalls.push({ command, args, child }); return child;
  };
  const fsImpl = Object.create(fs); fsImpl.watch = (path, wake) => { if (path.endsWith('reports')) reportsChanged = wake; else wakeChanged = wake; return { close() {} }; };
  const serving = serve(home, { runtimeFactory, fsImpl, timers, processRef, spawnImpl, pid: 424242 });
  await new Promise((resolve) => immediate(resolve));
  assert.equal(recoveries, 1);
  assert.deepEqual(spawnCalls.map(({ command, args }) => [command, args]), [
    ...['t1', 't2', 't3', 't4', 't5', 't6'].map((terminal) => ['hc', ['events', '--json', '--terminal', terminal]]),
  ]);
  reportsChanged(); spawnCalls[0].child.stdout.emit('data', 'private terminal fact'); timeouts.at(-1).fn();
  await new Promise((resolve) => immediate(resolve));
  assert.equal(maxActive, 1);
  doc.engine.enabled = false; wakeChanged('change', 'engine.wake'); timeouts.at(-1).fn();
  await serving;
  assert.deepEqual(killed, Array(6).fill('SIGTERM'));
  await assert.rejects(readFile(join(home, 'relevo-workflow', 'engine.lock', 'owner.json')));
}));

test('a live coordinator lock blocks a second daemon without recovery', async () => fixture(async (home) => {
  const dir = join(home, 'relevo-workflow', 'engine.lock'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'owner' }));
  let recovered = 0;
  await assert.rejects(serve(home, { runtimeFactory: () => ({ recover() { recovered++; }, read: () => ({ engine: { enabled: false }, tasks: [] }) }), pid: 525252 }), /already running/);
  assert.equal(recovered, 0);
}));

test('a stale lock is reclaimed under a startup guard before recovery runs', async () => fixture(async (home) => {
  const dir = join(home, 'relevo-workflow'), lock = join(dir, 'engine.lock');
  await mkdir(join(dir, 'reports'), { recursive: true }); await mkdir(lock);
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 0, token: 'stale' }));
  const processRef = new EventEmitter(); let recoveries = 0;
  const runtimeFactory = () => ({ recover() { recoveries++; }, read: () => ({ engine: { enabled: false }, tasks: [] }) });
  await serve(home, { runtimeFactory, processRef, eventWatch: () => ({ close() {} }) });
  assert.equal(recoveries, 1); assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(join(dir, 'engine.acquire')), false);
}));

test('shutdown retains the lock until an in-flight coordinator tick finishes', async () => fixture(async (home) => {
  await mkdir(join(home, 'relevo-workflow', 'reports'), { recursive: true });
  const processRef = new EventEmitter(), timeouts = []; let wakeChanged;
  const timers = { setTimeout(fn) { const t = { fn }; timeouts.push(t); return t; }, clearTimeout() {}, setInterval() { return 1; }, clearInterval() {} };
  const doc = { engine: { enabled: true }, tasks: [] }; let releaseTick;
  const runtimeFactory = () => ({ recover() {}, read: () => doc, tick: () => new Promise((resolve) => { releaseTick = resolve; }) });
  const fsImpl = Object.create(fs); fsImpl.watch = (path, wake) => { if (!path.endsWith('reports')) wakeChanged = wake; return { close() {} }; };
  const serving = serve(home, { runtimeFactory, fsImpl, timers, processRef, eventWatch: () => ({ close() {} }), pid: 626262 });
  await new Promise((resolve) => immediate(resolve));
  doc.engine.enabled = false; wakeChanged('change', 'engine.wake');
  assert.equal(fs.existsSync(join(home, 'relevo-workflow', 'engine.lock')), true);
  releaseTick(); await serving;
  assert.equal(fs.existsSync(join(home, 'relevo-workflow', 'engine.lock')), false);
}));
