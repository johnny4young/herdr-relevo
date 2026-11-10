// Past Claude sessions to resume: what the history and session files say, pure for the tests.

// "account\tms\tproject\tid" lines, newest first, one per account and session.
export function parseIndex(text) {
  const by = new Map();
  for (const line of text.split("\n")) {
    const [account, ms, project, id] = line.split("\t");
    if (!id || !project || !Number(ms)) continue;
    const key = `${account}/${id}`, at = Number(ms);
    if ((by.get(key)?.at ?? 0) < at) by.set(key, { account, at, project, id });
  }
  return [...by.values()].sort((a, b) => b.at - a.at);
}

// One `"name":value` pair; a string cut short gets its quote back, minus any half escape.
function fieldOf(pair) {
  for (const text of [pair, `${pair.replace(/\\(u[0-9a-fA-F]{0,3})?$/, "")}"`]) {
    try {
      return JSON.parse(`{${text}}`);
    } catch {
      // the next form, or nothing
    }
  }
  return null;
}

// "account/id\t<json field>" lines from the end of each session file; the last of each field wins.
export function parseDetails(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const field = fieldOf(line.slice(tab + 1));
    if (!field) continue;
    Object.assign(out[line.slice(0, tab)] ??= {}, field);
  }
  return out;
}

export const titleOf = (d) => (d?.customTitle || d?.lastPrompt || "").replace(/\s+/g, " ").trim().slice(0, 120);

// The repo's main checkout, inside it, or one of its Herdr worktrees.
export const inRepo = (project, top, name, home) => Boolean(top)
  && (project === top || project.startsWith(`${top}/`) || project.startsWith(`${home}/.herdr/worktrees/${name}/`));

// Every word of the query, in any order, in the title, folder, branch or account.
export function matches(row, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${row.title} ${row.project.split("/").pop()} ${row.branch ?? ""} ${row.account}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}
