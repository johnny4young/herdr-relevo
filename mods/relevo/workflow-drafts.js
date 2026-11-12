import { shared, setShared, agents as liveAgents, panes as livePanes } from 'herdr';

const VERSION = 1;
const KEY_PREFIX = 'relevo.workflow.draft.v1.';
const MAX_RECORD_CHARS = 64 * 1024;
const FIELD_KEYS = ['title', 'root', 'criteria', 'checks', 'maxRounds', 'maxMinutes', 'checkPreset', 'executor', 'reviewer', 'dependsOn'];
const PRESETS = new Set(['none', 'npm-test', 'custom']);

export function workflowDraftKey(goalId) {
  if (typeof goalId !== 'string' || !goalId || goalId.length > 100) throw new TypeError('A valid goal id is required');
  return `${KEY_PREFIX}${encodeURIComponent(goalId)}`;
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeWorkflowDraft(goalId, input) {
  workflowDraftKey(goalId);
  if (!plainObject(input) || Object.keys(input).some((key) => !FIELD_KEYS.includes(key))) return null;
  const { title, root, criteria, checks, maxRounds, maxMinutes, checkPreset, executor, reviewer, dependsOn } = input;
  if (typeof title !== 'string' || title.length > 240 || typeof root !== 'string' || root.length > 4096 ||
      typeof criteria !== 'string' || criteria.length > 4000 || typeof checks !== 'string' || checks.length > MAX_RECORD_CHARS ||
      typeof maxRounds !== 'string' || maxRounds.length > 8 || typeof maxMinutes !== 'string' || maxMinutes.length > 8 ||
      !PRESETS.has(checkPreset) || typeof executor !== 'string' || executor.length > 256 ||
      typeof reviewer !== 'string' || reviewer.length > 256 || !Array.isArray(dependsOn) || dependsOn.length > 200 ||
      dependsOn.some((id) => typeof id !== 'string' || !id || id.length > 100) || new Set(dependsOn).size !== dependsOn.length) return null;
  return { title, root, criteria, checks, maxRounds, maxMinutes, checkPreset, executor, reviewer, dependsOn: [...dependsOn] };
}

export function restoreWorkflowDraftAgents(draft, { agents = liveAgents(), panes = livePanes() } = {}) {
  const root = draft?.root;
  const resolve = (address, role) => {
    if (!address) return { address: '', warning: null };
    const agent = agents.find((item) => item.address === address);
    const pane = agent && panes.find((item) => item.pane === agent.pane);
    const cwd = agent?.cwd ?? pane?.cwd;
    if (!agent || !root || cwd !== root) {
      const label = role === 'executor' ? 'Implementer' : 'Reviewer';
      return { address: '', warning: `${label} ${address} was not restored; choose a live session in the saved repository.` };
    }
    return { address, warning: null };
  };
  const executor = resolve(draft?.executor, 'executor'), reviewer = resolve(draft?.reviewer, 'reviewer');
  return {
    executor: executor.address,
    reviewer: reviewer.address === executor.address ? '' : reviewer.address,
    warnings: [executor.warning, reviewer.warning,
      executor.address && executor.address === reviewer.address ? 'Choose different sessions for implementer and reviewer.' : null].filter(Boolean),
  };
}

export function createWorkflowDrafts({ read = shared, write = setShared } = {}) {
  const load = (goalId) => {
    const key = workflowDraftKey(goalId), raw = read(key);
    if (raw == null || raw === '') return null;
    try {
      if (typeof raw === 'string' && raw.length > MAX_RECORD_CHARS) return null;
      const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!plainObject(record) || record.version !== VERSION || record.goalId !== goalId ||
          Object.keys(record).some((key) => !['version', 'goalId', 'updatedAt', 'draft'].includes(key)) ||
          typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) return null;
      const draft = normalizeWorkflowDraft(goalId, record.draft);
      if (!draft) return null;
      const normalized = JSON.stringify({ version: VERSION, goalId, updatedAt: record.updatedAt, draft });
      return normalized.length <= MAX_RECORD_CHARS ? draft : null;
    } catch { return null; }
  };
  const save = (goalId, input) => {
    const draft = normalizeWorkflowDraft(goalId, input);
    if (!draft) return { ok: false, reason: 'Draft fields are invalid or exceed their supported limits.' };
    const record = { version: VERSION, goalId, updatedAt: new Date().toISOString(), draft };
    const serialized = JSON.stringify(record);
    if (serialized.length > MAX_RECORD_CHARS) return { ok: false, reason: 'Draft is too large to save.' };
    write(workflowDraftKey(goalId), serialized);
    return { ok: true, draft };
  };
  const clear = (goalId) => write(workflowDraftKey(goalId), null);
  return { load, save, clear, snapshot: load };
}
