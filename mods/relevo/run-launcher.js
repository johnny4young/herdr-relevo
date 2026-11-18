// A run started from the Inbox, with no window to fill in: its own worktree, its writer and reviewer, then the task.
// Each step is shared as it goes, so Runs shows the start as steps and asks there when an agent waits on a question.
import { appHome, setShared } from "herdr";
import { accountOf, launchArgv, loadClaudeQuotas } from "./accounts.js";
import { RUN_LAUNCH, launchSteps, openAgent, repoChecks } from "./run-launch.js";
import { runAccountsFor, runAgentArgs } from "./workflow-runs.js";
import { runtimeCommand } from "./runtime-cli.js";

export const RUN_START = "relevo.runs.start";

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
    labels = [["Worktree", tree.branch], ["Writer", writer], ["Reviewer", reviewer], ["Tests", checks.length ? checks.map((c) => c.join(" ")).join("; ") : "none declared"]];
    const slug = tree.branch.replace(/^run\//, ""), open = (role, key, step, tab, label) => openAgent({ name, folder: tree.path, tab, label, cx,
      argv: launchArgv(key, null, runAgentArgs(key, role, appHome())),
      ask: (trust) => say(step, trust ? `${label} asks whether to trust the run's worktree.` : `Opening ${label}…`, trust) });
    say(1, `Opening ${writer}…`);
    const executor = await open("executor", accounts.executor, 1, `${slug} · build`, writer);
    say(2, `Opening ${reviewer}…`);
    const review = await open("reviewer", accounts.reviewer, 2, `${slug} · review`, reviewer);
    say(3, "Starting the run…");
    await command({ action: "create", start: true, task: { goalId: fields.goalId, title: fields.title, criteria: fields.criteria, root: tree.path,
      checks, maxRounds: fields.maxRounds ?? 2, maxMinutes: fields.maxMinutes ?? 20,
      executor: { address: executor.address, label: writer }, reviewer: { address: review.address, label: reviewer },
      worktree: { branch: tree.branch, base: tree.base, baseCommit: tree.baseCommit, baseBranch: tree.baseBranch,
        ...(tree.prHead ? { prHead: tree.prHead, prUrl: pr?.url } : {}) } } });
  } finally {
    setShared(RUN_LAUNCH, null);
  }
}
