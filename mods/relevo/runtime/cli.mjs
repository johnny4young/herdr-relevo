import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { run } from './process.mjs';
import { createRuntime } from './coordinator.mjs';
import { alive, privateDir, stateDir, transaction } from './store.mjs';

const cliPath = fileURLToPath(import.meta.url);
const liveTerminal = (value) => ['live', 'idle', 'working'].includes(value?.state) || ['live', 'idle', 'working'].includes(value?.status);
const engineName = (home) => `relevo-${createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 12)}`;
const terminalArgv = (value) => value?.argv ?? value?.command?.argv ?? value?.process?.argv ?? value?.foreground?.argv ?? value?.terminal?.argv;

export function parseArgs(argv) {
  const args = [...argv];
  if (args.shift() !== '--home') throw Error('Usage: cli.mjs --home ABSOLUTE_HOME command JSON | serve');
  const home = args.shift();
  if (!path.isAbsolute(home ?? '')) throw Error('--home must be an absolute path');
  const action = args.shift();
  if (action === 'serve' && args.length === 0) return { home: path.resolve(home), action };
  if (action !== 'command' || args.length !== 1) throw Error('Expected command JSON or serve');
  let payload;
  try { payload = JSON.parse(args[0]); } catch { throw Error('Command payload must be valid JSON'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('Command payload must be a JSON object');
  return { home: path.resolve(home), action, payload };
}

function acquireLock(home, pid = process.pid, fsImpl = fs) {
  const dir = privateDir(stateDir(home)), lock = path.join(dir, 'engine.lock'), guard = path.join(dir, 'engine.acquire');
  try { fsImpl.mkdirSync(guard, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw Error('Coordinator startup is already being resolved'); throw error; }
  try {
    try { fsImpl.mkdirSync(lock, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const lockStat = fsImpl.lstatSync(lock);
      if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) throw Error('Coordinator lock path is unsafe');
      let owner;
      try {
        const ownerPath = path.join(lock, 'owner.json'), ownerStat = fsImpl.lstatSync(ownerPath);
        if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) throw Error('Unsafe lock owner');
        owner = JSON.parse(fsImpl.readFileSync(ownerPath, 'utf8'));
      } catch { throw Error('Coordinator lock is incomplete; refusing to start a second engine'); }
      if (alive(owner.pid)) throw Error('Coordinator is already running');
      fsImpl.unlinkSync(path.join(lock, 'owner.json'));
      fsImpl.rmdirSync(lock);
      fsImpl.mkdirSync(lock, { mode: 0o700 });
    }
    const token = `${pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    fsImpl.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid, token }), { flag: 'wx', mode: 0o600 });
    return { lock, token };
  } finally { fsImpl.rmdirSync(guard); }
}

function releaseLock({ lock, token }, fsImpl = fs) {
  try {
    const owner = JSON.parse(fsImpl.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
    if (owner.token === token) { fsImpl.unlinkSync(path.join(lock, 'owner.json')); fsImpl.rmdirSync(lock); }
  } catch { /* A replaced or incomplete lock must remain untouched. */ }
}

export async function ensureEngine(home, { runCommand = run, cli = cliPath, node = process.execPath } = {}) {
  home = path.resolve(home); cli = path.resolve(cli);
  const name = engineName(home), expected = [node, cli, '--home', home, 'serve'];
  const lock = path.join(stateDir(home), 'engine.lock', 'owner.json');
  const currentForHome = async () => {
    const current = await runCommand(['hc', 'get', '--json', name], { timeout: 10000, limit: 8192 }).catch(() => ({ code: 1 }));
    if (current.code !== 0) return false;
    try {
      const value = JSON.parse(current.stdout), argv = terminalArgv(value);
      return liveTerminal(value) && Array.isArray(argv) && argv.length === expected.length && argv.every((arg, i) => arg === expected[i]);
    } catch { return false; }
  };
  try {
    if (alive(JSON.parse(fs.readFileSync(lock, 'utf8')).pid)) {
      if (await currentForHome()) { wakeEngine(home); return { code: 0, alreadyRunning: true }; }
      throw Error('Coordinator lock exists, but its named terminal command could not be verified');
    }
  } catch (error) { if (error.message.startsWith('Coordinator lock exists')) throw error; /* no owner or stale lock */ }
  const result = await runCommand(['hc', 'run', '--bg', '--name', name, '--outlive-parent', '--no-notify', '--', ...expected], { timeout: 45000, limit: 32768 });
  if (result.code !== 0) {
    if (await currentForHome()) { wakeEngine(home); return { code: 0, alreadyRunning: true }; }
    throw Error(result.stderr?.trim() || 'Could not start the Relevo coordinator');
  }
  return result;
}

function watchAgents(addresses, onChange, spawnImpl = spawn) {
  const children = new Map();
  let closed = false;
  for (const address of new Set(addresses)) {
    if (!/^[-a-zA-Z0-9_/]{1,80}$/.test(address)) continue;
    const child = spawnImpl('hc', ['events', '--json', '--terminal', address], { stdio: ['ignore', 'pipe', 'ignore'] });
    // Events are wake-ups only. Their payload is discarded and never logged or persisted.
    child.stdout?.on('data', () => onChange());
    child.on('error', () => { if (!closed) onChange(); });
    child.on('close', () => { if (!closed) onChange(); });
    children.set(address, child);
  }
  return { close() { closed = true; for (const child of children.values()) child.kill('SIGTERM'); children.clear(); } };
}

function wakeEngine(home) {
  try {
    const fd = fs.openSync(path.join(stateDir(home), 'engine.wake'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, `${Date.now()}\n`); } finally { fs.closeSync(fd); }
  } catch { /* The command can complete while the coordinator is starting. */ }
}

export async function waitForStop(home, { timeoutMs = 20000, fsImpl = fs, timers = globalThis } = {}) {
  const dir = stateDir(home), lock = path.join(dir, 'engine.lock');
  if (!fsImpl.existsSync(lock)) return;
  await new Promise((resolve, reject) => {
    let settled = false, watcher, timer;
    const finish = (error) => {
      if (settled) return; settled = true;
      timers.clearTimeout(timer); watcher.close(); error ? reject(error) : resolve();
    };
    const check = () => { if (!fsImpl.existsSync(lock)) finish(); };
    watcher = fsImpl.watch(dir, check);
    watcher.on?.('error', () => {});
    timer = timers.setTimeout(() => finish(Error(`Coordinator did not stop within ${Math.ceil(timeoutMs / 1000)} seconds`)), timeoutMs);
    check();
  });
}

export async function serve(home, { runtimeFactory = createRuntime, fsImpl = fs, timers = globalThis, pid = process.pid, processRef = process,
  spawnImpl = spawn, eventWatch = watchAgents, intervalMs = 3000, debounceMs = 150 } = {}) {
  const lock = acquireLock(home, pid, fsImpl);
  let runtime, stopped = false, released = false, running = false, queued = false, timer, debounce, watcher, wakeWatcher, agentWatcher, settle;
  let watchedAddresses = '';
  const reports = path.join(stateDir(home), 'reports');
  const done = new Promise((resolve) => { settle = resolve; });
  const schedule = () => {
    if (stopped) return;
    timers.clearTimeout(debounce);
    debounce = timers.setTimeout(() => { void tick(); }, debounceMs);
  };
  const refreshAgentWatch = () => {
    const doc = runtime.read();
    const addresses = doc.tasks.filter((task) => !['accepted', 'cancelled'].includes(task.state) &&
      (task.attempts?.at(-1)?.state === 'running' || task.state === 'running' || (!task.paused &&
        (['ready', 'needs_review'].includes(task.state) || task.messages?.some((message) => message.status === 'queued')))))
      .flatMap((task) => [task.executor?.address, task.reviewer?.address].filter(Boolean));
    const key = [...new Set(addresses)].sort().join('\0');
    if (key === watchedAddresses) return;
    agentWatcher?.close(); watchedAddresses = key;
    agentWatcher = eventWatch(addresses, schedule, spawnImpl);
  };
  const tick = async () => {
    if (stopped) return;
    if (running) { queued = true; return; }
    running = true;
    try { await runtime.tick(); refreshAgentWatch(); }
    catch (error) {
      try { transaction(home, (doc) => { doc.engine.enabled = false; doc.engine.error = String(error?.message ?? error).slice(0, 1000); }); } catch { /* Preserve shutdown even if state storage is unavailable. */ }
      stop();
    }
    finally {
      running = false;
      if (stopped) finish();
      else if (queued) { queued = false; void tick(); }
    }
  };
  const finish = () => {
    if (!stopped || released || running) return;
    released = true;
    watcher?.close(); wakeWatcher?.close(); agentWatcher?.close();
    processRef.removeListener?.('SIGTERM', stop); processRef.removeListener?.('SIGINT', stop);
    releaseLock(lock, fsImpl); settle();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true; timers.clearInterval(timer); timers.clearTimeout(debounce);
    finish();
  };
  const onWake = (_event, filename) => {
    if (filename?.toString() !== 'engine.wake') return;
    try { if (!runtime.read().engine.enabled) { stop(); return; } } catch { /* Repairable state errors should not kill the daemon. */ }
    schedule();
  };
  try {
    runtime = runtimeFactory({ home });
    runtime.recover();
    if (runtime.read().engine.error) transaction(home, (doc) => { delete doc.engine.error; });
    watcher = fsImpl.watch(reports, schedule); watcher.on?.('error', () => {});
    wakeWatcher = fsImpl.watch(stateDir(home), onWake); wakeWatcher.on?.('error', () => {});
    processRef.on?.('SIGTERM', stop); processRef.on?.('SIGINT', stop);
    refreshAgentWatch();
    timer = timers.setInterval(() => {
      let doc;
      try { doc = runtime.read(); } catch { return; }
      if (!doc.engine.enabled) { stop(); return; }
      // Periodic work is reserved for attempt deadlines; normal progress comes from terminal and report events.
      const now = Date.now();
      if (doc.tasks.some((task) => ['running', 'blocked'].includes(task.state) && task.attempts.at(-1)?.state === 'running' && !task.attempts.at(-1).timedOut &&
        now - Date.parse(task.attempts.at(-1).at) >= task.maxMinutes * 60000)) void tick();
    }, intervalMs);
    let enabled = false;
    try { enabled = runtime.read().engine.enabled; } catch { /* surfaced by the next tick/read */ }
    if (enabled) await tick(); else stop();
    await done;
  } finally { if (!stopped) stop(); }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  let parsed;
  try { parsed = parseArgs(argv); }
  catch (error) { return { code: 1, output: { error: error.message } }; }
  try {
    if (parsed.action === 'serve') {
      await serve(parsed.home, deps);
      return { code: 0, output: { ok: true } };
    }
    const runtime = (deps.runtimeFactory ?? createRuntime)({ home: parsed.home });
    const result = await runtime.command(parsed.payload);
    const doc = result?.doc ?? runtime.read();
    const action = parsed.payload.action;
    const startsWork = ['start', 'resume', 'retry-review'].includes(action) || (action === 'decide' && parsed.payload.outcome === 'changes') ||
      (action === 'batch' && parsed.payload.outcome === 'changes' && parsed.payload.preview === false);
    const acceptedIds = parsed.payload.outcome === 'accept' ? action === 'decide' ? [parsed.payload.taskId]
      : action === 'batch' && parsed.payload.preview === false ? parsed.payload.ids ?? [] : [] : [];
    const continuesWork = (doc.tasks ?? []).some((task) => task.state === 'ready' && !task.paused &&
      task.dependsOn?.some((id) => acceptedIds.includes(id)) && task.dependsOn.every((id) => doc.tasks.some((parent) => parent.id === id && parent.state === 'accepted')));
    const keepsEngineBusy = ['message', 'skill'].includes(action);
    const passive = ['read', 'create', 'refresh', 'suggest-preferences'].includes(action);
    const response = result ?? { doc };
    if (doc?.engine?.enabled && (startsWork || keepsEngineBusy || continuesWork)) {
      try { await (deps.ensureEngine ?? ensureEngine)(parsed.home, deps.engineOptions); }
      catch (error) { return { code: 1, output: { ...response, doc, error: String(error?.message ?? error), saved: true } }; }
    } else if (!passive && doc?.engine?.enabled) wakeEngine(parsed.home);
    else if (action === 'stop') {
      wakeEngine(parsed.home);
      try { await (deps.waitForStop ?? waitForStop)(parsed.home, deps.stopOptions); }
      catch (error) { return { code: 1, output: { ...response, doc, error: String(error?.message ?? error), saved: true } }; }
    }
    return { code: 0, output: response };
  } catch (error) {
    return { code: 1, output: { error: String(error?.message ?? error) } };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === cliPath) {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result.output)}\n`);
  process.exitCode = result.code;
}
