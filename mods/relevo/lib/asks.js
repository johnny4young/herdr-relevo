// What an agent asks permission for, from the note the hook leaves (hooks/relevo-labels.sh), in the shape of the
// ask the screen reader finds. A note only counts for the request the screen shows now.
export const ASKS_DIR = ".local/state/relevo/asks";
// The hook writes just before the agent blocks; clocks and scans leave this much room, in seconds.
const EARLY = 120;
const PROBE = 24;

const squash = (s) => String(s ?? "").replace(/[\s│┃]+/g, "");
const rows = (s) => String(s ?? "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
const base = (p) => String(p ?? "").split("/").filter(Boolean).pop() ?? "";
const host = (u) => /^[a-z]+:\/\/([^/?#]+)/i.exec(String(u ?? ""))?.[1] ?? "";
const diff = (was, now) => [...rows(was).map((l) => `- ${l}`), ...rows(now).map((l) => `+ ${l}`)];
const toolName = (tool) => tool.replace(/^mcp__/, "").replace(/__/g, " · ").replace(/_/g, " ");

export function parseNote(raw) {
  try {
    const note = JSON.parse(raw ?? "");
    return note && typeof note === "object" && typeof note.tool === "string" && note.input && typeof note.input === "object" ? note : null;
  } catch {
    return null;
  }
}

// title, about and body as the card shows them; probes are pieces the agent's screen must show for the note to be its own.
function described(note) {
  const tool = note.tool, v = note.input;
  if (tool === "AskUserQuestion") return null;
  if (tool === "Bash") {
    const body = rows(v.command), all = squash(v.command);
    // A long command's title may have scrolled away; a short one's few letters prove little without it.
    return body.length ? { title: "Bash command", about: String(v.description ?? ""), body, probes: [all.slice(0, PROBE), all.slice(-PROBE)], needs: all.length < PROBE ? "Bash command" : "" } : null;
  }
  if (tool === "ExitPlanMode") return rows(v.plan).length ? { title: "Plan", about: "", body: rows(v.plan), probes: [], plan: true } : null;
  if (tool === "Edit" || tool === "MultiEdit" || tool === "Write" || tool === "NotebookEdit") {
    const file = v.file_path ?? v.notebook_path;
    const edits = Array.isArray(v.edits) ? v.edits : [v];
    const body = tool === "Write" ? rows(v.content) : edits.flatMap((e) => diff(e.old_string, e.new_string ?? e.new_source));
    return file ? { title: tool === "Write" ? "Create file" : "Edit file", about: String(file), body, probes: [squash(base(file))] } : null;
  }
  if (tool === "WebFetch") {
    return v.url ? { title: "Fetch", about: "", body: [`url: ${v.url}`, ...rows(v.prompt)], probes: [squash(host(v.url))] } : null;
  }
  const first = Object.values(v).find((x) => typeof x === "string" && squash(x).length >= 6);
  const body = rows(JSON.stringify(v, null, 2));
  return first ? { title: toolName(tool), about: "", body, probes: [squash(first).slice(0, PROBE)] } : null;
}

// The ask a note holds, or null when the screen shows something else: an older request, another dialog.
// since: when the agent began to wait, in seconds; plan: the screen asks to approve a plan.
export function noteAsk(note, screen, { since = null, plan = false } = {}) {
  if (!note || (since && Number(note.at) < since - EARLY)) return null;
  const d = described(note);
  if (!d || Boolean(d.plan) !== plan) return null;
  const shown = squash(screen);
  if (d.needs && !shown.includes(squash(d.needs))) return null;
  if (d.probes.length && !d.probes.some((p) => p && shown.includes(p))) return null;
  return { title: d.title, about: d.about, body: d.body, cut: false };
}
