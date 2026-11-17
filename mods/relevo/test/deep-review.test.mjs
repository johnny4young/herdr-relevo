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
  assert.match(comments[0].body, /^\*\*blocker\*\*: Crashes on null/, "the higher level's words lead");
  assert.match(body, /Deep review · Team \+ Codex/);
  assert.match(body, /\*\*major\*\* `src\/b\.js`: No test Fix: Add one _\(Team\)_/, "a finding with no line goes in the body");
  assert.equal(draftReview([claude, codex], false).comments.length, 0);
  const prompt = findingsPrompt(PR, [claude, codex]);
  assert.match(prompt, /Findings, most severe first:\n- \*\*blocker\*\*/);
  assert.match(prompt, /False positive: <file:line> — why it is not a bug/);
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
  assert.equal(text(find(tree, "task-effect")), "2 to fix: Fix with a run, or Post as draft review to leave them on the PR.");
  assert.equal(text(find(tree, "task-title")), "Deep review · app #7");
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

const { checkDeepReview, modelArgs, setupLine } = await import("../lib/deep-setup.js");
const { deepReviewers } = await import("../deep-review.js");
const { deepReviewView } = await import("../deep-review-view.js");
const { verdicts } = await import("../lib/deep-review.js");

test("a deep review setup names accounts, models and efforts each provider takes", () => {
  assert.deepEqual(checkDeepReview([{ account: "repo", model: "opus", effort: "high" }, { account: "codex", model: "", effort: "xhigh" }], ["personal"], "codex"), []);
  assert.deepEqual(checkDeepReview([{ account: "codex", effort: "max" }, { account: "ghost" }], ["personal"], "codex").map((e) => e.at), ["deepReview.0.effort", "deepReview.1.account"]);
  assert.match(checkDeepReview([], [], "codex")[0].message, /at least one reviewer/);
  assert.deepEqual(modelArgs({ account: "team", model: "sonnet", effort: "medium" }, "codex", ["--x"]), ["--x", "--model", "sonnet", "--effort", "medium"]);
  assert.deepEqual(modelArgs({ account: "codex", model: "gpt-x", effort: "high" }, "codex", ["-m", "luna", "--sandbox", "workspace-write"]),
    ["-m", "gpt-x", "--sandbox", "workspace-write", "-c", 'model_reasoning_effort="high"']);
  assert.equal(setupLine([{ account: "repo", model: "opus", effort: "high" }, { account: "codex", model: "", effort: "high" }], () => "Codex"), "repo · opus high + Codex · high");
});

test("each reviewer of the setup lands on an account with room; Codex past 90% sits out", () => {
  const setup = [{ account: "repo", model: "opus", effort: "high" }, { account: "codex", model: "", effort: "high" }];
  assert.deepEqual(deepReviewers("me/app", {}, setup).map((r) => r.key), ["personal", "codex"]);
  const full = { personal: { h5: { pct: 98 } }, work: { h5: { pct: 10 } }, codex: { h5: { pct: 95 } } };
  const picked = deepReviewers("me/app", full, setup);
  assert.deepEqual(picked.map((r) => [r.key, r.model]), [["work", "opus"]]);
  assert.match(picked[0].note, /Personal is at 98%/);
});

test("the deep review reads as verdicts, then findings by level, with the long ones and what nobody checked folded", () => {
  const unsure = review("u", "Codex", []);
  unsure.attempts[0].report = { status: "blocked", summary: "No CI results", findings: [], notRun: ["make test"] };
  const long = review("l", "Team", [{ level: "major", where: "src/a.js:9", issue: "x".repeat(300), proof: "Called twice", fix: "Guard it" }]);
  assert.deepEqual(verdicts([long, unsure]).map((v) => [v.label, v.state, v.line]), [["Team", "changes", "1 major"], ["Codex", "unsure", "couldn't decide: No CI results"]]);
  const open = new Set(), ui = { open, toggle: (key) => (open.has(key) ? open.delete(key) : open.add(key)), openFile: (where) => opened.push(where) }, opened = [];
  const view = () => deepReviewView(theme(), "d", [long, unsure], ui);
  assert.match(text(find(view(), "d-f-0")), /^major a\.js:9 Team x{220}… Fix Guard it More$/);
  assert.match(text(find(view(), "d-unchecked")), /^What nobody checked · 1$/);
  find(view(), "d-f-0-more").handlers.on_click({}, { notify() {} });
  assert.match(text(find(view(), "d-f-0")), /Called twice/);
  find(view(), "d-f-0-where").handlers.on_click({}, { stop_propagation() {} });
  assert.deepEqual(opened, ["src/a.js:9"]);
  find(view(), "d-unchecked-head").handlers.on_click({}, { notify() {} });
  assert.match(text(find(view(), "d-unchecked")), /Not run: make test/);
});

test("Settings edits the deep review: an account, a model and an effort per reviewer, three at most", async () => {
  const { Settings } = await import("../settings.js");
  const s = new Settings(), cx = fakeCx();
  s.init({}, cx);
  const ui = () => s.render(cx);
  assert.deepEqual(s.collect().DEEP_REVIEW, [{ account: "repo", model: "opus", effort: "high" }, { account: "repo", model: "sonnet", effort: "high" }]);
  const [first, second] = s.deep;
  find(ui(), `sd-account-${second.id}-personal`).handlers.on_click({}, cx);
  assert.equal(second.effort, "high");
  find(ui(), `sd-effort-${second.id}-max`).handlers.on_click({}, cx);
  find(ui(), `sd-account-${first.id}-codex`).handlers.on_click({}, cx);
  find(ui(), `sd-effort-${first.id}-minimal`).handlers.on_click({}, cx);
  assert.deepEqual(s.collect().DEEP_REVIEW.map((r) => [r.account, r.effort]), [["codex", "minimal"], ["personal", "max"]]);
  find(ui(), "settings-add-deep").handlers.on_click({}, cx);
  assert.equal(s.deep.length, 3);
  assert.equal(find(ui(), "settings-add-deep").isDisabled, true);
});

test("a stuck PR reviewer is dismissed from its row, not retried", async () => {
  const stuck = { ...codex, state: "blocked", error: "No CI", attempts: [{ ...codex.attempts[0], report: { status: "blocked", summary: "No CI", findings: [] } }] };
  const { v, cx } = await runs([stuck]);
  v.navKey({ key: "j" }, cx); v.navKey({ key: "enter" }, cx);
  v.sel = `task-${stuck.id}`;
  const tree = v.render(cx);
  assert.equal(find(tree, `task-retry-${stuck.id}`), null);
  fake.exec = (cmd, args) => (/cli\.mjs$/.test(args[0] ?? "") ? { stdout: JSON.stringify({ doc: { tasks: [{ ...stuck, state: "cancelled" }], engine: { enabled: true } } }) } : null);
  find(tree, `task-dismiss-${stuck.id}`).handlers.on_click({}, cx);
  await flush();
  assert.ok(calls(/"action":"cancel"/).length);
});

test("the same problem found on another line of the same file, or in much the same words, is one finding", () => {
  const opus = review("o", "Opus", [{ level: "minor", where: "Sources/Readiness.swift:40", issue: "'Dictate once below' appears even when there is no practice card because the model is missing" },
    { level: "minor", where: "Sources/Other.swift:3", issue: "Unrelated naming" }]);
  const sonnet = review("s", "Sonnet", [{ level: "major", where: "Sources/Readiness.swift:52", issue: "The header says Dictate once below, but the practice card only exists when practiceIsShown", fix: "Gate it" },
    { level: "minor", where: "Sources/Readiness.swift:200", issue: "Spacing in the footer" }]);
  const merged = mergedFindings([opus, sonnet]);
  assert.deepEqual(merged.map((f) => [f.level, f.where, f.by.join("+")]), [
    ["major", "Sources/Readiness.swift:52", "Opus+Sonnet"], ["minor", "Sources/Other.swift:3", "Opus"], ["minor", "Sources/Readiness.swift:200", "Sonnet"]]);
});

test("a deep review is one row in its run, and Done closes every reviewer's part", async () => {
  const working = { ...codex, state: "running", attempts: [{ id: "w", role: "reviewer", state: "running" }] };
  const { v, cx } = await runs([claude, working]);
  v.navKey({ key: "j" }, cx); v.navKey({ key: "enter" }, cx);
  let tree = v.render(cx);
  assert.deepEqual(v.nav.map((entry) => entry.id), [`task-${claude.id}`]);
  assert.match(text(find(tree, `task-${claude.id}`)), /^Deep review · app #7 1 of 2 reviewers done/);
  v.navKey({ key: "enter" }, cx); tree = v.render(cx);
  assert.match(text(find(tree, "task-effect")), /^Codex is still reviewing/);
  const sent = [];
  fake.exec = (cmd, args) => {
    if (!/cli\.mjs$/.test(args[0] ?? "")) return null;
    sent.push(JSON.parse(args.at(-1)));
    return { stdout: JSON.stringify({ doc: { tasks: [claude, working], engine: { enabled: true } } }) };
  };
  v.navKey({ key: "a" }, cx); v.navKey({ key: "enter" }, cx);
  for (let i = 0; i < 4; i++) await flush();
  assert.deepEqual(sent.map((p) => [p.action, p.taskId, p.outcome ?? null]), [["decide", "c", "accept"], ["cancel", "x", null]]);
});

test("Fix with a run fits the goal and the task however many findings there are", async () => {
  const many = review("m", "Opus", Array.from({ length: 14 }, (_, i) => ({ level: i < 4 ? "major" : "minor", where: `src/f${i}.swift:${i * 40 + 1}`, issue: "Long issue ".repeat(60), fix: "Long fix ".repeat(40) })));
  const prompt = findingsPrompt(PR, [many]);
  assert.ok(prompt.length <= 3900, `${prompt.length}`);
  assert.equal((prompt.match(/\*\*major\*\*/g) ?? []).length, 4, "every finding to fix stays");
  const { fixFindings } = await import("../deep-review.js");
  const { readGoals } = await import("../goals-store.js");
  fake.files[goalsPath()] = JSON.stringify(saveGoal(emptyGoals(), { ...newGoal("old", "Fix #7 · Search", [`pr:${PR.url}`]), state: "completed" }, 0));
  await fixFindings([many]);
  const made = (await readGoals()).doc.goals.find((g) => g.id !== "old");
  assert.deepEqual([made.sources, made.criteria.length < 2000], [[], true], "a work item another run had stays with it");
  assert.equal(fake.runs.findLast(([n]) => n === "pane.split")[1].props.fixPR.prompt, prompt);
});

const { finishedAgents } = await import("../lib/run-panel.js");
const { fixChecklist } = await import("../lib/deep-review.js");
const { fixChecklistView } = await import("../deep-review-view.js");

test("a deep review's reviewer closes once it reported; a worktree run's agents once it is accepted; borrowed agents stay", async () => {
  const run = (state) => ({ id: state, state, worktree: { branch: "run/x" }, executor: { address: `w-${state}` }, reviewer: { address: `r-${state}` }, attempts: [] });
  const borrowed = { id: "b", state: "accepted", executor: { address: "mine" }, reviewer: { address: "mine2" }, attempts: [] };
  const reviewing = { ...codex, state: "running", attempts: [{ role: "reviewer", state: "running" }] };
  assert.deepEqual(finishedAgents([claude, reviewing, run("accepted"), run("running"), borrowed]), ["c", "w-accepted", "r-accepted"]);
  const { v, cx } = await runs([claude]);
  fake.agents = [{ address: "c", status: "done" }, { address: "busy", status: "working" }];
  fake.panes = [{ pane: "p-c", terminal: "c" }, { pane: "p-busy", terminal: "busy" }];
  fake.runs.length = 0;
  v.closeDoneAgents([claude, { ...claude, id: "z", reviewer: { address: "busy" } }]);
  v.closeDoneAgents([claude]);
  assert.deepEqual(fake.runs.filter(([n]) => n === "pane.close"), [["pane.close", { pane: "p-c" }]], "once, and never a working agent");
});

test("a fix run answers every finding: fixed, false positive, won't fix or needs your call, what needs you first", () => {
  const fix = { attempts: [{ role: "executor", report: { status: "completed", summary: "Fixed", details: [
    "Fixed: src/a.js:4 — guarded the null", "False positive: src/c.js:9 — the caller already checks it", "Not fixed: src/b.js — needs a redesign",
    "Needs your call: src/d.js:1 — should upgrades keep Fn off?", "Ran swiftlint"] } }] };
  const list = fixChecklist(fix);
  assert.equal(list.head, "1 needs your call · 1 fixed · 1 false positive · 1 won't fix");
  assert.match(text(fixChecklistView(theme(), "fx", list)),
    /^1 needs your call · 1 fixed · 1 false positive · 1 won't fix Needs your call · 1 d\.js:1 should upgrades keep Fn off\? Fixed · 1 a\.js:4 guarded the null False positive · 1 c\.js:9 the caller already checks it Won't fix · 1 b\.js needs a redesign$/);
  assert.equal(fixChecklist({ attempts: [{ role: "executor", report: { details: ["Ran tests"] } }] }), null);
  assert.match(findingsPrompt(PR, [claude]), /Needs your call: <file:line> — the question/);
});

test("Settings turns Codex off for every list and default", async () => {
  const { Settings } = await import("../settings.js");
  const s = new Settings(), cx = fakeCx();
  s.init({}, cx);
  assert.equal(s.collect().USE_CODEX, true);
  find(s.render(cx), "settings-use-codex-off").handlers.on_click({}, cx);
  assert.equal(s.collect().USE_CODEX, false);
  assert.equal(find(s.render(cx), `sd-account-${s.deep[0].id}-codex`), null, "a deep reviewer can't pick it");
});

test("before you accept: only the review that saw the latest writing, no note a passing check disproved, each note once", async () => {
  const { taskNotes } = await import("../lib/run-panel.js");
  const old = { role: "reviewer", report: { status: "changes_requested", findings: [{ level: "major", where: "a.js:1", issue: "Old" }], notRun: ["make test"] } };
  const wrote = { role: "executor", report: { status: "completed", notProven: ["make test did not run in the sandbox", "The UI tests were not run"] } };
  const fresh = { role: "reviewer", report: { status: "completed", findings: [{ level: "minor", where: "b.js:2", issue: "New" }], notProven: ["The UI tests were not run."] } };
  const task = { checksResult: [{ argv: ["make", "test"], code: 0 }], attempts: [old, wrote, fresh] };
  assert.deepEqual(taskNotes(task), { findings: [{ level: "minor", where: "b.js:2", issue: "New" }], unchecked: ["The UI tests were not run."] });
  assert.deepEqual(taskNotes({ ...task, attempts: [old, wrote] }).findings, [], "a review before the latest writing is stale");
});

test("test commands read and write as typed: npm test; make lint", async () => {
  const { checksText, parseChecks } = await import("../lib/run-checks.js");
  assert.deepEqual(parseChecks('npm test; make "test ui"\nswift test'), [["npm", "test"], ["make", "test ui"], ["swift", "test"]]);
  assert.equal(checksText([["npm", "test"], ["make", "test ui"]]), 'npm test; make "test ui"');
  assert.deepEqual(parseChecks('[["npm","test"]]'), [["npm", "test"]], "the older JSON still reads");
  assert.throws(() => parseChecks('npm "test'), /quote isn't closed/);
});
