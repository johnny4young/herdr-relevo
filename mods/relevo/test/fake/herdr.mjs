// The app's API over state a test sets. Unknown exec calls succeed with no output.
const never = new Promise(() => {});
const blank = () => ({
  agents: [], terminals: [], panes: [], spaces: [], layout: { id: "root", children: [] }, focused: null, props: {},
  window: { platform: "macos", titlebar: "none", active: true }, stored: {}, files: {},
  read: null, write: null, exec: () => null, execs: [], runs: [], notices: [], overlays: [], folderChanges: new Map(), folderWaits: new Map(),
});

export const fake = blank();
export const resetFake = () => Object.assign(fake, blank());
// Git and hc calls made so far, as "cmd arg arg".
export const calls = (pattern) => fake.execs.filter((line) => pattern.test(line));
export function changeFolder(path, changed) {
  const waiting = fake.folderWaits.get(path);
  if (waiting) {
    fake.folderWaits.delete(path);
    waiting(changed);
  } else fake.folderChanges.set(path, changed);
}
export const watched = () => [...fake.folderWaits.keys()];

const palette = new Proxy({}, { get: (_t, name) => (typeof name === "string" ? `#${name}` : undefined) });

export const agents = () => fake.agents;
export const terminals = () => fake.terminals;
export const panes = () => fake.panes;
export const spaces = () => fake.spaces;
export const layout = () => fake.layout;
export const focused = () => fake.focused;
export const props = () => fake.props;
export const window = () => fake.window;
export const theme = () => palette;
export const settings = () => ({ zoom: 1 });
export const home = () => "/home/test";
export const appHome = () => "/home/test/.config/herdr-app";
export const shared = (key) => fake.stored[key];
export const setShared = (key, value) => { fake.stored[key] = value; return null; };
export const run = (name, args) => { fake.runs.push([name, args]); };
export const notify = (notice) => { fake.notices.push(notice); };
export const openOverlay = (overlay) => { fake.overlays.push(overlay); };
export const closeOverlay = () => {};
export const playSound = () => {};
export const setAgentOrder = () => null;
export const nextCommand = () => never;
export const readTextFile = async (path) => (fake.read ? fake.read(path) : fake.files[path] ?? null);
export const writeTextFile = async (path, body, expected) => {
  if (fake.write) return fake.write(path, body, expected);
  fake.files[path] = body;
};
export const exec = async (cmd, args = [], options = {}) => {
  fake.execs.push([cmd, ...args].join(" "));
  return { code: 0, stdout: "", stderr: "", ...fake.exec(cmd, args, options) };
};
export const watchFolder = (path) => {
  const ready = fake.folderChanges.get(path);
  if (ready) {
    fake.folderChanges.delete(path);
    return Promise.resolve(ready);
  }
  return new Promise((resolve) => fake.folderWaits.set(path, resolve));
};
