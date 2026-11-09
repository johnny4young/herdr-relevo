import { spawn } from 'node:child_process';
import { setTimeout, clearTimeout } from 'node:timers';
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
