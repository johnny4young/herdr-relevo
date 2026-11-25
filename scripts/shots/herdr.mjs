// The app's API over state a scene sets (same shape as the repo's test fake), with real palettes from the design boards.
const never = new Promise(() => {});
const blank = () => ({
  agents: [], terminals: [], panes: [], spaces: [], layout: { id: "root", children: [] }, focused: null, props: {},
  window: { platform: "macos", titlebar: "none", active: true }, stored: {}, files: {},
  read: null, write: null, exec: () => null, execs: [], runs: [], notices: [], overlays: [], closedOverlays: [], orders: [],
  folderChanges: new Map(), folderWaits: new Map(), reads: { panes: 0, terminals: 0 },
});

export const fake = blank();
export const resetFake = () => Object.assign(fake, blank());
export const calls = (pattern) => fake.execs.filter((line) => pattern.test(line));

const PALETTES = {
  moon: {
    chrome: "#1e2030", background: "#222436", surface: "#1f2133", raised: "#2f334d", hover: "#2a2e47", selected: "#363c5c", border: "#3b4261",
    foreground: "#c8d3f5", muted: "#8f98c4", dim: "#7a88cf", accent: "#82aaff", blocked: "#ff757f",
    ansi2: "#c3e88d", ansi3: "#ffc777", ansi5: "#c099ff", working: "#ffc777", done: "#c3e88d", idle: "#828bb8",
    solid: "#c8d3f5", solid_foreground: "#1e2030",
  },
  graphite: {
    chrome: "#17181b", background: "#1c1d21", surface: "#1a1b1f", raised: "#2a2c32", hover: "#24262b", selected: "#30333b", border: "#3a3d46",
    foreground: "#e3e5ea", muted: "#a1a6b3", dim: "#8a90a0", accent: "#7ab7ff", blocked: "#ff6b6b",
    ansi2: "#8fd67a", ansi3: "#f2c14e", ansi5: "#c49bff", working: "#f2c14e", done: "#8fd67a", idle: "#8a90a0",
    solid: "#e3e5ea", solid_foreground: "#17181b",
  },
  day: {
    chrome: "#e4e6ec", background: "#f3f4f8", surface: "#eceef3", raised: "#dfe2ea", hover: "#e3e6ed", selected: "#d3d8e4", border: "#c3c8d4",
    foreground: "#2e3148", muted: "#585c76", dim: "#666a86", accent: "#1d5fe0", blocked: "#c8102e",
    ansi2: "#28701a", ansi3: "#8f5200", ansi5: "#7a2fd6", working: "#8f5200", done: "#28701a", idle: "#7c7f93",
    solid: "#2e3148", solid_foreground: "#f3f4f8",
  },
};

export const themeName = PALETTES[process.env.THEME] ? process.env.THEME : "moon";
// Tokens the boards don't give, derived from the ones they do.
const derived = (p) => ({
  ...p, ansi1: p.blocked, ansi0: p.chrome, ansi4: p.accent, ansi6: p.accent, ansi7: p.foreground,
  popover: p.raised, input: p.border, canvas: p.chrome, accent_foreground: p.solid_foreground, unknown: p.dim, selection: p.selected,
});
const missing = new Set();
const palette = new Proxy(derived(PALETTES[themeName]), {
  get(target, name) {
    if (typeof name === "string" && !(name in target) && !/^(null|undefined|then|toJSON|error)$/.test(name) && !missing.has(name)) {
      missing.add(name);
      process.stderr.write(`render: theme has no token "${name}"\n`);
    }
    return target[name];
  },
});

export const agents = () => fake.agents;
export const terminals = () => { fake.reads.terminals++; return fake.terminals; };
export const panes = () => { fake.reads.panes++; return fake.panes; };
export const spaces = () => fake.spaces;
export const machines = () => [];
export const layout = () => fake.layout;
export const layouts = () => ["main"];
export const focused = () => fake.focused;
export const props = () => fake.props;
export const placement = () => null;
export const window = () => fake.window;
export const theme = () => palette;
export const settings = () => ({ font_family: "JetBrains Mono", ui_font_family: "Inter", zoom: 1, dark: themeName !== "day" });
export const keys = () => ({});
export const commands = () => [];
export const home = () => "/home/demo";
export const appHome = () => "/home/demo/.config/herdr-app";
export const checking = () => false;
export const shared = (key) => fake.stored[key];
export const setShared = (key, value) => { fake.stored[key] = value; return null; };
export const run = (name, args) => { fake.runs.push([name, args]); };
export const notify = (notice) => { fake.notices.push(notice); };
export const openOverlay = (overlay) => { fake.overlays.push(overlay); };
export const closeOverlay = (id) => { fake.closedOverlays.push(id); };
export const playSound = () => {};
export const setBadge = () => null;
export const setAgentOrder = (order) => { fake.orders.push(order); return null; };
export const nextCommand = () => never;
export const readTextFile = async (path) => (fake.read ? fake.read(path) : fake.files[path] ?? null);
export const writeTextFile = async (path, body, expected) => {
  if (fake.write) return fake.write(path, body, expected);
  fake.files[path] = body;
};
export const exec = async (cmd, args = [], options = {}) => {
  fake.execs.push([cmd, ...args].join(" "));
  return { code: 0, stdout: "", stderr: "", ...(await fake.exec(cmd, args, options)) };
};
export const pickFolder = async () => null;
export const watchFolder = (path) => {
  const ready = fake.folderChanges.get(path);
  if (ready) {
    fake.folderChanges.delete(path);
    return Promise.resolve(ready);
  }
  return new Promise((resolve) => fake.folderWaits.set(path, resolve));
};
