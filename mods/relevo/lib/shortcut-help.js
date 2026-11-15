import { formatShortcut } from "./keys.js";

const MODIFIERS = {
  cmd: ["cmd", "command", "meta"],
  ctrl: ["ctrl", "control"],
  alt: ["alt", "option", "opt"],
  shift: ["shift"],
};

function parseStep(step) {
  const parts = step.toLowerCase().split("-");
  const modifiers = [];
  while (parts.length > 1 && Object.hasOwn(MODIFIERS, parts[0])) modifiers.push(parts.shift());
  return { modifiers, key: parts.join("-") };
}

function modifierVariants(steps) {
  const names = [...new Set(steps.flatMap((step) => step.modifiers))];
  let variants = [Object.create(null)];
  for (const name of names) {
    variants = variants.flatMap((variant) => MODIFIERS[name].map((alias) => ({ ...variant, [name]: alias })));
  }
  return variants;
}

// Each chord step stays independent: aliases expand each modifier spelling, never
// cross-combining keys into a shortcut the user would not press.
export function shortcutSearchText(combo) {
  const combos = Array.isArray(combo) ? combo : combo ? [combo] : [];
  const texts = [];
  for (const sequence of combos) {
    const raw = String(sequence).trim();
    if (!raw) continue;
    const steps = raw.split(/\s+/).map(parseStep);
    texts.push(formatShortcut(raw).toLowerCase());
    for (const variant of modifierVariants(steps)) {
      texts.push(steps.map(({ modifiers, key }) => [
        ...modifiers.map((name) => variant[name]), key,
      ].join("+")).join(" "));
    }
    // Bare key names remain searchable too (for example, "enter" or "escape").
    texts.push(steps.map(({ key }) => key).join(" "));
  }
  return [...new Set(texts)].join(" ").toLowerCase();
}

export function buildShortcutHelpRows(actions, bindings = {}) {
  const seen = new Set();
  return actions.flatMap((action) => {
    if (!action?.id || !action?.label || seen.has(action.id)) return [];
    seen.add(action.id);
    const combo = action.fixedShortcut ?? bindings[action.id] ?? null;
    const shortcut = formatShortcut(combo);
    return [{
      id: action.id,
      label: action.label,
      section: action.section ?? "Relevo",
      combo,
      shortcut,
      assigned: Boolean(shortcut),
      searchText: `${action.id} ${action.label} ${action.section ?? "Relevo"} ${shortcutSearchText(combo)}`.toLowerCase(),
    }];
  });
}

export function filterShortcutHelpRows(rows, query) {
  const terms = String(query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return rows;
  return rows.filter((row) => terms.every((term) => row.searchText.includes(term)));
}

// The key bar at a list's foot: the actions tagged with `bar[view]`, in list order; neighbours with one label share it.
export function barKeys(actions, view) {
  const groups = [];
  for (const action of actions) {
    const label = action.bar?.[view], last = groups.at(-1);
    if (!label) continue;
    if (last?.[1] === label) last[0].push(action.fixedShortcut);
    else groups.push([[action.fixedShortcut], label]);
  }
  return groups;
}

const MOVE = { now: "move", maintenance: "move", runs: "move" };

export const INBOX_SHORTCUT_ACTIONS = [
  { id: "inbox.up", label: "Select previous item", section: "Inbox navigation", fixedShortcut: "up" },
  { id: "inbox.down", label: "Select next item", section: "Inbox navigation", fixedShortcut: "down" },
  { id: "inbox.j", label: "Select next item", section: "Inbox navigation", fixedShortcut: "j", bar: MOVE },
  { id: "inbox.k", label: "Select previous item", section: "Inbox navigation", fixedShortcut: "k", bar: MOVE },
  { id: "inbox.top", label: "Go to the top (g g)", section: "Inbox navigation", fixedShortcut: "g" },
  { id: "inbox.bottom", label: "Go to the bottom", section: "Inbox navigation", fixedShortcut: "shift-g" },
  { id: "inbox.review", label: "Review the selected PR or work", section: "Selected row", fixedShortcut: "r" },
  { id: "inbox.open-github", label: "Open it (PR on GitHub, agent, Claude Desktop)", section: "Selected row", fixedShortcut: "o" },
  { id: "inbox.addressed", label: "Mark it addressed", section: "Selected row", fixedShortcut: "a" },
  { id: "inbox.undo", label: "Undo the last addressed", section: "Selected row", fixedShortcut: "u" },
  { id: "inbox.land", label: "Land a ready PR (press twice)", section: "Selected row", fixedShortcut: "l" },
  { id: "inbox.filter", label: "Filter the list", section: "Inbox navigation", fixedShortcut: "/" },
  { id: "inbox.first", label: "Select first item", section: "Inbox navigation", fixedShortcut: "home" },
  { id: "inbox.last", label: "Select last item", section: "Inbox navigation", fixedShortcut: "end" },
  { id: "inbox.open", label: "Open selected item", section: "Inbox navigation", fixedShortcut: "enter", bar: { now: "do the action", maintenance: "open", runs: "open the run" } },
  { id: "inbox.return", label: "Return focus", section: "Inbox navigation", fixedShortcut: "escape" },
  { id: "inbox.answer", label: "Choose a numbered answer", section: "Inbox navigation", fixedShortcut: "1" },
  { id: "inbox.mark", label: "Select or unselect the worktree", section: "Maintenance", fixedShortcut: "x", bar: { maintenance: "select" } },
  { id: "inbox.mark-safe", label: "Select every worktree that is safe to remove", section: "Maintenance", fixedShortcut: "shift-x" },
  { id: "inbox.remove-marked", label: "Remove the selected worktrees, or ask to remove this one or close this terminal", section: "Maintenance", fixedShortcut: "d" },
  { id: "inbox.unmark", label: "Cancel the question or the selection", section: "Maintenance", fixedShortcut: "escape" },
  { id: "inbox.tree-save", label: "Save a copy of this worktree's work", section: "Maintenance", fixedShortcut: "s" },
  { id: "inbox.tree-folder", label: "Open this worktree's folder, or go to this terminal", section: "Maintenance", fixedShortcut: "o" },
  { id: "runs.move", label: "Select next or previous run or task", section: "Runs", fixedShortcut: "j" },
  { id: "runs.open", label: "Open the run or task in the panel", section: "Runs", fixedShortcut: "enter" },
  { id: "runs.back", label: "Back to tasks, then to runs", section: "Runs", fixedShortcut: "escape" },
  { id: "runs.new", label: "New run (from Runs or Reviews)", section: "Runs", fixedShortcut: "n", bar: { runs: "new run" } },
  { id: "runs.window", label: "Open the run window", section: "Runs", fixedShortcut: "w" },
  { id: "runs.accept", label: "Accept a result (Enter confirms)", section: "Runs", fixedShortcut: "a" },
  { id: "runs.changes", label: "Ask for changes", section: "Runs", fixedShortcut: "r" },
  { id: "runs.diff", label: "See the diff", section: "Runs", fixedShortcut: "d" },
  { id: "runs.compare", label: "Compare a task's attempts", section: "Runs", fixedShortcut: "c" },
  { id: "runs.select", label: "Select or unselect a result", section: "Runs", fixedShortcut: "x" },
  { id: "runs.select-repository", label: "Select every result of the same repository", section: "Runs", fixedShortcut: "shift-x" },
  { id: "runs.accept-selected", label: "Accept the selected results", section: "Runs", fixedShortcut: "enter" },
  { id: "runs.unselect", label: "Cancel the selection, or leave the comparison", section: "Runs", fixedShortcut: "escape" },
  { id: "inbox.view", label: "Switch between Now and Maintenance", section: "Inbox navigation", fixedShortcut: "tab", bar: { now: "maintenance", maintenance: "now" } },
  { id: "inbox.maintenance", label: "Show Maintenance", section: "Inbox navigation", fixedShortcut: "m" },
  { id: "relevo.panel-reviews", label: "Show Reviews", section: "Relevo commands" },
  { id: "relevo.panel-runs", label: "Show Runs", section: "Relevo commands" },
  { id: "relevo.next-waiting", label: "Focus next waiting agent", section: "Relevo commands" },
  { id: "relevo.focus-next", label: "Cycle Inbox focus", section: "Relevo commands" },
  { id: "relevo.review", label: "Open review", section: "Relevo commands" },
  { id: "relevo.quick-reply", label: "Open quick replies", section: "Relevo commands" },
  { id: "relevo.find-file", label: "Find file", section: "Relevo commands" },
  { id: "relevo.worktree-new", label: "Create worktree", section: "Relevo commands" },
];
