// Every terminal that is not an agent, as rows: what runs in it, where it lives and what can be done with it.
// Pure, so tests feed it records shaped like terminals() and panes().

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "nu", "login", "tcsh", "ksh"]);
const DAY_MS = 24 * 3600e3;
export const base = (p) => String(p ?? "").split("/").pop().replace(/^-/, "");
const isShell = (argv) => SHELLS.has(base(argv?.[0]));
// "npm run dev", not the full paths of node and vite.js.
const command = (argv) => (argv ?? []).slice(0, 3).map((a, i) => (i === 0 ? base(a) : a.includes("/") ? base(a) : a)).join(" ");

export function isAgent(k, agentAddresses = new Set()) {
  return agentAddresses.has(k.address) || Boolean(k.program?.agent) || (k.status !== null && typeof k.status === "object" && Boolean(k.status.app));
}

// One terminal as a row, or null for an agent. state: running | idle | old | failed | done.
export function terminalRow(k, { agents = new Set(), panes = [], now = Date.now() } = {}) {
  if (!k?.address || isAgent(k, agents)) return null;
  const pane = panes.find((p) => p.terminal === k.address) ?? null, shell = isShell(k.argv);
  const fg = k.foreground ?? null, busy = Boolean(fg?.pid) && fg.pid !== k.pid;
  const live = k.state === "live";
  const state = !live ? (shell || k.exit_code === 0 || k.exit_code == null ? "done" : "failed")
    : busy || !shell ? "running" : now - (k.created_ms ?? now) > DAY_MS ? "old" : "idle";
  const [space, tab] = String(k.labels?.where ?? "").split(" / ");
  const title = k.name && !/^relevo-[0-9a-f]+$/.test(k.name) ? k.name : busy ? command(fg.argv) || base(fg.name) : shell ? base(k.argv[0]) : command(k.argv) || "terminal";
  return {
    id: `term-${k.address}`, address: k.address, title, state, live, shell, background: live && !pane,
    pane: pane?.pane ?? null, branch: pane?.branch ?? null, cwd: fg?.cwd ?? k.cwd ?? null, space: space || base(k.cwd) || "Elsewhere", tab: tab ?? null,
    spaceId: k.labels?.["herdr.space"] ?? null, argv: k.argv ?? [], name: k.name ?? null, exit: k.exit_code ?? null,
    pids: [k.pid, fg?.pid].filter(Boolean), at: (live ? k.created_ms : k.finished_ms ?? k.created_ms) ?? now,
    // Restart re-runs the terminal's own command; a program typed into a shell can only be stopped.
    canRestart: !shell && (k.argv?.length ?? 0) > 0, canStop: live && shell && busy,
  };
}

const RANK = { failed: 0, running: 1, idle: 2 };
// Groups in screen order: one per space (failed, running, idle), then in the background, idle over a day, finished.
export function terminalGroups(rows) {
  const spaces = new Map(), background = [], old = [], done = [];
  for (const r of rows) {
    if (r.state === "done") done.push(r);
    else if (r.state === "old") old.push(r);
    else if (r.background) background.push(r);
    else spaces.set(r.space, [...(spaces.get(r.space) ?? []), r]);
  }
  const groups = [...spaces].sort(([a], [b]) => a.localeCompare(b))
    .map(([space, list]) => ({ id: `space-${space}`, label: space, rows: list.sort((x, y) => RANK[x.state] - RANK[y.state] || y.at - x.at) }));
  if (background.length) groups.push({ id: "background", label: "In the background", rows: background });
  if (old.length) groups.push({ id: "old", label: "Idle over a day", rows: old });
  if (done.length) groups.push({ id: "done", label: "Finished", rows: done.sort((x, y) => y.at - x.at), folded: true });
  return groups;
}

export const terminalCounts = (rows) => ({
  running: rows.filter((r) => r.state === "running").length,
  idle: rows.filter((r) => r.state === "idle" || r.state === "old").length,
  failed: rows.filter((r) => r.state === "failed").length,
});

// `lsof -nP -iTCP -sTCP:LISTEN -Fpn` → [{ pid, port }].
export function parseListening(text) {
  const out = [];
  let pid = null;
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) {
      const port = Number(/:(\d+)$/.exec(line)?.[1]);
      if (port && !out.some((x) => x.pid === pid && x.port === port)) out.push({ pid, port });
    }
  }
  return out;
}

// `ps -ax -o pid=,ppid=` → Map pid → parent pid.
export function parseParents(text) {
  const out = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (m) out.set(Number(m[1]), Number(m[2]));
  }
  return out;
}

// The ports each row listens on: a listening process that is the row's process or descends from it.
export function portsOf(rows, listening, parents) {
  const owner = new Map();
  for (const r of rows) for (const pid of r.pids) owner.set(pid, r.address);
  const out = new Map();
  for (const { pid, port } of listening) {
    let at = pid;
    for (let hops = 0; at && hops < 32 && !owner.has(at); hops++) at = parents.get(at);
    const address = owner.get(at);
    if (address) out.set(address, [...new Set([...(out.get(address) ?? []), port])].sort((a, b) => a - b));
  }
  return out;
}

// Terminal output with its colour codes and blank tail taken out: the last lines worth reading.
export function lastLines(text, n = 2) {
  return String(text ?? "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-n);
}

const HOUR_MS = 3600e3;
// What Maintenance offers to tidy: what failed, what finished, what runs with no pane for over an hour, shells idle over a day.
export function tidyRows(rows, now = Date.now()) {
  const failed = rows.filter((r) => r.state === "failed"), done = rows.filter((r) => r.state === "done");
  const background = rows.filter((r) => r.background && r.state === "running" && now - r.at > HOUR_MS), old = rows.filter((r) => r.state === "old");
  return { failed, done, background, old, count: failed.length + done.length + background.length + old.length };
}
