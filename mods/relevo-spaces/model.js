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
export function buildModel({ spaces: sp, panes: ps, git = {}, folders = null }) {
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
    const list = top.flatMap((r) => {
      const kids = r.g && !r.g.linked && mains.get(r.g.repo) === r ? rows.filter((k) => parentOf(k) === r) : [];
      return [{ ...r, tree: null, kids: kids.length }, ...kids.map((k, n) => ({ ...k, tree: n === kids.length - 1 ? "last" : "mid", kids: 0 }))];
    });
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
