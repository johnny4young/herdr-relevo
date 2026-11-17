// A deep review of a pull request: Claude and Codex each review its whole change against its base, in a worktree of
// their own, after the repository's tests run. Their findings meet in Runs, to post as a draft review or fix with a run.
import { appHome, exec, notify, setShared } from "herdr";
import { CODEX, accountOf, hasRoom, launchArgv, loadClaudeQuotas, pickAccount } from "./accounts.js";
import { RUN_LAUNCH, openAgent, repoChecks } from "./run-launch.js";
import { runAgentArgs } from "./workflow-runs.js";
import { runtimeCommand } from "./runtime-cli.js";
import { newGoal } from "./lib/goals.js";
import { readGoals, writeGoal } from "./goals-store.js";
import { openWorkflow } from "./workflow-window.js";
import { noteUse } from "./run-usage.js";
import { draftReview, findingsPrompt } from "./lib/deep-review.js";

// The repo's Claude account (or the one with room), and Codex while it has room: two providers see different things.
export function deepReviewers(repo, quotas) {
  const claude = pickAccount(repo, quotas).key;
  return [{ key: claude, who: "claude" }, ...(hasRoom(quotas?.[CODEX.key]) ? [{ key: CODEX.key, who: "codex" }] : [])];
}

async function command(payload) {
  const r = await runtimeCommand(payload);
  const out = JSON.parse(r.stdout || "{}");
  if (r.code !== 0 || out.error) throw Error(out.error || r.stderr || "The runs coordinator did not answer");
  return out.result;
}

export async function startDeepReview(pr, clone, cx) {
  noteUse("deep-review");
  const name = pr.repo.split("/").pop(), at = Date.now();
  const reviewers = deepReviewers(pr.repo, await loadClaudeQuotas().catch(() => ({})));
  const goal = { ...newGoal(`goal-${at}-${Math.random().toString(36).slice(2, 8)}`, `Deep review · ${name} #${pr.number}`.slice(0, 240)),
    criteria: `Review pull request ${pr.url} (“${pr.title}”) as a whole against ${pr.baseRefName}: is it correct, complete, safe and ready to merge?` };
  await writeGoal(goal, 0);
  const say = (words, trust = null) => setShared(RUN_LAUNCH, { goalId: goal.id, words, trust, at });
  try {
    for (const [i, r] of reviewers.entries()) {
      const label = accountOf(r.key).label;
      say(`Opening ${label} on #${pr.number}…`);
      const tree = await command({ action: "prepare-review", root: clone, who: r.who, pr: { number: pr.number, head: pr.headRefOid, base: pr.baseRefName } });
      // The tests run once, in the first reviewer's worktree; the other reviewer reads their results there.
      const checks = i === 0 ? await repoChecks(tree.path) : [];
      const agent = await openAgent({ name, folder: tree.path, tab: `${name}#${pr.number} · review ${label}`, label, cx,
        argv: launchArgv(r.key, null, runAgentArgs(r.key, "reviewer", appHome())),
        ask: (trust) => say(trust ? `${label} asks whether to trust ${name} before it reviews.` : `Opening ${label} on #${pr.number}…`, trust) });
      await command({ action: "create", start: true, task: { goalId: goal.id, title: `${label} · #${pr.number} ${pr.title}`.slice(0, 240), criteria: goal.criteria,
        root: tree.path, reviewer: { address: agent.address, label }, checks, maxRounds: 1, maxMinutes: 30, reviewOnly: true, reviewBase: tree.base,
        pr: { url: pr.url, number: pr.number, headRef: pr.headRefName, clone } } });
    }
  } finally {
    setShared(RUN_LAUNCH, null);
  }
  return goal.id;
}

// A pending review, edited and sent by you on GitHub. Lines outside the diff make GitHub refuse the comments, so it
// tries again with every finding in the body.
export async function postDraftReview(tasks) {
  const pr = tasks[0].pr, [, owner, repo] = /github\.com\/([^/]+)\/([^/]+)\/pull/.exec(pr.url) ?? [];
  const post = (review) => exec("sh", ["-c", 'printf "%s" "$1" | gh api -X POST "$2" --input -', "sh", JSON.stringify(review),
    `repos/${owner}/${repo}/pulls/${pr.number}/reviews`]);
  let r = await post(draftReview(tasks, true));
  if (r.code !== 0 && /line|position|diff|422/i.test(r.stderr ?? "")) r = await post(draftReview(tasks, false));
  if (r.code !== 0) throw Error((r.stderr || "gh failed").trim().split("\n")[0]);
  return JSON.parse(r.stdout || "{}").html_url ?? pr.url;
}

// A run on a copy of the PR's branch, asked to fix what the reviewers found.
export async function fixFindings(tasks) {
  const pr = tasks[0].pr, source = `pr:${pr.url}`, prompt = findingsPrompt(pr, tasks);
  const { doc } = await readGoals();
  let goal = doc.goals.find((g) => g.state !== "completed" && g.sources.includes(source) && g.title.startsWith("Fix "));
  if (!goal) {
    goal = { ...newGoal(`goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, `Fix #${pr.number} · deep review`, [source]), criteria: prompt };
    await writeGoal(goal, 0);
  }
  openWorkflow(goal.id, null, { fixPR: { url: pr.url, number: pr.number, headRef: pr.headRef, root: pr.clone, prompt } });
}

export function deepReviewNotice(title, error) {
  notify({ title, body: String(error?.message ?? error), level: "error" });
}
