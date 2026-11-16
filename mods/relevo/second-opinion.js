// A second opinion: another model reviews an open agent's uncommitted work. Relevo opens the reviewer beside it, and
// the coordinator runs the repository's tests, sends the reviewer the diff and brings its verdict to Runs.
import { agents, appHome, exec, notify, panes, setShared, spaces, terminals } from "herdr";
import { ACCOUNTS, CODEX, accountOf, full, launchArgv, loadClaudeQuotas, openInFolder } from "./accounts.js";
import { RUN_LAUNCH, repoChecks, trustKeys } from "./run-launch.js";
import { newGoal } from "./lib/goals.js";
import { writeGoal } from "./goals-store.js";
import { runtimeCommand } from "./runtime-cli.js";
import { runAgentArgs } from "./workflow-runs.js";
import { noteUse } from "./run-usage.js";

const WAIT_MS = 180000;
const READY = ["idle", "done", "working"];

// Who reviews: another provider than the writer's when it has quota, else another account that does.
export function opinionAccount(writer, quotas) {
  const claude = ACCOUNTS.map((account) => account.key);
  const order = writer === CODEX.key ? claude : [CODEX.key, ...claude];
  return order.find((key) => key !== writer && !full(quotas?.[key])) ?? null;
}

const tabOf = (address) => {
  const tab = panes().find((pane) => pane.terminal === address)?.tab;
  return spaces().flatMap((space) => space.tabs ?? []).find((item) => item.id === tab)?.name ?? null;
};

// `agent` is the one whose work is reviewed; `cwd` its folder. Returns the task id, or throws with what went wrong.
export async function askSecondOpinion(agent, cwd, cx) {
  noteUse("opinion");
  const writer = terminals().find((k) => k.address === agent.address)?.labels?.["agent.account"] ?? null;
  const reviewer = opinionAccount(writer, await loadClaudeQuotas().catch(() => ({})));
  if (!reviewer) throw Error("Every other account is out of quota");
  const repo = cwd.replace(/\/+$/, "").split("/").pop(), tab = `${repo} · second opinion`, label = accountOf(reviewer).label;
  const goal = { ...newGoal(`goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, `Second opinion · ${repo}`),
    criteria: `Review the uncommitted work of ${agent.name ?? agent.address} in ${repo}: is it correct, complete and safe to keep?` };
  await writeGoal(goal, 0);
  const launch = (words, trust = null) => setShared(RUN_LAUNCH, { goalId: goal.id, words, trust, at });
  const at = Date.now();
  launch(`Opening ${label} to review ${repo}…`);
  try {
    const checks = await repoChecks(cwd);
    openInFolder({ name: repo, folder: cwd, tab, argv: launchArgv(reviewer, null, runAgentArgs(reviewer, "reviewer", appHome())) });
    let found = null;
    while (!found) {
      if (Date.now() - at > WAIT_MS) throw Error(`${label} did not start in ${tab}`);
      await cx.sleep(1500);
      found = agents().find((a) => a.tab_name === tab && READY.includes(a.status)) ?? null;
      if (found || Date.now() - at < 8000) continue;
      // Not an agent yet: it may be asking to trust the folder, which the person answers from Runs.
      const waiting = terminals().find((k) => k.cwd === cwd && tabOf(k.address) === tab);
      const screen = waiting ? (await exec("hc", ["read", waiting.address, "--lines", "30"]).catch(() => null))?.stdout ?? "" : "";
      launch(trustKeys(screen) ? `${label} asks whether to trust ${repo} before it reviews.` : `Opening ${label} to review ${repo}…`,
        trustKeys(screen) ? { address: waiting.address } : null);
    }
    const result = await runtimeCommand({ action: "create", start: true, task: { goalId: goal.id, title: goal.title, criteria: goal.criteria, root: cwd,
      executor: { address: agent.address, label: writer ? accountOf(writer).label : agent.name ?? agent.address }, reviewer: { address: found.address, label },
      checks, maxRounds: 2, maxMinutes: 20, reviewOnly: true } });
    const response = JSON.parse(result.stdout || "{}");
    if (result.code !== 0 || response.error) throw Error(response.error || result.stderr || "Could not start the review");
    return response.result?.taskId ?? null;
  } finally {
    setShared(RUN_LAUNCH, null);
  }
}

export function secondOpinionNotice(error) {
  notify({ title: "Second opinion not started", body: String(error?.message ?? error), level: "error" });
}
