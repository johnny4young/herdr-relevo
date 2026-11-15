import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { shellArgv } from '../lib/session-env.js';
export function run(argv, { cwd, timeout = 60000, limit = 65536, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', stopped = false;
    const timer = setTimeout(() => { stopped = true; child.kill('SIGTERM'); }, timeout);
    const kill = setTimeout(() => { if (stopped) child.kill('SIGKILL'); }, timeout + 1000);
    const collect = (stream, text) => {
      if (stream === 'out') stdout += text; else stderr += text;
      if (stdout.length + stderr.length > limit) { stopped = true; child.kill('SIGTERM'); stdout = stdout.slice(0, limit); stderr = stderr.slice(0, limit); }
    };
    child.stdout.on('data', (chunk) => collect('out', chunk.toString()));
    child.stderr.on('data', (chunk) => collect('err', chunk.toString()));
    child.on('error', (error) => { clearTimeout(timer); clearTimeout(kill); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); clearTimeout(kill); resolve({ code: stopped ? 124 : code ?? 1, stdout, stderr, truncated: stopped }); });
  });
}

// Checks find their commands as the person's terminal does: the coordinator itself runs under the Herdr core's
// PATH, which lacks what a login shell adds (fnm, nvm, Homebrew). Without zsh, the node running this still counts.
export const readLoginEnv = (runImpl = run) => runImpl(shellArgv('printf "\\n__relevo_path__%s" "$PATH"'), { timeout: 15000 })
  .then((r) => (r.code === 0 ? r.stdout.split('__relevo_path__').at(-1).trim() : ''), () => '')
  .then((login) => ({ ...process.env, PATH: [login || process.env.PATH, path.dirname(process.execPath)].filter(Boolean).join(path.delimiter) }));
let found;
export const loginEnv = () => (found ??= readLoginEnv());

// Checks keep the tail of their output (where failures print) and run in their own
// process group so a timeout or cancel also stops the processes they started.
export function runCheck(argv, { cwd, timeout = 60000, maxOutput = 16384, signal, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '', stderr = '', stopped = null, hard;
    const group = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
    const stop = (reason) => {
      if (stopped) return;
      stopped = reason; group('SIGTERM');
      hard = setTimeout(() => group('SIGKILL'), 1000);
    };
    const timer = setTimeout(() => stop('timeout'), timeout);
    const onAbort = () => stop('cancelled');
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    const tail = (text, chunk) => (text + chunk).slice(-maxOutput);
    child.stdout.on('data', (chunk) => { stdout = tail(stdout, chunk.toString()); });
    child.stderr.on('data', (chunk) => { stderr = tail(stderr, chunk.toString()); });
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    child.on('error', (error) => { done(); clearTimeout(hard); reject(error); });
    child.on('close', (code) => {
      done();
      if (stopped) group('SIGKILL');
      clearTimeout(hard);
      resolve({ code: stopped ?? code ?? 1, stdout, stderr });
    });
  });
}
