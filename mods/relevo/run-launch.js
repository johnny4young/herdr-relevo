// A worktree run between Start and its task: what it waits on, shared so Runs can show it wherever the person is.
import { agents, appHome, exec, panes, readTextFile, spaces, terminals } from "herdr";
import { openInFolder } from "./accounts.js";
import { CHECK_FILES, detectChecks } from "./lib/run-checks.js";
import { machineOf } from "./lib/machines.js";

export const RUN_LAUNCH = "relevo.runs.launch";

// The steps of a start, as Runs draws them: done, the one running, or waiting; `ask` when an agent waits on a question.
export const launchSteps = (labels, at, ask = false) => labels.map(([label, note], i) => ({ label, note, state: i < at ? "done" : i === at ? (ask ? "ask" : "run") : "wait" }));

// A new worktree asks Claude and Codex whether to trust it: the keys that answer yes, or null. Pressed only on the
// person's click, since trusting lets the folder's own settings run.
export function trustKeys(screen) {
  if (/❯ Yes, I trust this folder/.test(screen)) return ["enter"];
  if (/❯ No, exit/.test(screen) && /Yes, I trust this folder/.test(screen)) return ["down", "enter"];
  if (/Trust this folder\?/.test(screen) && /› 1\. Trust and continue/.test(screen)) return ["enter"];
  return null;
}

// Claude Code asks before it adds a folder given with --add-dir. A run agent is given only Relevo's own reports folder,
// so that question is answered here, and only when it names exactly that folder.
export function ownFolderKeys(screen, folder) {
  if (!/Adding a new directory/.test(screen) || !/Yes, add it/.test(screen) || !screen.includes(folder)) return null;
  return /❯ Yes, add it/.test(screen) ? ["enter"] : ["down", "enter"];
}
// A run's tabs say their role first, so a cut name still tells the writer from the reviewer.
export const runTab = (role, branch) => `${role === "reviewer" ? "Reviewer" : "Writer"} · ${branch.replace(/^run\//, "").replace(/-[0-9a-f]{6}$/, "")}`;
export const reportsFolder = () => `${appHome()}/relevo-workflow/reports`;

// Answers yes only while the terminal still shows the question: a key sent to an agent that already started would type.
export async function answerTrust(address) {
  const screen = (await exec("hc", ["read", address, "--lines", "30"]).catch(() => null))?.stdout ?? "";
  const keys = trustKeys(screen);
  if (keys) await exec("hc", ["keys", address, ...keys]).catch(() => null);
  return Boolean(keys);
}

const READY = ["idle", "done", "working"];
const tabOf = (address) => {
  const tab = panes().find((pane) => pane.terminal === address)?.tab;
  return spaces().flatMap((space) => space.tabs ?? []).find((item) => item.id === tab)?.name ?? null;
};

// Opens an agent in its own tab and waits until it can take work. Until it does, `ask` gets the trust question
// it may be stopped on ({ address }), or null, for Runs to show.
export async function openAgent({ name, folder, tab, argv, label, ask, cx, waitMs = 180000 }) {
  openInFolder({ name, folder, tab, argv });
  const at = Date.now();
  for (;;) {
    if (Date.now() - at > waitMs) throw Error(`${label} did not start in ${tab}`);
    await cx.sleep(1500);
    // Two runs can share a tab name: the one in this folder wins. A run opens here, so another machine's tab is never it.
    const named = agents().filter((a) => !machineOf(a.address) && a.tab_name === tab && READY.includes(a.status));
    const found = named.find((a) => terminals().find((k) => k.address === a.address)?.cwd === folder) ?? named[0];
    if (found) return found;
    if (Date.now() - at < 8000) continue;
    const waiting = terminals().find((k) => !machineOf(k.address) && k.cwd === folder && tabOf(k.address) === tab);
    const screen = waiting ? (await exec("hc", ["read", waiting.address, "--lines", "30"]).catch(() => null))?.stdout ?? "" : "";
    const own = waiting && ownFolderKeys(screen, reportsFolder());
    if (own) { await exec("hc", ["keys", waiting.address, ...own]).catch(() => null); continue; }
    ask(trustKeys(screen) ? { address: waiting.address } : null);
  }
}

// Files whose text decides the command; for the others being there is enough.
const READ_CHECK_FILES = new Set(["package.json", "pyproject.toml", "Makefile"]);

// The test commands a repository declares: one shell call to see which files are there, then the few that are read.
export async function repoChecks(root) {
  const listed = await exec("sh", ["-c", 'for f; do [ -e "$f" ] && printf "%s\\n" "$f"; done', "sh", ...CHECK_FILES], { cwd: root }).catch(() => null);
  const there = new Set((listed?.stdout ?? "").split("\n").filter(Boolean)), files = {};
  for (const name of CHECK_FILES) files[name] = !there.has(name) ? null : READ_CHECK_FILES.has(name) ? (await readTextFile(`${root}/${name}`).catch(() => "")) ?? "" : "";
  return detectChecks(files) ?? [];
}
