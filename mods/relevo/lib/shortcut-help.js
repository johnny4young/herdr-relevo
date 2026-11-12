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

export const INBOX_SHORTCUT_ACTIONS = [
  { id: "inbox.up", label: "Select previous item", section: "Inbox navigation", fixedShortcut: "up" },
  { id: "inbox.down", label: "Select next item", section: "Inbox navigation", fixedShortcut: "down" },
  { id: "inbox.first", label: "Select first item", section: "Inbox navigation", fixedShortcut: "home" },
  { id: "inbox.last", label: "Select last item", section: "Inbox navigation", fixedShortcut: "end" },
  { id: "inbox.open", label: "Open selected item", section: "Inbox navigation", fixedShortcut: "enter" },
  { id: "inbox.return", label: "Return focus", section: "Inbox navigation", fixedShortcut: "escape" },
  { id: "inbox.answer", label: "Choose a numbered answer", section: "Inbox navigation", fixedShortcut: "1" },
  { id: "relevo.panel-reviews", label: "Show Reviews", section: "Relevo commands" },
  { id: "relevo.panel-runs", label: "Show Runs", section: "Relevo commands" },
  { id: "relevo.next-waiting", label: "Focus next waiting agent", section: "Relevo commands" },
  { id: "relevo.focus-next", label: "Cycle Inbox focus", section: "Relevo commands" },
  { id: "relevo.review", label: "Open review", section: "Relevo commands" },
  { id: "relevo.quick-reply", label: "Open quick replies", section: "Relevo commands" },
  { id: "relevo.find-file", label: "Find file", section: "Relevo commands" },
  { id: "relevo.worktree-new", label: "Create worktree", section: "Relevo commands" },
];
