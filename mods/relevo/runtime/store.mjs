import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const emptyState = () => ({ version: 1, revision: 0, tasks: [], events: [], preferences: [], engine: { enabled: false, maxConcurrent: 2 } });
export const uid = () => crypto.randomUUID();
export function stateDir(home) {
  if (!path.isAbsolute(home) || path.resolve(home) === path.parse(home).root) throw Error('An explicit application home is required');
  return path.join(home, 'relevo-workflow');
}
export function privateDir(dir) {
  const absolute = path.resolve(dir);
  for (let current = absolute; current !== path.dirname(current); current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('Workflow paths cannot traverse symlinks');
  }
  fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
  return absolute;
}
export function atomic(file, value) {
  const temp = `${file}.${uid()}.tmp`;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function validateState(doc) {
  if (doc?.version !== 1 || !Number.isSafeInteger(doc.revision) || !Array.isArray(doc.tasks) || doc.tasks.length > 200 ||
      !Array.isArray(doc.events) || !Array.isArray(doc.preferences) || !doc.engine || typeof doc.engine.enabled !== 'boolean' ||
      !Number.isInteger(doc.engine.maxConcurrent) || doc.engine.maxConcurrent < 1 || doc.engine.maxConcurrent > 2 ||
      (doc.plans !== undefined && (!Array.isArray(doc.plans) || doc.plans.length > 200))) throw Error('Invalid workflow state; original file preserved');
  const planIds = new Set();
  for (const plan of doc.plans ?? []) {
    if (!plan?.id || planIds.has(plan.id) || !plan.goalId || !Number.isSafeInteger(plan.goalVersion) ||
        !Array.isArray(plan.taskIds) || !Array.isArray(plan.stepIds) || plan.taskIds.length !== plan.stepIds.length ||
        !['planned', 'started', 'cancelled'].includes(plan.state) || typeof plan.createdAt !== 'string') throw Error('Invalid workflow plan');
    planIds.add(plan.id);
  }
  const ids = new Set();
  for (const task of doc.tasks) {
    if (!task.id || ids.has(task.id) || !Array.isArray(task.attempts) || !Array.isArray(task.decisions) || !Array.isArray(task.messages) || !Array.isArray(task.evidence) ||
        !Array.isArray(task.dependsOn) || !Array.isArray(task.checks) || !Array.isArray(task.checksResult) || !path.isAbsolute(task.root ?? '') ||
        !['planned', 'ready', 'running', 'blocked', 'needs_review', 'needs_you', 'accepted', 'failed', 'cancelled'].includes(task.state)) throw Error('Invalid workflow task');
    ids.add(task.id);
  }
  return doc;
}
export function readState(home) {
  const dir = stateDir(home), file = path.join(dir, 'state.json');
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw Error('Workflow state directory is unsafe');
  if (!fs.existsSync(file)) return emptyState();
  if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 8 * 1024 * 1024) throw Error('Workflow state is unsafe or full');
  return validateState(JSON.parse(fs.readFileSync(file, 'utf8')));
}
export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
export function transaction(home, mutate) {
  const dir = privateDir(stateDir(home)), lock = path.join(dir, 'write.lock');
  const guard = path.join(dir, 'write.acquire');
  try { fs.mkdirSync(guard, { mode: 0o700 }); } catch { throw Error('Workflow is busy; retry shortly'); }
  const token = uid();
  try {
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (fs.lstatSync(lock).isSymbolicLink()) throw Error('Unsafe workflow lock');
      // Serialize reclamation: a second process must never remove a new owner's lock.
      let owner;
      const ownerFile = path.join(lock, 'owner.json');
      try { if (fs.lstatSync(ownerFile).isSymbolicLink()) throw Error(); owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); }
      catch { throw Error('Workflow is busy; retry shortly'); }
      if (alive(owner.pid)) throw Error('Workflow is busy; retry shortly');
      fs.unlinkSync(ownerFile); fs.rmdirSync(lock); fs.mkdirSync(lock, { mode: 0o700 });
    }
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
  } finally { fs.rmdirSync(guard); }
  try {
    const doc = readState(home), result = mutate(doc);
    if (result && typeof result.then === 'function') throw Error('Transactions must not perform asynchronous effects');
    doc.revision++;
    validateState(doc);
    if (JSON.stringify(doc).length > 8 * 1024 * 1024) throw Error('Workflow history is full; archive tasks before continuing');
    atomic(path.join(dir, 'state.json'), doc);
    return { doc, result };
  } finally {
    const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
    if (owner.token === token) { fs.unlinkSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock); }
  }
}
export function event(doc, task, type, detail, actor = 'Coordinator', now = Date.now()) {
  doc.events.push({ id: uid(), taskId: task?.id ?? null, goalId: task?.goalId ?? null, type, actor, detail, at: new Date(now).toISOString() });
  if (doc.events.length > 2000) { doc.archivedEventCount = (doc.archivedEventCount ?? 0) + doc.events.length - 2000; doc.events = doc.events.slice(-2000); }
}
export function taskById(doc, id) {
  const task = doc.tasks.find((task) => task.id === id);
  if (!task) throw Error('Task is no longer available');
  return task;
}
