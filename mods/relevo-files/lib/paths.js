// Pure path and text helpers for the tree, its actions and the editor.

export const PREVIEW_LIMIT = 400000;

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };

export function languageOf(path) {
  const name = path.split("/").pop() ?? "";
  const ext = name.includes(".") ? name.split(".").pop() : "txt";
  return LANG[ext] ?? ext;
}

// An error message for a name typed into New file, New folder or Rename; null when it's fine.
export function nameError(name) {
  if (!name) return "Type a name";
  if (name === "." || name === "..") return "Not a valid name";
  if (name.includes("/") || name.includes("\0")) return "A name can't contain /";
  if (name !== name.trim()) return "Remove leading or trailing spaces";
  return null;
}

export const parentOf = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
export const baseName = (rel) => rel.slice(rel.lastIndexOf("/") + 1);
export const join = (...parts) => parts.filter(Boolean).join("/");

// Where New file / New folder land: inside a clicked folder, beside a clicked file.
export const targetFolder = ({ path, dir }) => (dir ? path : parentOf(path));

// A path under `from` after `from` became `to`; the path unchanged when it isn't under it.
export function moved(path, from, to) {
  if (path === from) return to;
  if (path?.startsWith(`${from}/`)) return to + path.slice(from.length);
  return path;
}

export const isUnder = (path, folder) => path === folder || Boolean(path?.startsWith(`${folder}/`));

// readTextFile stops at 1 MiB, so a file that size or bigger may have come back cut.
export const READ_LIMIT = 1024 * 1024;

// What the viewer may do with what readTextFile returned; `bytes` is the size on disk (null if unknown).
export function textState(text, bytes) {
  if (text === null) return { error: "This file is no longer available" };
  if (text.includes("\0")) return { error: "Binary file · no text preview" };
  if (text.length > PREVIEW_LIMIT) return { value: `${text.slice(0, PREVIEW_LIMIT)}\n… (file truncated)`, editable: false };
  return { value: text, editable: bytes !== null && bytes < READ_LIMIT };
}
