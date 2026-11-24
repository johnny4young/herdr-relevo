// A deep review of a pull request: the reviewers DEEP_REVIEW names each review its whole change against its base, in a
// worktree of their own, with the repository's tests and the PR's CI. Their findings meet in Runs, to post as a draft
// review or fix with a run.
import { appHome, exec, notify, run, setShared } from "herdr";
import { RUN_START } from "./run-launcher.js";
import { GOAL_MODE, GOAL_SCOPE } from "./inbox-goals.js";
import { accountOf, agentAccounts, hasRoom, launchArgv, loadClaudeQuotas, providerFor, withRoom } from "./accounts.js";
import { accountFor } from "./context.js";
import * as config from "./config.js";
import { DEFAULT_DEEP_REVIEW, reviewerLabel } from "./lib/deep-setup.js";
import { RUN_LAUNCH, openAgent, repoChecks } from "./run-launch.js";
import { runAgentArgs } from "./workflow-runs.js";
import { REMOVE_TIMEOUT } from "./worktrees.js";
import { runtimeCommand } from "./runtime-cli.js";
import { newGoal } from "./lib/goals.js";
import { readGoals, writeGoal } from "./goals-store.js";
import { openWorkflow } from "./workflow-window.js";
import { noteUse } from "./run-usage.js";
import { draftReview, findingsPrompt, reviewTitle } from "./lib/deep-review.js";

export const deepSetup = () => config.DEEP_REVIEW ?? DEFAULT_DEEP_REVIEW;

// Each reviewer of the setup on an account with room: a Claude account past 90% hands over to the one with the most
// left, and a provider with a single account sits out.
export function deepReviewers(repo, quotas, setup = deepSetup()) {
  return setup.flatMap((r) => {
    if (r.account !== "repo" && !providerFor(r.account).caps.accounts) {
      return agentAccounts().some((a) => a.key === r.account) && hasRoom(quotas?.[r.account]) ? [{ ...r, key: r.account, note: null }] : [];
    }
    const pick = withRoom(r.account === "repo" ? accountFor(repo) : r.account, quotas);
    return [{ ...r, key: pick.key, note: pick.note }];
  });
}

// What GitHub's checks say of the PR, for every reviewer: one line each.
async function ciOf(pr) {
  const r = await exec("gh", ["pr", "checks", String(pr.number), "--repo", pr.repo, "--json", "name,bucket"]).catch(() => null);
  try {
    const list = JSON.parse(r?.stdout || "[]");
    return list.length ? list.map((c) => `${c.name}: ${c.bucket}`).join("\n").slice(0, 4000) : "None reported.";
  } catch { return "Could not be read."; }
}

async function command(payload) {
  const r = await runtimeCommand(payload);
  const out = JSON.parse(r.stdout || "{}");
  if (r.code !== 0 || out.error) throw Error(out.error || r.stderr || "The runs coordinator did not answer");
  return out.result;
}

export async function startDeepReview(pr, clone, cx, setup = deepSetup()) {
  noteUse("deep-review");
  const name = pr.repo.split("/").pop(), at = Date.now();
  const reviewers = deepReviewers(pr.repo, await loadClaudeQuotas().catch(() => ({})), setup);
  if (!reviewers.length) throw Error("Every reviewer in the deep review setup is out of quota");
  const goal = { ...newGoal(`goal-${at}-${Math.random().toString(36).slice(2, 8)}`, reviewTitle({ url: pr.url, number: pr.number, head: pr.headRefOid }).slice(0, 240)),
    criteria: `Review pull request ${pr.url} (“${pr.title}”) as a whole against ${pr.baseRefName}: is it correct, complete, safe and ready to merge?` };
  await writeGoal(goal, 0);
  const say = (words, trust = null) => setShared(RUN_LAUNCH, { goalId: goal.id, words, trust, at });
  try {
    const ci = await ciOf(pr);
    let first = null;
    for (const [i, r] of reviewers.entries()) {
      const provider = providerFor(r.key), label = reviewerLabel(accountOf(r.key).label, r, provider.defaultModel(config));
      say(`Opening ${label} on #${pr.number}…`);
      const tree = await command({ action: "prepare-review", root: clone, who: ["first", "second", "third"][i], pr: { number: pr.number, head: pr.headRefOid, base: pr.baseRefName } });
      // The tests run once, in the first reviewer's worktree; the other reviewer reads their results there.
      const checks = i === 0 ? await repoChecks(tree.path) : [];
      const agent = await openAgent({ name, folder: tree.path, tab: `${name}#${pr.number} · review ${i + 1} ${label}`, label, cx,
        argv: launchArgv(r.key, null, provider.modelArgs(r, runAgentArgs(r.key, "reviewer", appHome()))),
        ask: (trust) => say(trust ? `${label} asks whether to trust ${name} before it reviews.` : `Opening ${label} on #${pr.number}…`, trust) });
      const made = await command({ action: "create", start: true, task: { goalId: goal.id, title: `${label} · #${pr.number} ${pr.title}`.slice(0, 240), criteria: goal.criteria,
        root: tree.path, reviewer: { address: agent.address, label }, checks, maxRounds: 1, maxMinutes: 30, reviewOnly: true, reviewBase: tree.base,
        pr: { url: pr.url, number: pr.number, headRef: pr.headRefName, clone, head: pr.headRefOid }, prChecks: ci, ...(first ? { checksFrom: first } : {}) } });
      first ??= made?.taskId ?? null;
      if (r.note) notify({ title: "Deep review", body: r.note, level: "info", timeout: 5000 });
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

// A run on a copy of the PR's branch, asked to fix what the reviewers found. It starts at once, from the Inbox, and
// Runs shows it starting; `adjust` opens the run window's form instead, to change who works on it or its tests.
export async function fixFindings(tasks, { adjust = false } = {}) {
  const pr = tasks[0].pr, source = `pr:${pr.url}`, prompt = findingsPrompt(pr, tasks);
  const { doc } = await readGoals();
  let goal = doc.goals.find((g) => g.state !== "completed" && g.sources.includes(source));
  if (!goal) {
    // A work item belongs to one run: a closed run that had it leaves the new one unlinked. The findings travel in
    // the task's prompt; the goal keeps a line.
    const taken = doc.goals.some((g) => g.sources.includes(source));
    goal = { ...newGoal(`goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, `Fix #${pr.number} · deep review`, taken ? [] : [source]),
      criteria: `Fix what the deep review of ${pr.url} found.`, from: tasks[0].goalId };
    await writeGoal(goal, 0);
  }
  if (adjust) return openWorkflow(goal.id, null, { fixPR: { url: pr.url, number: pr.number, headRef: pr.headRef, root: pr.clone, prompt } });
  setShared(RUN_START, { fields: { goalId: goal.id, title: goal.title, root: pr.clone, criteria: prompt }, pr: { url: pr.url, headRef: pr.headRef }, at: Date.now() });
  setShared(GOAL_MODE, true); setShared(GOAL_SCOPE, null);
  run("relevo.run-start");
}

// A closed review's worktrees hold nothing of anyone's: each goes, unless git finds a change in it.
export async function dropReviewTrees(reviews) {
  for (const r of reviews) if (r.pr?.clone && r.root) await exec("git", ["-C", r.pr.clone, "worktree", "remove", r.root], { timeout: REMOVE_TIMEOUT }).catch(() => null);
}

export function deepReviewNotice(title, error) {
  notify({ title, body: String(error?.message ?? error), level: "error" });
}
