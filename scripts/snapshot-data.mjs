// Strict metadata allowlist. Never imports commands, credentials, screens or conversations.
import path from 'node:path';
const states = new Set(['idle', 'working', 'done', 'blocked', 'error']);
const apps = new Set(['claude', 'claude-code', 'codex', 'pi', 'gemini', 'copilot', 'aider', 'opencode']);
const sensitive = /(?:\b(?:sk-[a-z0-9_-]{8,}|ghp_[a-z0-9_]{8,}|github_pat_[a-z0-9_]{8,})|\bbearer\s+[^\s]+|\b(?:password|passwd|token|api[_-]?key|secret)\s*[:=]\s*[^\s]+|[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@)/i;
export function text(value, limit = 200) {
  if (typeof value !== 'string') return '';
  if (sensitive.test(value)) return 'Contenido sensible omitido';
  return [...value.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '')].slice(0, limit).join('');
}
const basename = (value) => typeof value === 'string' ? text(path.basename(value.replace(/\/+$/, ''))) : '';
export function extract(docs, records) {
  const byAddress = new Map(Object.values(records).filter((r) => r && typeof r.address === 'string').map((r) => [r.address, r]));
  function terminal(id) {
    const r = byAddress.get(id) ?? {}, status = r.reported ? r.status ?? {} : {};
    return { sourceId: text(id), reported: r.reported === true, title: text(r.title), repoBasename: basename(r.last_cwd || r.cwd),
      status: states.has(status.state) ? status.state : null, statusAt: typeof r.status_ms === 'number' && Number.isFinite(r.status_ms) ? r.status_ms : null,
      agentApp: apps.has(status.app) ? status.app : null, goal: null, responsible: null, criteria: null };
  }
  function tree(node, leaves, depth = 0) {
    if (!node || typeof node !== 'object') return null;
    if (depth > 100 || leaves.length > 100) throw Error('Excessive terminal tree');
    const id = node.content?.terminal;
    if (typeof id === 'string') { leaves.push(terminal(id)); return { type: 'terminal', sourceId: text(id) }; }
    if (['row', 'column'].includes(node.type)) {
      const children = (node.children ?? []).map((c) => tree(c, leaves, depth + 1)).filter(Boolean);
      return children.length ? { type: node.type, children } : null;
    }
    return null;
  }
  const input = docs['herdr-app']?.value?.spaces ?? [];
  if (input.length > 100) throw Error('Excessive spaces');
  const spaces = input.map((s) => {
    if ((s.tabs ?? []).length > 100) throw Error('Excessive tabs');
    const tabs = (s.tabs ?? []).map((t) => {
      const leaves = [], root = tree(t.root, leaves), first = leaves[0] ?? {}, name = text(t.name).trim();
      return { sourceId: text(t.id), title: name || first.title || first.repoBasename || 'Sin nombre',
        titleSource: name ? 'name' : first.title ? 'terminal-title' : first.repoBasename ? 'terminal-folder' : 'unknown', terminals: leaves, root };
    });
    const first = tabs.flatMap((t) => t.terminals)[0] ?? {}, folder = basename(s.folder), name = text(s.name).trim();
    return { sourceId: text(s.id), title: name || first.repoBasename || folder || 'Sin nombre',
      titleSource: name ? 'name' : first.repoBasename ? 'terminal-folder' : folder ? 'folder' : 'unknown', repoBasename: first.repoBasename || folder, tabs };
  });
  return { schemaVersion: 1, mode: 'metadata-snapshot', warning: 'Local metadata snapshot, not live activity. No messages, terminal screens, credentials or agent commands imported. Goals, responsible people and acceptance criteria are unknown.', spaces };
}
