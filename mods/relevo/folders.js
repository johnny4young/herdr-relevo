import { exec, home, shared, setShared } from "herdr";
import { CONTEXTS, REPOS_ROOT as ROOT } from "./config.js";
import { contextFor } from "./context.js";

// The space-folders mod keeps its folders in this file and in shared "space-folders".
const FILE = "~/.config/herdr-space-folders.json";

// One folder per context; the default one catches every path the others don't list.
const BASE = CONTEXTS.map((c, i) => ({
  id: c.key, name: c.label, color: c.color, path: `~/${ROOT}`, folded: false, ...(i === 0 ? { match: "~" } : {}),
}));
const DEFAULT = BASE[0].id;

async function readFile() {
  const r = await exec("sh", ["-c", `cat ${FILE} 2>/dev/null`]);
  try {
    const d = JSON.parse(r.stdout);
    return { list: d.list ?? [], of: d.of ?? {}, at: d.at ?? 0 };
  } catch {
    return { list: [], of: {}, at: 0 };
  }
}

async function current() {
  return shared("space-folders")?.[""] ?? await readFile();
}

function save(next) {
  next = { ...next, at: Date.now() };
  setShared("space-folders", { ...(shared("space-folders") ?? {}), "": next });
  return exec("sh", [
    "-c", `mkdir -p ~/.config && printf '%s\\n' "$1" > ${FILE}.tmp && mv ${FILE}.tmp ${FILE}`, "sh", JSON.stringify(next),
  ]);
}

// Folder rules can only match paths, so each context's folder lists the clones its orgs own.
async function reposByContext() {
  const script = 'for d in "$1"/*/; do u=$(git -C "$d" remote get-url origin 2>/dev/null) && printf "%s\\t%s\\n" "$(basename "$d")" "$u"; done';
  const r = await exec("sh", ["-c", script, "sh", `${home()}/${ROOT}`]);
  const out = Object.fromEntries(BASE.map((b) => [b.id, []]));
  for (const line of r.stdout.split("\n").filter(Boolean).sort()) {
    const [name, url] = line.split("\t");
    out[contextFor(url).key].push(name);
  }
  return out;
}

export async function syncFolders() {
  const f = await current(), repos = await reposByContext();
  const list = [...f.list];
  for (const base of BASE) {
    if (!list.some((x) => x.id === base.id)) list.splice(base.id === DEFAULT ? list.length : 0, 0, base);
  }
  const matches = Object.fromEntries(BASE.filter((b) => b.id !== DEFAULT).map((b) => [b.id, repos[b.id].join(", ")]));
  const changed = list.length !== f.list.length || list.some((x) => x.id in matches && x.match !== matches[x.id]);
  if (changed) await save({ ...f, list: list.map((x) => (x.id in matches ? { ...x, match: matches[x.id] } : x)) });
}

// Focus folds the other context's folder; "all" opens both.
export async function foldFor(focus) {
  const f = await current();
  const list = f.list.map((x) => (BASE.some((b) => b.id === x.id)
    ? { ...x, folded: focus !== "all" && x.id !== focus }
    : x));
  if (list.some((x, i) => x.folded !== f.list[i].folded)) await save({ ...f, list });
}
