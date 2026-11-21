// Another machine's terminals and agents have addresses like `vps/t7`; this computer's have none.
export const machineOf = (address) => (String(address ?? "").includes("/") ? String(address).split("/")[0] : null);

// Spaces' machine colors (relevo-spaces/folders.js machineLook), so a remote row wears its machine's color here too.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a" };
const MACHINE_COLORS = ["ansi5", "ansi6", "ansi3", "ansi2", "ansi4"];
export function machineLook(name, list = []) {
  const others = list.filter((m) => m.name), at = others.findIndex((m) => m.name === name);
  const i = at >= 0 ? at : [...String(name)].reduce((n, c) => n + c.charCodeAt(0), 0);
  return { name, color: MARK[MACHINE_COLORS[i % MACHINE_COLORS.length]], away: others[at]?.layout === "unavailable" };
}
