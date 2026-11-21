// The Spaces list paints its folders with this palette, so a folder mark here matches the sidebar.
export const FOLDER_COLORS = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
export const folderColor = (color, fallback) => (color ? FOLDER_COLORS[color] ?? color : fallback);

// Spaces' machine colors (relevo-spaces/folders.js machineLook), so a remote agent wears its machine's color there too.
const MACHINE_COLORS = ["ansi5", "ansi6", "ansi3", "ansi2", "ansi4"];
export function machineLook(name, list) {
  const others = list.filter((m) => m.name), at = others.findIndex((m) => m.name === name);
  const i = at >= 0 ? at : [...String(name)].reduce((n, c) => n + c.charCodeAt(0), 0);
  return { color: folderColor(MACHINE_COLORS[i % MACHINE_COLORS.length]), away: others[at]?.layout === "unavailable" };
}
