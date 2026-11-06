import { agents, panes, terminals, exec, home, shared, setShared, readTextFile } from "herdr";
import { repoOfGitDir, totals, week, weekStart } from "./lib/ledger.js";
import { timeWithin } from "./lib/away.js";
import { GIT_READ } from "./lib/git.js";
export { duration } from "./lib/time.js";

// One JSON line per stretch an agent worked: {start, end, jira, repo, branch, account}.
export const LEDGER = ".local/state/relevo/ledger.jsonl";
const OPEN = "relevo.ledger.open";
const JIRA = /\b([A-Z][A-Z0-9]+-\d+)\b/;

// readTextFile stops at 1 MiB, so past ROTATE_AT the older half of the lines moves to ledger.old.jsonl.
export const APPEND = 'mkdir -p "$(dirname "$1")" && printf "%s\\n" "$2" >> "$1" && s=$(wc -c < "$1") && [ "$s" -gt "$3" ] || exit 0; '
  + 'n=$(wc -l < "$1"); h=$((n / 2)); head -n "$h" "$1" >> "${1%.jsonl}.old.jsonl" && tail -n +$((h + 1)) "$1" > "$1.tmp" && mv "$1.tmp" "$1"';
const ROTATE_AT = 786432;

function append(entries) {
  if (!entries.length) return;
  const text = entries.map((e) => JSON.stringify(e)).join("\n");
  return exec("sh", ["-c", APPEND, "sh", `${home()}/${LEDGER}`, text, String(ROTATE_AT)]);
}

// Time goes to the repo, whichever worktree or subfolder the agent is in. Asked once per folder.
const projects = new Map();
function projectOf(cwd) {
  if (!projects.has(cwd)) {
    projects.set(cwd, exec("git", [...GIT_READ, "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd })
      .then((r) => (r.code === 0 ? repoOfGitDir(r.stdout.trim()) : null), () => null));
  }
  return projects.get(cwd);
}

// Open stretches live in shared state, so a reload keeps counting.
export async function ledgerTick() {
  const byPane = new Map(panes().map((p) => [p.pane, p]));
  const labels = new Map(terminals().map((k) => [k.address, k.labels ?? {}]));
  const working = new Map(agents().filter((a) => a.status === "working").map((a) => [a.address, a]));
  const started = shared(OPEN) ?? {};
  const cwds = [...working.values()].filter((a) => !started[a.address]).map((a) => byPane.get(a.pane)?.cwd).filter(Boolean);
  const names = new Map(await Promise.all(cwds.map(async (cwd) => [cwd, await projectOf(cwd)])));
  const open = { ...(shared(OPEN) ?? {}) }, now = Math.round(Date.now() / 1000), closed = [];
  for (const [address, entry] of Object.entries(open)) {
    if (working.has(address)) continue;
    closed.push({ ...entry, end: now });
    delete open[address];
  }
  for (const [address, a] of working) {
    if (open[address]) continue;
    const pane = byPane.get(a.pane), l = labels.get(address) ?? {}, branch = pane?.branch ?? null;
    open[address] = {
      start: now,
      jira: l["agent.jira"] || JIRA.exec(branch ?? "")?.[1] || null,
      repo: names.get(pane?.cwd) || (pane?.cwd ?? "").split("/").pop() || a.space_name,
      branch,
      account: l["agent.account"] || (a.app === "codex" ? "codex" : null),
    };
  }
  if (closed.length || Object.keys(open).length !== Object.keys(shared(OPEN) ?? {}).length) setShared(OPEN, open);
  return append(closed);
}

// Ledger lines that ended after `since`, plus the stretches still open.
async function rowsSince(since) {
  const now = Date.now() / 1000;
  const text = (await readTextFile(`${home()}/${LEDGER}`).catch(() => null)) ?? "";
  // Lines are appended in end order, so stop at the first one from before `since`.
  const lines = text.split("\n"), rows = Object.values(shared(OPEN) ?? {}).map((e) => ({ ...e, end: now }));
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let r;
    try {
      r = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (r.end <= since) break;
    rows.push(r);
  }
  return rows;
}

// Agent seconds between two moments, in seconds.
export async function agentTimeBetween(since, until) {
  return timeWithin(await rowsSince(since), since, until);
}

// Today's worked time per project, tickets included; only the week's table splits by ticket. Kept TODAY_FOR, or
// until a stretch opens or closes.
let todayKept = null;
const TODAY_FOR = 30000;
export async function today() {
  const since = new Date().setHours(0, 0, 0, 0) / 1000, key = `${since}|${Object.keys(shared(OPEN) ?? {}).sort().join(",")}`;
  if (todayKept?.key === key && Date.now() - todayKept.at < TODAY_FOR) return todayKept.value;
  const value = totals((await rowsSince(since)).map((r) => ({ ...r, jira: null })), since);
  todayKept = { key, at: Date.now(), value };
  return value;
}

// Seven days from Monday, `offset` weeks back or ahead of this one.
export async function weekOf(offset = 0) {
  const start = weekStart(Date.now() / 1000, offset);
  return week(await rowsSince(start), start);
}

