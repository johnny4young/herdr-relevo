// What the sidebar shows, from spaces(), panes(), each place's git and the folders. Pure, so tests feed it records.
import { folderFor } from "./folders.js";

// Where a space is now: its first terminal's live folder, else where it was made.
export function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((t) => t.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}
export const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const localId = (s) => (s.machine ? s.id.slice(s.machine.length + 1) : s.id);

// Groups in screen order (the folders, then spaces in none, then other machines), each space's worktrees under it.
// `order` is every space id in that order, so ⌃1…⌃9 pick what the list shows.
export function buildModel({ spaces: sp, panes: ps, git = {}, folders = null, quiet = new Set() }) {
  const rows = sp.map((w) => ({ w, g: git[where(w, ps)] ?? null, path: place(w, ps) }));
  const mains = new Map();
  for (const r of rows) if (r.g && !r.g.linked && !mains.has(r.g.repo)) mains.set(r.g.repo, r);
  const parentOf = (r) => (r.g?.linked ? mains.get(r.g.repo) ?? null : null);
  const groupOf = new Map();
  const groupFor = (r) => {
    if (r.w.machine) return `machine:${r.w.machine}`;
    const parent = parentOf(r);
    if (parent) return groupFor(parent);
    return folderFor(localId(r.w), r.path, folders)?.id ?? "none";
  };
  for (const r of rows) groupOf.set(r.w.id, groupFor(r));
  const ids = [...(folders?.list ?? []).map((f) => f.id), "none", ...new Set(sp.filter((w) => w.machine).map((w) => `machine:${w.machine}`))];
  const groups = ids.map((id) => {
    const folder = folders?.list.find((f) => f.id === id) ?? null;
    const top = rows.filter((r) => groupOf.get(r.w.id) === id && !parentOf(r));
    // A repo and its worktrees are quiet together, and quiet ones go last so ⌃1…⌃9 count what is shown.
    const units = top.map((r) => {
      const kids = r.g && !r.g.linked && mains.get(r.g.repo) === r ? rows.filter((k) => parentOf(k) === r) : [];
      const still = [r, ...kids].every((x) => quiet.has(x.w.id));
      return [{ ...r, tree: null, kids: kids.length, quiet: still }, ...kids.map((k, n) => ({ ...k, tree: n === kids.length - 1 ? "last" : "mid", kids: 0, quiet: still }))];
    });
    const list = [...units.filter((u) => !u[0].quiet), ...units.filter((u) => u[0].quiet)].flat();
    return { id, folder, label: folder?.name ?? (id.startsWith("machine:") ? id.slice(8) : null), rows: list };
  }).filter((g) => g.folder || g.rows.length);
  const order = groups.flatMap((g) => g.rows.map((r) => r.w.id));
  return { groups, order };
}

// The space.move calls that turn `current` into `target`, each index counting the moves before it.
export function movesTo(current, target) {
  const order = [...current], out = [];
  for (let i = 0; i < target.length; i++) {
    const from = order.indexOf(target[i]);
    if (from === -1 || from === i) continue;
    out.push({ id: target[i], index: i + 1 });
    order.splice(i, 0, order.splice(from, 1)[0]);
  }
  return out;
}

// After the name, only what's unusual: a branch other than main/master that the name doesn't already say.
export function branchNote(g, name) {
  const b = g?.branch;
  if (!b) return g ? "detached" : null;
  return b === "main" || b === "master" || b.toLowerCase() === String(name ?? "").toLowerCase() ? null : b;
}

const RANK = { blocked: 3, done: 2, working: 1 };
// The most urgent state among a space's agents, as the lane glyph reads it.
export function spaceTurn(status) {
  return { blocked: "me", done: "ready", working: "flight" }[status] ?? null;
}
export const mostUrgent = (statuses) => statuses.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);

export const within = (path, root) => Boolean(path && root) && (path === root || path.startsWith(`${root}/`));
const base = (path) => String(path ?? "").replace(/\/+$/, "").split("/").pop();

// Everything alive under the space whose repo (or folder) holds it, the deepest first so a worktree keeps its own.
// What no space holds comes back as `loose`, one entry per project.
export function aliveBySpace(rows, { agents = [], desktop = [], elsewhere = [], alive = null, home = null } = {}) {
  // A space that just sits in the home folder holds nothing by place: everything is under home.
  const roots = rows.map((r) => ({ id: r.w.id, root: r.g?.top ?? (r.path === home ? null : r.path) })).filter((x) => x.root).sort((a, b) => b.root.length - a.root.length);
  const spaceOf = (cwd) => roots.find((x) => within(cwd, x.root))?.id ?? null;
  const by = new Map(rows.map((r) => [r.w.id, { agents: [], sessions: [], terminals: [], servers: [] }]));
  const loose = new Map();
  const put = (cwd, kind, item, project) => {
    const id = spaceOf(cwd);
    if (id) return by.get(id)[kind].push(item);
    const key = project || base(cwd) || "unknown";
    const entry = loose.get(key) ?? { project: key, cwd, agents: [], sessions: [], terminals: [], servers: [] };
    entry[kind].push(item);
    loose.set(key, entry);
  };
  for (const a of agents) by.get(a.space)?.agents.push(a);
  for (const s of desktop) put(s.cwd, "sessions", { ...s, from: "desktop" }, s.project);
  for (const s of elsewhere) put(s.cwd, "sessions", { ...s, from: "elsewhere" }, s.project);
  // A finished terminal is Maintenance's to tidy, not something alive here.
  for (const t of (alive?.terminals ?? []).filter((x) => x.live)) {
    if (by.has(t.spaceId)) by.get(t.spaceId).terminals.push(t);
    else put(t.cwd, "terminals", t);
  }
  for (const s of alive?.outside ?? []) put(s.cwd, "servers", s);
  return { by, loose: [...loose.values()] };
}

// Every port a space's terminals and servers listen on, lowest first.
export const portsIn = (life) => [...new Set([...life.terminals, ...life.servers].flatMap((x) => x.ports ?? []))].sort((a, b) => a - b);

export const DAY_MS = 24 * 3600e3;
// A space is quiet when nothing in it runs, asks, changed or listens, and that has been so for over a day.
// `touched` (id → ms) is when each was last busy; it is updated in place and the ids that changed come back.
export function quietSpaces(rows, by, { touched, now = Date.now(), firstSeen = () => now, prs = {} }) {
  const quiet = new Set(), changed = [];
  for (const r of rows) {
    const life = by.get(r.w.id) ?? { agents: [], sessions: [], terminals: [], servers: [] };
    const busy = r.w.active || Boolean(spaceTurn(r.w.status)) || (r.g?.changed ?? 0) > 0
      || life.sessions.length > 0 || life.servers.length > 0 || life.agents.some((a) => a.status !== "idle")
      || life.terminals.some((x) => x.state === "running" || x.state === "failed" || (x.ports ?? []).length > 0)
      || (prs[(r.g?.name ?? r.w.name ?? "").toLowerCase()]?.me ?? 0) > 0;
    if (busy) {
      if (now - (touched[r.w.id] ?? 0) > 60000) { touched[r.w.id] = now; changed.push(r.w.id); }
      continue;
    }
    if (touched[r.w.id] === undefined) { touched[r.w.id] = firstSeen(r.w.id); changed.push(r.w.id); }
    if (now - touched[r.w.id] > DAY_MS) quiet.add(r.w.id);
  }
  return { quiet, changed };
}
