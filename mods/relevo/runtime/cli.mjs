import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { run } from './process.mjs';
import { attemptDue, createRuntime } from './coordinator.mjs';
import { acquireOwned, alive, privateDir, releaseOwned, stateDir, transaction } from './store.mjs';
import { needsEngine } from '../lib/engine.js';

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

// A pid is this home's coordinator only while its command line says so: after a crash the number can go to another process.
export function isEngine(pid, home, { cli = cliPath, spawnImpl = spawnSync } = {}) {
  if (!alive(pid)) return false;
  const ps = spawnImpl('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
  const command = String(ps.stdout ?? '');
  return command.includes(cli) && command.includes(`--home ${path.resolve(home)} serve`);
}
const ownerPid = (home) => {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir(home), 'engine.lock', 'owner.json'), 'utf8')).pid; } catch { return null; }
};
export const engineRunning = (home, check = isEngine) => { const pid = ownerPid(home); return pid != null && check(pid, home); };

const ENGINE_ERRORS = { guard: 'Coordinator startup is already being resolved', unsafe: 'Coordinator lock path is unsafe',
  incomplete: 'Coordinator lock is incomplete; refusing to start a second engine', held: 'Coordinator is already running' };

export async function ensureEngine(home, { runCommand = run, cli = cliPath, node = process.execPath, check = isEngine } = {}) {
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
    if (check(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, home, { cli })) {
      if (await currentForHome()) { wakeEngine(home); return { code: 0, alreadyRunning: true }; }
      throw Error('Coordinator lock exists, but its named terminal command could not be verified');
    }
  } catch (error) { if (error.message.startsWith('Coordinator lock exists')) throw error; /* no owner or stale lock */ }
  // --rm: a coordinator that rests when idle would otherwise leave a finished terminal each time.
  const result = await runCommand(['hc', 'run', '--bg', '--name', name, '--outlive-parent', '--no-notify', '--rm', '--', ...expected], { timeout: 45000, limit: 32768 });
  if (result.code !== 0) {
    if (await currentForHome()) { wakeEngine(home); return { code: 0, alreadyRunning: true }; }
    throw Error(result.stderr?.trim() || 'Could not start the Relevo coordinator');
  }
  return result;
}

function watchAgents(addresses, onChange, spawnImpl = spawn) {
  const children = new Map();
  let closed = false, broken = false;
  const ended = () => { if (!closed) { broken = true; onChange(); } };
  for (const address of new Set(addresses)) {
    if (!/^[-a-zA-Z0-9_/]{1,80}$/.test(address)) continue;
    const child = spawnImpl('hc', ['events', '--json', '--terminal', address], { stdio: ['ignore', 'pipe', 'ignore'] });
    // Events are wake-ups only. Their payload is discarded and never logged or persisted.
    child.stdout?.on('data', () => onChange());
    child.on('error', ended);
    child.on('close', ended);
    children.set(address, child);
  }
  return { get broken() { return broken; }, close() { closed = true; for (const child of children.values()) child.kill('SIGTERM'); children.clear(); } };
}

function wakeEngine(home) {
  try {
    const fd = fs.openSync(path.join(stateDir(home), 'engine.wake'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, `${Date.now()}\n`); } finally { fs.closeSync(fd); }
  } catch { /* The command can complete while the coordinator is starting. */ }
}

// Done when the lock goes, or when no live coordinator holds it any more (one killed without its cleanup).
export async function waitForStop(home, { timeoutMs = 20000, fsImpl = fs, timers = globalThis, check = isEngine } = {}) {
  const dir = stateDir(home), lock = path.join(dir, 'engine.lock');
  if (!fsImpl.existsSync(lock)) return;
  await new Promise((resolve, reject) => {
    let settled = false, watcher, timer;
    const finish = (error) => {
      if (settled) return; settled = true;
      timers.clearTimeout(timer); watcher.close(); error ? reject(error) : resolve();
    };
    const gone = () => { if (!fsImpl.existsSync(lock) || !engineRunning(home, check)) finish(); };
    watcher = fsImpl.watch(dir, gone);
    watcher.on?.('error', () => {});
    timer = timers.setTimeout(() => finish(Error(`Coordinator did not stop within ${Math.ceil(timeoutMs / 1000)} seconds`)), timeoutMs);
    gone();
  });
}

export function creditSleep(doc, slept) {
  for (const task of doc.tasks) {
    const attempt = task.attempts?.at(-1);
    if (attempt?.state === 'running' && !attempt.timedOut) attempt.pausedMs = (attempt.pausedMs ?? 0) + slept;
  }
}

// `hc kill` hangs up first: without SIGHUP the coordinator would die holding its lock.
const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
// A coordinator with nothing to do for this long exits; a command or the Inbox starts it when a run needs it again.
export const IDLE_MS = 10 * 60000;
// A watch that ended (its terminal restarted, hc quit) is opened again, at most this often.
const REWATCH_MS = 30000;

export async function serve(home, { runtimeFactory = createRuntime, fsImpl = fs, timers = globalThis, pid = process.pid, processRef = process,
  spawnImpl = spawn, eventWatch = watchAgents, intervalMs = 3000, debounceMs = 150, check = isEngine, idleMs = IDLE_MS, clock = Date.now } = {}) {
  const lock = acquireOwned(privateDir(stateDir(home)), 'engine', { pid, errors: ENGINE_ERRORS, owns: (owner) => check(owner, home) });
  let runtime, stopped = false, released = false, running = false, queued = false, timer, debounce, watcher, wakeWatcher, agentWatcher, settle;
  let watchedAddresses = '', watchedAt = 0;
  const reports = path.join(stateDir(home), 'reports');
  const done = new Promise((resolve) => { settle = resolve; });
  const schedule = () => {
    if (stopped) return;
    timers.clearTimeout(debounce);
    debounce = timers.setTimeout(() => { void tick(); }, debounceMs);
  };
  const refreshAgentWatch = (doc = runtime.read()) => {
    const addresses = doc.tasks.filter((task) => needsEngine([task]))
      .flatMap((task) => [task.executor?.address, task.reviewer?.address].filter(Boolean));
    const key = [...new Set(addresses)].sort().join('\0');
    if (key === watchedAddresses && !(agentWatcher?.broken && clock() - watchedAt >= REWATCH_MS)) return;
    agentWatcher?.close(); watchedAddresses = key; watchedAt = clock();
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
    for (const signal of SIGNALS) processRef.removeListener?.(signal, stop);
    releaseOwned(lock); settle();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true; timers.clearInterval(timer); timers.clearTimeout(debounce);
    // Checks outlive the tick; without this they would keep the checkout busy after the lock is released.
    runtime?.stopChecks?.();
    finish();
  };
  const onWake = (_event, filename) => {
    if (filename?.toString() !== 'engine.wake') return;
    try { if (!runtime.read().engine.enabled) { stop(); return; } } catch { /* Repairable state errors should not kill the daemon. */ }
    schedule();
  };
  try {
    runtime = runtimeFactory({ home, wake: schedule });
    runtime.recover();
    if (runtime.read().engine.error) transaction(home, (doc) => { delete doc.engine.error; });
    watcher = fsImpl.watch(reports, schedule); watcher.on?.('error', () => {});
    wakeWatcher = fsImpl.watch(stateDir(home), onWake); wakeWatcher.on?.('error', () => {});
    for (const signal of SIGNALS) processRef.on?.(signal, stop);
    refreshAgentWatch();
    let beat = clock(), idleSince = clock();
    timer = timers.setInterval(() => {
      // A machine that slept (the gap between beats) ran no agent: that time is added to running attempts' limits.
      const slept = clock() - beat - intervalMs;
      beat = clock();
      if (slept > intervalMs * 2) {
        try { transaction(home, (doc) => creditSleep(doc, slept)); } catch { /* the deadline then runs from wall time */ }
      }
      let doc;
      try { doc = runtime.read(); } catch { return; }
      if (!doc.engine.enabled) { stop(); return; }
      const now = clock();
      if (needsEngine(doc.tasks)) idleSince = now;
      else if (now - idleSince >= idleMs) { stop(); return; }
      if (agentWatcher?.broken) refreshAgentWatch(doc);
      // Periodic work is reserved for attempt deadlines; normal progress comes from terminal and report events.
      if (doc.tasks.some((task) => ['running', 'blocked'].includes(task.state) && task.attempts.at(-1)?.state === 'running' && !task.attempts.at(-1).timedOut &&
        now >= attemptDue(task.attempts.at(-1), task.maxMinutes))) void tick();
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
    // The app asks now and then while runs are open: a coordinator that died with work left is started again.
    if (parsed.payload.action === 'wake') {
      const doc = runtime.read();
      const stalled = doc.engine?.enabled && needsEngine(doc.tasks) && !(deps.engineRunning ?? engineRunning)(parsed.home);
      if (stalled) await (deps.ensureEngine ?? ensureEngine)(parsed.home, deps.engineOptions);
      return { code: 0, output: { ok: true, started: Boolean(stalled) } };
    }
    const result = await runtime.command(parsed.payload);
    const doc = result?.doc ?? runtime.read();
    const action = parsed.payload.action;
    const startsWork = ['start', 'resume', 'retry-review'].includes(action) || (action === 'create' && parsed.payload.start === true) || (action === 'start-plan' && result?.result?.existing !== true) || (action === 'decide' && parsed.payload.outcome === 'changes') ||
      (action === 'batch' && parsed.payload.outcome === 'changes' && parsed.payload.preview === false);
    const acceptedIds = parsed.payload.outcome === 'accept' ? action === 'decide' ? [parsed.payload.taskId]
      : action === 'batch' && parsed.payload.preview === false ? parsed.payload.ids ?? [] : [] : [];
    const continuesWork = (doc.tasks ?? []).some((task) => task.state === 'ready' && !task.paused &&
      task.dependsOn?.some((id) => acceptedIds.includes(id)) && task.dependsOn.every((id) => doc.tasks.some((parent) => parent.id === id && parent.state === 'accepted')));
    const keepsEngineBusy = ['message', 'skill'].includes(action);
    const passive = ['read', 'archive', 'create', 'refresh', 'suggest-preferences', 'prepare-worktree', 'attempt-diff', 'task-diff', 'worktree-status', 'worktree-commit', 'worktree-pr', 'worktree-push', 'worktree-remove'].includes(action);
    const response = result ?? { doc };
    if (doc?.engine?.enabled && (startsWork || keepsEngineBusy || continuesWork)) {
      try { await (deps.ensureEngine ?? ensureEngine)(parsed.home, deps.engineOptions); }
      catch (error) { return { code: 1, output: { ...response, doc, error: String(error?.message ?? error), saved: true } }; }
    } else if (!passive && doc?.engine?.enabled) {
      // One that rested while idle is started again when the command leaves it work.
      if (needsEngine(doc.tasks) && !(deps.engineRunning ?? engineRunning)(parsed.home)) {
        try { await (deps.ensureEngine ?? ensureEngine)(parsed.home, deps.engineOptions); }
        catch (error) { return { code: 1, output: { ...response, doc, error: String(error?.message ?? error), saved: true } }; }
      } else wakeEngine(parsed.home);
    }
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
