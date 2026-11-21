// Relevo's parts a person can turn off. A hidden block never starts its mod at the next launch.
// account-status is not here: it runs Relevo's watchers and key commands.
export const PANELS = [
  { key: "spaces", label: "Spaces", nodes: ["spaces"] },
  { key: "agents", label: "Agents", nodes: ["agents"] },
  { key: "tabs", label: "Tabs", nodes: ["tabs"] },
  { key: "files", label: "Files", nodes: ["files"] },
  { key: "reviews", label: "Reviews and Runs", nodes: ["inbox-button", "inbox"] },
];
export const PANELS_FILE = "relevo-install/panels.json";
export const PANEL_KEYS = PANELS.map((p) => p.key);

export function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

// "spaces,agents" or "all" → the keys that stay on. Unknown names throw, so a typo never hides everything.
export function parsePanels(text) {
  const keys = String(text ?? "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (keys.includes("all")) return [...PANEL_KEYS];
  const unknown = keys.filter((k) => !PANEL_KEYS.includes(k));
  if (unknown.length) throw Error(`unknown panel ${unknown.join(", ")}: use ${PANEL_KEYS.join(", ")} or all`);
  if (!keys.length) throw Error(`name at least one panel: ${PANEL_KEYS.join(", ")} or all`);
  return PANEL_KEYS.filter((k) => keys.includes(k));
}

// The stored choice; anything unreadable means every panel on.
export function readPanels(text) {
  try {
    const on = JSON.parse(text)?.on;
    return Array.isArray(on) ? PANEL_KEYS.filter((k) => on.includes(k)) : [...PANEL_KEYS];
  } catch { return [...PANEL_KEYS]; }
}
export const panelsText = (on) => `${JSON.stringify({ on: PANEL_KEYS.filter((k) => on.includes(k)) }, null, 2)}\n`;

export const panelShown = (tree, panel) => panel.nodes.every((id) => { const n = findNode(tree, id); return Boolean(n) && !n.hidden; });

// The layout file with each panel's blocks hidden or shown as chosen.
export function applyPanels(tree, on) {
  const copy = JSON.parse(JSON.stringify(tree));
  for (const panel of PANELS) for (const id of panel.nodes) {
    const node = findNode(copy, id);
    if (!node) continue;
    if (on.includes(panel.key)) delete node.hidden; else node.hidden = true;
  }
  return copy;
}

// The Herdr commands that bring the open window to the choice. A hidden panel that was showing leaves the panel on Changes.
export function panelCommands(tree, on) {
  const runs = [];
  for (const panel of PANELS) {
    const want = on.includes(panel.key);
    if (panelShown(tree, panel) === want) continue;
    for (const id of panel.nodes) if (findNode(tree, id)) runs.push([want ? "layout.show" : "layout.hide", { id }]);
    if (!want && panel.nodes.includes(findNode(tree, "panel-body")?.active)) runs.push(["layout.select", { stack: "panel-body", child: "changes" }]);
  }
  return runs;
}
