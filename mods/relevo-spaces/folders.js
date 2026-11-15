// The sidebar's folders: { list: [{ id, name, color, path, match, folded }], of: { spaceId: folderId }, at }.
// Kept in the same file and shared key the space-folders mod used, so existing folders carry over.
import { exec, shared, setShared } from "herdr";

export const FILE = "~/.config/herdr-space-folders.json";
export const KEY = "space-folders";
export const EMPTY = { list: [], of: {}, at: 0 };

export const folderData = () => shared(KEY)?.[""] ?? null;

export async function loadFolders() {
  if (folderData()) return folderData();
  const r = await exec("sh", ["-c", `cat ${FILE} 2>/dev/null`]);
  let data = EMPTY;
  try {
    const d = JSON.parse(r.stdout);
    data = { list: Array.isArray(d.list) ? d.list : [], of: d.of ?? {}, at: d.at ?? 0 };
  } catch { /* no file yet */ }
  // Another copy may have published while this one read the file.
  if (!folderData()) setShared(KEY, { ...(shared(KEY) ?? {}), "": data });
  return folderData();
}

export function saveFolders(next) {
  next = { list: next.list, of: next.of ?? {}, at: Date.now() };
  setShared(KEY, { ...(shared(KEY) ?? {}), "": next });
  return exec("sh", [
    "-c", `mkdir -p ~/.config && printf '%s\\n' "$1" > ${FILE}.tmp && mv ${FILE}.tmp ${FILE}`, "sh", JSON.stringify(next),
  ]);
}

export function updateFolders(change) {
  const now = folderData() ?? EMPTY;
  return saveFolders(change({ list: [...now.list], of: { ...now.of } }));
}

// A rule is a path (`~/code/*`) or a bare folder name that can appear anywhere in the path.
const rules = new Map();
export function compileRule(pattern) {
  if (!rules.has(pattern)) {
    const p = String(pattern ?? "").trim().replace(/\/+$/, "");
    const body = p.replace(/^~/, "\u0000").split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")
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
// One strong color per name, light and dark alike, as Herdr paints space avatars.
export const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
export const paint = (color, fallback) => (color ? MARK[color] ?? color : fallback);
