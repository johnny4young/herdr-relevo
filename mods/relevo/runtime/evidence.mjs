import { createHash } from 'node:crypto';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createReadStream as fileStream } from 'node:fs';
import { runCheck } from './process.mjs';

const execFile = promisify(nodeExecFile);
const hash = (data) => createHash('sha256').update(data).digest('hex');
const inside = (base, path) => { const rel = relative(base, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep)); };
const regular = async (path) => { const s = await lstat(path); if (!s.isFile() || s.isSymbolicLink()) throw new Error(`Expected regular file: ${path}`); return s; };

export async function fingerprint(root) {
  root = await realpath(root);
  const git = (...args) => execFile('git', args, { cwd: root, encoding: 'buffer', timeout: 10000, maxBuffer: 64 * 1024 * 1024 });
  const { stdout: top } = await git('rev-parse', '--show-toplevel');
  if (resolve(top.toString().trim()) !== root) throw new Error('Root must be the git checkout root');
  const { stdout: head } = await git('rev-parse', '--verify', 'HEAD');
  const digest = createHash('sha256').update(head);
  const { stdout: diff } = await git('diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--'); digest.update(diff);
  const { stdout: names } = await git('ls-files', '--others', '--exclude-standard', '-z');
  let total = 0;
  for (const name of names.toString().split('\0').filter(Boolean).sort()) {
    const path = resolve(root, name);
    if (!inside(root, path)) throw new Error('Untracked path escapes repository');
    const s = await regular(path), real = await realpath(path);
    if (!inside(root, real)) throw new Error('Untracked file escapes repository');
    total += s.size;
    if (total > 32 * 1024 * 1024) throw new Error('Untracked files exceed 32 MiB');
    const bytes = await readFile(path); total += bytes.length - s.size;
    if (total > 32 * 1024 * 1024) throw new Error('Untracked files exceed 32 MiB');
    digest.update(Buffer.from(name)); digest.update(Buffer.from([0])); digest.update(bytes);
  }
  return digest.digest('hex');
}

export async function runChecks(root, checks, { run = runCheck, timeoutMs = 60000, maxOutput = 16384, signal, clock = Date.now } = {}) {
  if (!Array.isArray(checks) || checks.some((x) => !Array.isArray(x) || !x.length || x.some((a) => typeof a !== 'string'))) throw new TypeError('checks must be arrays of argv strings');
  const results = [];
  const deadline = clock() + timeoutMs;
  for (const argv of checks) {
    if (signal?.aborted || clock() >= deadline) { results.push({ argv, code: signal?.aborted ? 'cancelled' : 'timeout', stdout: '', stderr: 'Check sequence stopped before execution', at: new Date().toISOString() }); break; }
    const at = new Date().toISOString();
    try {
      const remaining = Math.max(1, deadline - clock());
      const result = await run(argv, { cwd: root, timeout: remaining, maxOutput, signal });
      results.push({ argv, code: result.code ?? 0, stdout: String(result.stdout ?? '').slice(-maxOutput), stderr: String(result.stderr ?? '').slice(-maxOutput), at });
      if (['timeout', 'cancelled', 124].includes(result.code) || signal?.aborted) break;
    } catch (error) {
      results.push({ argv, code: error.code === 'ETIMEDOUT' || error.killed ? 'timeout' : (error.code ?? 1), stdout: String(error.stdout ?? '').slice(-maxOutput), stderr: String(error.stderr ?? error.message ?? '').slice(-maxOutput), at });
      if (error.code === 'ETIMEDOUT' || error.killed || signal?.aborted) break;
    }
  }
  return results;
}

const types = {
  screenshot: { ext: ['.png', '.jpg', '.jpeg'], magic: (b) => b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) },
  video: { ext: ['.mp4', '.webm'], magic: (b) => (b.toString('ascii', 4, 8) === 'ftyp') || b.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])) },
  report: { ext: ['.txt', '.md', '.json'], magic: (b) => !b.includes(0) },
};

async function diskUsage(path) {
  let n = 0;
  for (const ent of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const p = join(path, ent.name); const s = await lstat(p);
    if (s.isSymbolicLink()) throw new Error('Artifact directory contains a symlink');
    if (s.isDirectory()) n += await diskUsage(p); else if (s.isFile()) n += s.size;
  }
  return n;
}

async function noSymlinkPath(path) {
  const full = resolve(path), parts = full.split(sep).filter(Boolean);
  let cursor = full.startsWith(sep) ? sep : '';
  for (const part of parts) {
    cursor = cursor ? join(cursor, part) : part;
    try { if (cursor !== '/var' && (await lstat(cursor)).isSymbolicLink()) throw new Error('Artifact path traverses a symlink'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function attachArtifact({ stateDir, taskId, source, kind, revision, label, maxBytes = 20 * 1024 * 1024, maxTotalBytes = 100 * 1024 * 1024 }) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(String(taskId))) throw new Error('Invalid task id');
  if (!types[kind]) throw new Error('Unsupported artifact kind');
  const sourcePath = resolve(source); await noSymlinkPath(sourcePath); const sourceStat = await regular(sourcePath);
  const realSource = await realpath(sourcePath), realState = await realpath(stateDir);
  if (inside(realState, realSource) || /(^|[\\/])\.git([\\/]|$)/.test(realSource) || /(^|[\\/])(?:credentials?|secrets?|id_rsa|\.env)(?:\.|$)/i.test(basename(realSource))) throw new Error('Source is not allowed');
  if (!types[kind].ext.includes(extname(sourcePath).toLowerCase())) throw new Error('File extension does not match artifact kind');
  if (sourceStat.size > maxBytes) throw new Error('Artifact exceeds size limit');
  const bytes = await readFile(sourcePath); if (bytes.length > maxBytes) throw new Error('Artifact exceeds size limit');
  if (!types[kind].magic(bytes)) throw new Error('Artifact content does not match kind');
  const artifactsDir = join(realState, 'artifacts'), base = join(artifactsDir, taskId);
  await noSymlinkPath(artifactsDir); await noSymlinkPath(base);
  if (await diskUsage(artifactsDir) + bytes.length > maxTotalBytes) throw new Error('Artifact quota exceeded');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const id = randomUUID(), path = join(base, `${id}${extname(sourcePath).toLowerCase()}`);
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); return { id, path, kind, revision, label: String(label ?? '').slice(0, 200), bytes: bytes.length, sha256: hash(bytes), at: new Date().toISOString() };
}

export async function verifyArtifact(artifact) {
  try {
    await noSymlinkPath(artifact.path);
    const s = await regular(artifact.path);
    if (s.size > (artifact.maxBytes ?? 20 * 1024 * 1024) || (artifact.bytes !== undefined && s.size !== artifact.bytes)) return false;
    const digest = createHash('sha256');
    for await (const chunk of fileStream(artifact.path)) digest.update(chunk);
    return digest.digest('hex') === artifact.sha256;
  } catch { return false; }
}

export async function removeArtifact(stateDir, artifact) {
  const base = resolve(await realpath(stateDir), 'artifacts');
  await noSymlinkPath(base);
  const path = resolve(artifact.path);
  if (!inside(base, path) || path === base) throw new Error('Artifact path is outside artifact storage');
  let cursor = base;
  for (const part of relative(base, path).split(sep)) { cursor = join(cursor, part); const s = await lstat(cursor); if (s.isSymbolicLink()) throw new Error('Artifact path traverses a symlink'); }
  await regular(path); await rm(path);
}
