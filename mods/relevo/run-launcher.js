// A run started from the Inbox, with no window to fill in: its own worktree, its writer and reviewer, then the task.
// Each step is shared as it goes, so Runs shows the start as steps and asks there when an agent waits on a question.
import { appHome, setShared } from "herdr";
import { accountOf, launchArgv, loadClaudeQuotas } from "./accounts.js";
import { RUN_LAUNCH, launchSteps, openAgent, repoChecks, runTab } from "./run-launch.js";
import { runAccountsFor, runAgentArgs } from "./workflow-runs.js";
import { runtimeCommand } from "./runtime-cli.js";

export const RUN_START = "relevo.runs.start";

// A run's reviewer, opened when the coordinator reaches the review and named to the task. Its trust question, if any,
// shows in Runs like a start's.
export async function openReviewer(task, cx) {
  const key = task.reviewLater.account, label = task.reviewLater.label, branch = task.worktree?.branch ?? task.root.split("/").pop(), at = Date.now();
  const say = (words, trust = null) => setShared(RUN_LAUNCH, { goalId: task.goalId, words, trust, at,
    steps: launchSteps([["Writer", task.executor?.label ?? ""], ["Tests", "passed or noted"], ["Reviewer", label]], 2, Boolean(trust)) });
  try {
    say(`Opening ${label} to review…`);
    const agent = await openAgent({ name: task.root.split("/").pop(), folder: task.root, tab: runTab("reviewer", branch), label, cx,
      argv: launchArgv(key, null, runAgentArgs(key, "reviewer", appHome())),
      ask: (trust) => say(trust ? `${label} asks whether to trust the run's worktree.` : `Opening ${label} to review…`, trust) });
    await command({ action: "assign-reviewer", taskId: task.id, reviewer: { address: agent.address, label } });
  } finally {
    setShared(RUN_LAUNCH, null);
  }
}

async function command(payload) {
  const r = await runtimeCommand(payload);
  const out = JSON.parse(r.stdout || "{}");
  if (r.code !== 0 || out.error) throw Error(out.error || r.stderr || "The runs coordinator did not answer");
  return out.result;
}

// `fields`: { goalId, title, root, criteria, maxRounds?, maxMinutes?, checks? }; `pr`: { url, headRef } for a fix.
export async function launchRun(fields, pr, cx) {
  const accounts = runAccountsFor(fields.root, await loadClaudeQuotas().catch(() => ({}))), at = Date.now();
  const name = fields.root.split("/").pop(), writer = accountOf(accounts.executor).label, reviewer = accountOf(accounts.reviewer).label;
  let labels = [["Worktree", name], ["Writer", writer], ["Reviewer", reviewer], ["Tests", "reading"]];
  const say = (step, words, trust = null) => setShared(RUN_LAUNCH, { goalId: fields.goalId, words, trust, at, steps: launchSteps(labels, step, Boolean(trust)) });
  try {
    say(0, `Creating the worktree for ${fields.title}…`);
    const tree = await command({ action: "prepare-worktree", root: fields.root, title: fields.title, ...(pr ? { pr: { headRef: pr.headRef } } : {}) });
    const checks = fields.checks ?? await repoChecks(tree.path);
    // The reviewer opens once the writing is done (openReviewer), so a run starts with one tab.
    labels = [["Worktree", tree.branch], ["Writer", writer], ["Tests", checks.length ? checks.map((c) => c.join(" ")).join("; ") : "none declared"], ["Reviewer", `${reviewer} · opens to review`]];
    say(1, `Opening ${writer}…`);
    const executor = await openAgent({ name, folder: tree.path, tab: runTab("executor", tree.branch), label: writer, cx,
      argv: launchArgv(accounts.executor, null, runAgentArgs(accounts.executor, "executor", appHome())),
      ask: (trust) => say(1, trust ? `${writer} asks whether to trust the run's worktree.` : `Opening ${writer}…`, trust) });
    say(2, "Starting the run…");
    await command({ action: "create", start: true, task: { goalId: fields.goalId, title: fields.title, criteria: fields.criteria, root: tree.path,
      checks, maxRounds: fields.maxRounds ?? 2, maxMinutes: fields.maxMinutes ?? 20,
      executor: { address: executor.address, label: writer }, reviewLater: { account: accounts.reviewer, label: reviewer },
      worktree: { branch: tree.branch, base: tree.base, baseCommit: tree.baseCommit, baseBranch: tree.baseBranch,
        ...(tree.prHead ? { prHead: tree.prHead, prUrl: pr?.url } : {}) } } });
  } finally {
    setShared(RUN_LAUNCH, null);
  }
}
