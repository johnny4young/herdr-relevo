// The sidebar's folders: { list: [{ id, name, color, path, match, folded }], of: { spaceId: folderId }, at }.
// Kept in the same file and shared key the space-folders mod used, so existing folders carry over.
import { exec, focused, home, machines, notify, run, shared, setShared, spaces } from "herdr";

export const FILE = "~/.config/herdr-space-folders.json";
export const KEY = "space-folders";
export const EMPTY = { list: [], of: {}, at: 0 };

// Herdr starts terminals in the folder as written, so `~` has to be expanded first.
export const expandHome = (path) => String(path).replace(/^~(?=\/|$)/, home());

export const folderData = () => shared(KEY)?.[""] ?? null;
const publish = (data) => setShared(KEY, { ...(shared(KEY) ?? {}), "": data });
const failed = (r) => r.stderr?.trim() || String(r.message ?? "") || `exit ${r.code}`;

// A file that is there but can't be read stays as it is: the folders load empty and nothing is saved over it.
export async function loadFolders() {
  const now = folderData();
  if (now && !now.broken) return now;
  const r = await exec("sh", ["-c", `[ -e ${FILE} ] || exit 3; cat ${FILE}`]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
  let data = EMPTY;
  if (r.code === 0) {
    try {
      const d = JSON.parse(r.stdout);
      data = { list: Array.isArray(d.list) ? d.list : [], of: d.of ?? {}, at: d.at ?? 0 };
    } catch { data = { ...EMPTY, broken: "it is not valid JSON" }; }
  } else if (r.code !== 3) data = { ...EMPTY, broken: failed(r) };
  if (data.broken && data.broken !== now?.broken) {
    notify({ title: "Spaces can't read its folders", body: `${FILE}: ${data.broken}. Nothing is saved over it until it reads again.`, level: "error" });
  }
  // Another copy may have published while this one read the file.
  if (!folderData() || folderData().broken) publish(data);
  return folderData();
}

export async function saveFolders(next) {
  if (folderData()?.broken) {
    notify({ title: "Spaces didn't save its folders", body: `${FILE} can't be read: ${folderData().broken}.`, level: "error" });
    return null;
  }
  next = { list: next.list, of: next.of ?? {}, at: Date.now() };
  publish(next);
  const r = await exec("sh", [
    "-c", `mkdir -p ~/.config && t=$(mktemp ${FILE}.XXXXXX) && printf '%s\\n' "$1" > "$t" && mv "$t" ${FILE} || { rm -f "$t"; exit 1; }`,
    "sh", JSON.stringify(next),
  ]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
  if (r.code !== 0) notify({ title: "Spaces didn't save its folders", body: `${FILE}: ${failed(r)}`, level: "error" });
  return r;
}

export function updateFolders(change) {
  const now = folderData() ?? EMPTY;
  return saveFolders(change({ list: [...now.list], of: { ...now.of } }));
}

// A new space in a folder that is still there; a moved or deleted one says so instead of failing in Herdr.
export async function openSpaceIn(path, args = {}) {
  const folder = expandHome(path);
  const r = await exec("test", ["-d", folder, "-a", "-x", folder]).catch(() => ({ code: 1 }));
  if (r.code !== 0) {
    notify({ title: "Folder not found", body: `${folder} was moved, deleted or can't be opened.`, level: "warning" });
    return false;
  }
  run("space.new", { ...args, folder, machine: "" });
  return true;
}

// Herdr opens a new space on the focused space's machine; one it can't reach opens it here instead.
export function newSpace() {
  const machine = spaces().find((s) => s.id === focused()?.space)?.machine;
  const away = machine && machines().find((m) => m.name === machine)?.layout === "unavailable";
  run("space.new", away ? { machine: "" } : {});
}

// A rule is a path (`~/code/*`) or a bare folder name that can appear anywhere in the path.
const rules = new Map();
export function compileRule(pattern) {
  if (!rules.has(pattern)) {
    const p = String(pattern ?? "").trim().replace(/\/+$/, "");
    const body = p.replace(/^~(?=\/|$)/, "\u0000").split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")
      .replace("\u0000", "(?:/(?:home|Users)/[^/]+|/root)");
    rules.set(pattern, p ? new RegExp(`${/^[/~]/.test(p) ? "^" : "(?:^|/)"}${body}(?:/|$)`) : null);
  }
  return rules.get(pattern);
}

export const matches = (folder, path) => Boolean(path) && String(folder.match ?? "").split(",").some((p) => compileRule(p)?.test(path));

// A space someone put in a folder stays there; otherwise the first folder whose rules take where it works.
export function folderFor(spaceId, path, data) {
  const id = data?.of?.[spaceId];
  if (id !== undefined) {
    const put = data.list.find((f) => f.id === id);
    if (put) return put;
  }
  return data?.list.find((f) => matches(f, path)) ?? null;
}

export const COLORS = ["ansi4", "ansi2", "ansi3", "ansi5", "ansi6", "ansi1"];
// Machines start where folders end, and away from red, which says offline or needs you.
const MACHINE_COLORS = ["ansi5", "ansi6", "ansi3", "ansi2", "ansi4"];
// One strong color per name, light and dark alike, as Herdr paints space avatars.
export const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
export const paint = (color, fallback) => (color ? MARK[color] ?? color : fallback);

// Each other machine keeps one color, by its place in Herdr's machine list; away: its layout can't be reached.
export function machineLook(name, list = machines()) {
  const others = list.filter((m) => m.name), at = others.findIndex((m) => m.name === name);
  const i = at >= 0 ? at : [...String(name)].reduce((n, c) => n + c.charCodeAt(0), 0);
  return { color: paint(MACHINE_COLORS[i % MACHINE_COLORS.length]), away: others[at]?.layout === "unavailable" };
}
