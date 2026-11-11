const GLYPHS = [["ctrl", "⌃"], ["alt", "⌥"], ["shift", "⇧"], ["cmd", "⌘"]];

// keys.json's global section turned around: action -> its first key combo.
export function keyMap(global) {
  const map = {};
  for (const [combo, action] of Object.entries(global)) map[action] ??= combo;
  return map;
}

// Relevo's keys live in its layout's section. A layout binding replaces a global
// binding on the same combo, including removing that combo from its old action.
export function relevoKeys(file) {
  const global = file.global ?? {}, layout = file["layout:relevo"] ?? {};
  const effectiveGlobal = Object.fromEntries(Object.entries(global).filter(([combo]) => !Object.hasOwn(layout, combo)));
  return { ...keyMap(effectiveGlobal), ...keyMap(layout) };
}

// "cmd-alt-shift-w" -> "⌥⇧⌘W", in macOS modifier order.
export function formatShortcut(combo) {
  if (!combo) return "";
  return combo.trim().split(/\s+/).map(formatStep).join(" ");
}

function formatStep(combo) {
  const parts = combo.split("-");
  const modifiers = [];
  while (parts.length > 1 && GLYPHS.some(([name]) => name === parts[0])) modifiers.push(parts.shift());
  const key = parts.join("-");
  return GLYPHS.filter(([m]) => modifiers.includes(m)).map(([, g]) => g).join("") + (key.length === 1 ? key.toUpperCase() : key);
}
