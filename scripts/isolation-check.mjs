// Run only inside the generated sandbox. A failed check stops setup acceptance.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
export async function checkIsolation(root, extraction = false) {
  const probe = `/private/tmp/herdr-denied-${process.pid}`;
  try { fs.writeFileSync(probe, 'sandbox test', { flag: 'wx' }); throw Error('Outside write unexpectedly permitted'); }
  catch (e) { if (!['EPERM', 'EACCES'].includes(e.code)) throw e; }
  const denied = net.createServer();
  await new Promise((resolve, reject) => {
    denied.once('error', (e) => ['EPERM', 'EACCES'].includes(e.code) ? resolve() : reject(e));
    denied.listen(0, '127.0.0.1', () => { denied.close(); reject(Error('TCP unexpectedly permitted')); });
  });
  if (extraction) {
    const r = spawnSync('/usr/bin/true');
    if (r.status === 0 || (r.error && !['EPERM', 'EACCES'].includes(r.error.code))) throw Error('Extractor fork/exec check failed');
  } else {
    const socket = path.join(root, 'run', `preflight-${process.pid}.sock`), server = net.createServer((s) => s.end());
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
      await new Promise((resolve, reject) => { const client = net.connect(socket); client.once('error', reject); client.once('end', resolve); client.resume(); });
    } finally { await new Promise((resolve) => server.close(resolve)); if (fs.existsSync(socket)) fs.unlinkSync(socket); }
    const pty = spawnSync('/usr/bin/script', ['-q', '/dev/null', '/usr/bin/true'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
    if (pty.status !== 0) throw Error(`Native PTY check failed: ${pty.stderr}`);
  }
  console.log('Isolation passed: TCP and outside writes denied; ' + (extraction ? 'fork/exec denied.' : 'scratch Unix IPC and native PTY allowed.'));
}
if (process.argv[2]) await checkIsolation(process.argv[2], process.argv[3] === 'extract');
