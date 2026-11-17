// A deep review of a pull request: its worktree on real git, its findings merged, posted as a draft review, and its
// place in Reviews and Runs.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fake, resetFake, calls, theme } from "./fake/herdr.mjs";
import { fakeCx, flush, find, text } from "./fake/ui.mjs";
import { newGoal, saveGoal, emptyGoals } from "../lib/goals.js";
import { prepareReview } from "../runtime/worktree.mjs";
import { draftReview, findingsPrompt, mergedFindings } from "../lib/deep-review.js";
import { reviewSkills } from "../lib/prmenu.js";

const { Inbox } = await import("../inbox.js");
const { GOAL_MODE } = await import("../inbox-goals.js");
const { goalsPath } = await import("../goals-store.js");
const { postDraftReview } = await import("../deep-review.js");

beforeEach(resetFake);
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const PR = { url: "https://github.com/me/app/pull/7", number: 7, headRef: "feat/x", clone: "/work/app" };
const said = (summary, findings) => ({ id: `a-${summary}`, role: "reviewer", state: "reported", report: { status: findings.length ? "changes_requested" : "completed", summary, findings } });
const review = (id, label, findings, state = "needs_you") => ({ id, goalId: "g", title: `${label} · #7`, state, root: `/w/${id}`, executor: null,
  reviewer: { address: id, label }, reviewOnly: true, pr: PR, round: 0, maxRounds: 1, revision: `rev-${id}`, attempts: [said(`${label} says`, findings)] });
const claude = review("c", "Team", [{ level: "minor", where: "src/a.js:4", issue: "Name is vague", fix: "Rename" }, { level: "major", where: "src/b.js", issue: "No test", fix: "Add one" }]);
const codex = review("x", "Codex", [{ level: "blocker", where: "src/a.js:4", issue: "Crashes on null", fix: "Guard it" }]);

test("the PR's exact head in a detached worktree, with its merge base; a moved PR is refused", async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relevo-review-"))), origin = path.join(base, "origin"), home = path.join(base, "home");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(origin); fs.mkdirSync(home);
  git(origin, "init", "-q", "-b", "main"); git(origin, "config", "user.email", "t@example.invalid"); git(origin, "config", "user.name", "T");
  fs.writeFileSync(path.join(origin, "a.txt"), "one\n"); git(origin, "add", "."); git(origin, "commit", "-qm", "one");
  const fork = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-qb", "feat"); fs.writeFileSync(path.join(origin, "a.txt"), "two\n"); git(origin, "commit", "-qam", "two");
  const head = git(origin, "rev-parse", "HEAD");
  git(origin, "update-ref", "refs/pull/7/head", head); git(origin, "checkout", "-q", "main");
  const root = path.join(base, "app");
  execFileSync("git", ["clone", "-q", origin, root]);
  const tree = await prepareReview({ root, pr: { number: 7, head, base: "main" }, who: "claude", home });
  assert.deepEqual([git(tree.path, "rev-parse", "HEAD"), tree.base], [head, fork]);
  assert.equal(git(tree.path, "branch", "--show-current"), "", "detached: no branch is made");
  assert.equal((await prepareReview({ root, pr: { number: 7, head, base: "main" }, who: "claude", home })).path, tree.path, "the same head reuses it");
  await assert.rejects(prepareReview({ root, pr: { number: 7, head: fork, base: "main" }, who: "codex", home }), /new commits/);
  await assert.rejects(prepareReview({ root, pr: { number: 7, head, base: "../x" }, who: "codex", home }), /can't be reviewed/);
});

test("findings from both reviewers merge on the same line at the higher level, most severe first", () => {
  const merged = mergedFindings([claude, codex]);
  assert.deepEqual(merged.map((f) => [f.level, f.where, f.by.join("+")]), [["blocker", "src/a.js:4", "Team+Codex"], ["major", "src/b.js", "Team"]]);
  const { body, comments } = draftReview([claude, codex]);
  assert.deepEqual(comments.map((c) => [c.path, c.line, c.side]), [["src/a.js", 4, "RIGHT"]]);
  assert.match(comments[0].body, /^\*\*blocker\*\*: Name is vague/);
  assert.match(body, /Deep review · Team \+ Codex/);
  assert.match(body, /\*\*major\*\* `src\/b\.js`: No test Fix: Add one _\(Team\)_/, "a finding with no line goes in the body");
  assert.equal(draftReview([claude, codex], false).comments.length, 0);
  const prompt = findingsPrompt(PR, [claude, codex]);
  assert.match(prompt, /Fix each of these:\n- \*\*blocker\*\*/);
  assert.doesNotMatch(prompt, /Optional/);
});

test("a draft review goes to GitHub pending, and again without line comments when GitHub refuses a line", async () => {
  const posted = [];
  fake.exec = (cmd, args) => {
    if (cmd !== "sh") return null;
    posted.push(JSON.parse(args[3]));
    return posted.length === 1 ? { code: 1, stderr: "HTTP 422: Pull request review thread line must be part of the diff" } : { stdout: JSON.stringify({ html_url: "https://github.com/me/app/pull/7#pullrequestreview-1" }) };
  };
  assert.equal(await postDraftReview([claude, codex]), "https://github.com/me/app/pull/7#pullrequestreview-1");
  assert.deepEqual(posted.map((p) => [p.comments.length, "event" in p]), [[1, false], [0, false]], "no event: the review stays pending");
  assert.match(posted[1].body, /src\/a\.js:4/);
});

test("the review skills you type most, for the ▾ beside Deep review", () => {
  assert.deepEqual(reviewSkills({ "code-review": 40, "code-review-pr-fix": 12, commit: 90, "security-review": 1, "swift-preflight": 3, loop: 5 }).map((s) => s.name),
    ["code-review", "code-review-pr-fix", "swift-preflight", "security-review"]);
});

async function runs(tasks) {
  const goal = newGoal("g", "Deep review · app #7");
  fake.files[goalsPath()] = JSON.stringify(saveGoal(emptyGoals(), goal, 0));
  fake.files["/home/test/.config/herdr-app/relevo-workflow/state.json"] = JSON.stringify({ tasks, events: [], engine: { enabled: true } });
  const v = new Inbox(), cx = fakeCx(); v.init({}, cx); await flush();
  fake.stored[GOAL_MODE] = true; v.h.is_focused = () => true; v.render(cx);
  return { v, cx };
}

test("a PR review's verdict offers a draft review, a fix run and Done, never Ask for changes", async () => {
  const { v, cx } = await runs([claude, codex]);
  v.navKey({ key: "j" }, cx); v.navKey({ key: "enter" }, cx); v.render(cx); v.navKey({ key: "enter" }, cx);
  const tree = v.render(cx);
  assert.equal(text(find(tree, "task-post-review")), "Post as draft review");
  assert.equal(text(find(tree, "task-fix-findings")), "Fix with a run");
  assert.equal(text(find(tree, "task-accept")), "a Done");
  assert.equal(find(tree, "task-changes"), null);
  assert.match(text(find(tree, "task-effect")), /^2 findings, 2 to fix, from 2 reviewers\. Nothing reaches GitHub until you post it\.$/);
  v.navKey({ key: "r" }, cx);
  assert.equal(v.runChangeFor, null);
  assert.equal(calls(/cli\.mjs/).filter((l) => l.includes("decide")).length, 0);
});

test("your PR offers Deep review, with your review skills on its ▾; a PR you were asked to review does not", async () => {
  const inbox = new Inbox(), cx = fakeCx();
  fake.exec = (cmd) => (cmd === "gh" ? { stdout: JSON.stringify({ data: { viewer: { login: "me", pullRequests: { nodes: [] } }, search: { nodes: [] } } }) } : null);
  inbox.init({}, cx); await flush();
  inbox.clones["me/app"] = "/work/app";
  const pr = { url: PR.url, number: 7, repo: "me/app", title: "X", skills: [], reasons: [], headRefOid: "a".repeat(40), baseRefName: "main", headRefName: "feat/x", updatedAt: new Date().toISOString() };
  const els = (requested) => inbox.prActions(theme(), pr, requested).actions.filter((a) => a?.el).map((a) => a.el());
  const deep = els(false).find((el) => find(el, `deep-${PR.url}`));
  assert.ok(deep);
  assert.equal(els(true).some((el) => find(el, `deep-${PR.url}`)), false);
  find(deep, `deep-pick-${PR.url}`).handlers.on_click({}, { stop_propagation() {} });
  assert.equal(fake.overlays.at(-1).props.reviews, true);
});
