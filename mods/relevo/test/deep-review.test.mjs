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
  find(deep, `deep-run-${PR.url}`).handlers.on_click({}, { stop_propagation() {} });
  assert.equal(fake.overlays.at(-1).props.role, "deep-review", "Deep review opens its dialog first");
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

test("Settings edits the deep review: an account, a model and an effort per reviewer, six at most", async () => {
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
  for (let i = 0; i < 4; i++) find(ui(), "settings-add-deep").handlers.on_click({}, cx);
  assert.equal(s.deep.length, 6);
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
  const { RUN_START } = await import("../run-launcher.js");
  assert.deepEqual([fake.stored[RUN_START].fields.criteria, fake.stored[RUN_START].pr.headRef], [prompt, "feat/x"], "the Inbox starts it, no form");
  assert.deepEqual(fake.runs.at(-1), ["relevo.run-start", undefined]);
  assert.equal(fake.runs.some(([n]) => n === "pane.split"), false);
  await fixFindings([many], { adjust: true });
  assert.equal(fake.runs.findLast(([n]) => n === "pane.split")[1].props.fixPR.prompt, prompt, "Adjust… opens the form");
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

test("a fix run reads against its deep review: what it did with each finding, from its verdicts, its report or its diff", async () => {
  const { fixOutcome } = await import("../lib/deep-review.js");
  const { fixOutcomeView } = await import("../deep-review-view.js");
  const findings = mergedFindings([claude, codex]);
  const old = { attempts: [{ role: "executor", report: { status: "completed", details: ["Major (no test): added one in b.js and its suite"] } }] };
  const read = fixOutcome(findings, old, ["src/a.js"]);
  assert.equal(read.head, "2 changed");
  assert.deepEqual(read.groups[0].rows.map((r) => [r.f.where, r.why]), [["src/a.js:4", ""], ["src/b.js", ""]], "a report line says it was touched, not why");
  assert.equal(read.tally, "2 of 2 majors handled");
  const said = { attempts: [{ role: "executor", report: { status: "completed", details: ["False positive: src/a.js:4 — the caller guards null"] } }] };
  const outcome = fixOutcome(findings, said, []);
  assert.equal(outcome.head, "1 false positive · 1 not touched");
  assert.match(text(fixOutcomeView(theme(), "fo", outcome)), /^1 false positive · 1 not touched False positive · 1 blocker a\.js:4 Crashes on null the caller guards null Not touched · 1 major b\.js No test$/);
});

test("Fix with a run hands the deep review over: its reviewers close, and it links to the fix run", async () => {
  const fixTask = { id: "f", goalId: "fixgoal", title: "Fix #7", state: "needs_you", worktree: { prUrl: PR.url, branch: "run/fix" }, executor: { address: "w" }, reviewer: { address: "r" }, attempts: [] };
  const goals = [newGoal("g", "Deep review · app #7"), newGoal("fixgoal", "Fix #7 · deep review")];
  fake.files[goalsPath()] = JSON.stringify(goals.reduce((doc, g) => saveGoal(doc, g, 0), emptyGoals()));
  fake.files["/home/test/.config/herdr-app/relevo-workflow/state.json"] = JSON.stringify({ tasks: [claude, codex, fixTask], events: [], engine: { enabled: true } });
  const v = new Inbox(), cx = fakeCx(); v.init({}, cx); await flush();
  fake.stored[GOAL_MODE] = true; v.h.is_focused = () => true; v.render(cx);
  v.enterRun(goals[0]); v.resetRun(claude.id);
  const tree = v.render(cx);
  assert.match(text(find(tree, "deep-fix-run")), /^Runs from this review · 1 ↳ Fix #7 · deep review · .+ Open$/);
  const sent = [];
  fake.exec = (cmd, args) => { if (!/cli\.mjs$/.test(args[0] ?? "")) return null; sent.push(JSON.parse(args.at(-1))); return { stdout: JSON.stringify({ doc: { tasks: [claude, codex, fixTask], engine: { enabled: true } } }) }; };
  v.closeReview(claude, cx, "Handed to a fix run.");
  for (let i = 0; i < 4; i++) await flush();
  assert.deepEqual(sent.map((p) => [p.action, p.taskId]), [["decide", "c"], ["decide", "x"]]);
  assert.equal(v.runNotice, "Handed to a fix run.");
});

test("closed runs archive or delete; ones closed over a week ago archive themselves", async () => {
  const { dropGoals, staleClosed } = await import("../lib/goals.js");
  const old = { ...newGoal("old", "Old run"), state: "completed" }, fresh = { ...newGoal("new", "New run"), state: "completed" };
  let doc = saveGoal(saveGoal(emptyGoals(), old, 0, "2026-01-01T00:00:00Z", { close: true }), fresh, 0, "2026-03-01T00:00:00Z", { close: true });
  assert.deepEqual(staleClosed(doc, 7, Date.parse("2026-03-03T00:00:00Z")), ["old"]);
  doc = dropGoals(doc, ["old"], "archived", "2026-03-03T00:00:00Z");
  assert.deepEqual([doc.goals.map((g) => g.id), doc.history.at(-1).action], [["new"], "archived"]);
});

test("a run row selects on a click and shows e, c and p; a second click opens it; a closed run archives with a", async () => {
  const done = { ...newGoal("z", "Shipped thing"), state: "completed" };
  fake.files[goalsPath()] = JSON.stringify(saveGoal(saveGoal(emptyGoals(), newGoal("g", "Deep review · app #7"), 0), done, 0, undefined, { close: true }));
  fake.files["/home/test/.config/herdr-app/relevo-workflow/state.json"] = JSON.stringify({ tasks: [claude, codex], events: [], engine: { enabled: true } });
  const v = new Inbox(), cx = fakeCx(); v.init({}, cx); await flush();
  fake.stored[GOAL_MODE] = true; v.h.is_focused = () => true;
  let tree = v.render(cx);
  find(tree, "goal-g").handlers.on_click({}, cx);
  tree = v.render(cx);
  assert.equal(v.sel, "goal-g"); assert.equal(v.goalProjection.scope, null, "a click only selects");
  assert.ok(find(tree, "goal-edit-g")); assert.match(text(find(tree, "list-keys")), /move open e edit c close p plan/);
  assert.match(text(find(tree, "goal-now-g")), /1 blocker, 1 major to look at/);
  v.navKey({ key: "c" }, cx); assert.equal(v.confirmClose, "g");
  find(v.render(cx), "goal-g").handlers.on_click({}, cx);
  v.render(cx);
  assert.equal(v.goalProjection.scope?.id, "g", "a second click opens");
});

test("the fix at a glance: majors handled and left, Ask to fix on what is left, the rest folded", async () => {
  const { fixGlanceView } = await import("../deep-review-view.js");
  const { fixOutcome } = await import("../lib/deep-review.js");
  const findings = mergedFindings([claude, codex]);
  const fix = { attempts: [{ role: "executor", report: { status: "completed", details: ["Fixed: src/a.js:4 — guarded it"] } }] };
  const asked = [], open = new Set();
  const ui = { open, toggle: (k) => (open.has(k) ? open.delete(k) : open.add(k)), ask: (f) => asked.push(f.where) };
  const view = () => fixGlanceView(theme(), "fg", fixOutcome(findings, fix, []), ui);
  assert.match(text(view()), /^1 of 2 majors handled · 1 left major b\.js No test Ask to fix Handled · 1$/);
  find(view(), "fg-left-0-ask").handlers.on_click({}, {});
  assert.deepEqual(asked, ["src/b.js"]);
  const { statusWords } = await import("../lib/run-panel.js");
  assert.equal(statusWords({ state: "needs_you", checks: [["make", "test"]], checksResult: [{ argv: ["make", "test"], code: 0 }], reviewer: { label: "Codex" },
    attempts: [{ role: "executor", report: { status: "completed" } }, { role: "reviewer", report: { status: "completed" } }] }).text, "Ready to accept · make test passed · Codex approved");
});

test("an accepted run commits with the writer's message in the repository's style, never the prompt", async () => {
  const { commitMessage } = await import("../lib/run-report.js");
  const run = (report, prHead = "feat/x") => ({ title: "Fix #138 · deep review", criteria: "Fix pull request #138 after a deep review…", worktree: { prHead },
    attempts: [{ role: "executor", report }] });
  assert.deepEqual(commitMessage(run({ summary: "Done", commit: { subject: "fix(settings): open the practice step on the Dictation tab", body: "Why." } }), true),
    { subject: "fix(settings): open the practice step on the Dictation tab", body: "Why." });
  assert.deepEqual(commitMessage(run({ summary: "The guide now closes when System Settings quits.", details: ["Closed the guide", "Added a test"] }), true),
    { subject: "fix: the guide now closes when System Settings quits", body: "- Closed the guide\n- Added a test" });
  assert.equal(commitMessage(run({ summary: "Add a slug helper" }, null), false).subject, "Add a slug helper", "a repository without conventional commits keeps its style");
  assert.equal(commitMessage(run({ summary: "Add a slug helper" }, null), true).subject, "feat: add a slug helper");
  assert.doesNotMatch(JSON.stringify(commitMessage(run({ summary: "x" }), true)), /deep review…/);
});

test("the deep review dialog: how many reviewers, each one's account, model and effort; Start hands it to the Inbox", async () => {
  const { DeepReviewDialog, DEEP_ASK, DEEP_LAST } = await import("../deep-review-dialog.js");
  const pr = { url: PR.url, number: 7, title: "X", repo: "me/app", headRefOid: "a".repeat(40), baseRefName: "main", headRefName: "feat/x" };
  fake.props = { pr, folder: "/work/app", overlay: 9 };
  const d = new DeepReviewDialog(), cx = fakeCx();
  d.init({}, cx); await flush();
  const pick = (i, field, value) => { find(d.render(cx), `deep-${i}-${field}`).handlers.on_click({}, cx); find(d.render(cx), `deep-${i}-${field}-${value}`).handlers.on_click({}, cx); };
  assert.match(text(d.render(cx)), /^Deep review · app #7 · aaaaaaa 2 reviewers 1 P Personal · repo's/);
  assert.equal(d.rows.length, 2, "two by default");
  find(d.render(cx), "deep-add").handlers.on_click({}, cx);
  assert.equal(d.rows.length, 3);
  d.key({ key: "1" }, { stop_propagation() {}, notify() {} });
  assert.equal(d.rows.length, 1, "a digit sets the count");
  for (let i = 0; i < 6; i++) d.key({ key: "+" }, { stop_propagation() {}, notify() {} });
  assert.equal(d.rows.length, 6, "up to six");
  find(d.render(cx), "deep-5-remove").handlers.on_click({}, cx);
  d.count(1, cx);
  pick(0, "account", "codex");
  assert.deepEqual([d.rows[0].account, d.rows[0].model.value(), d.rows[0].effort], ["codex", "", "high"]);
  pick(0, "effort", "xhigh");
  pick(0, "account", "work");
  assert.deepEqual([d.rows[0].account, d.rows[0].model.value(), d.rows[0].effort], ["work", "sonnet", "xhigh"]);
  pick(0, "model", "opus");
  assert.equal(d.menu, null, "a choice closes its menu");
  find(d.render(cx), "deep-start").handlers.on_click({}, cx);
  assert.deepEqual(fake.stored[DEEP_ASK].setup, [{ account: "work", model: "opus", effort: "xhigh" }]);
  assert.deepEqual(fake.stored[DEEP_LAST], [{ account: "work", model: "opus", effort: "xhigh" }], "remembered for next time");
  assert.deepEqual(fake.runs.at(-1), ["relevo.deep-review-start", undefined]);
  assert.deepEqual(fake.closedOverlays, [9]);

  const inbox = new Inbox(), icx = fakeCx();
  inbox.init({}, icx); await flush();
  inbox.clones["me/app"] = "/work/app";
  inbox.takeDeepAsk(icx);
  assert.equal(inbox.deepFor, PR.url, "the Inbox opens the reviewers");
  assert.equal(fake.stored[DEEP_ASK], null);
});

test("a machine without the codex command never offers Codex", async () => {
  const { agentAccounts, codexOn, CODEX_FOUND } = await import("../accounts.js");
  fake.stored[CODEX_FOUND] = false;
  assert.equal(codexOn(), false);
  assert.equal(agentAccounts().some((a) => a.key === "codex"), false);
  fake.stored[CODEX_FOUND] = true;
  assert.equal(codexOn(), true);
});

test("a fix run starts from the Inbox with no form: worktree, writer, then the task; its reviewer opens when the review comes", async () => {
  const { launchRun } = await import("../run-launcher.js");
  const { RUN_LAUNCH, launchSteps } = await import("../run-launch.js");
  const seen = [], sent = [];
  let created = null;
  fake.agents = [{ address: "w1", tab_name: "Writer · fix-7", status: "idle" }, { address: "r1", tab_name: "Reviewer · fix-7", status: "idle" }];
  fake.exec = (cmd, args) => {
    if (!/cli\.mjs$/.test(args[0] ?? "")) return null;
    const p = JSON.parse(args.at(-1)); sent.push(p.action); seen.push(fake.stored[RUN_LAUNCH]?.steps?.map((s) => s.state).join(","));
    if (p.action === "prepare-worktree") return { stdout: JSON.stringify({ result: { path: "/w/fix", branch: "run/fix-7-a1b2c3", base: "/work/app", baseCommit: "c".repeat(40), baseBranch: "feat/x", prHead: "feat/x" } }) };
    if (p.action === "create") created = p.task;
    return { stdout: JSON.stringify({ result: { taskId: "t1" } }) };
  };
  await launchRun({ goalId: "g", title: "Fix #7", root: "/work/app", criteria: "Fix it" }, { url: PR.url, headRef: "feat/x" }, fakeCx());
  assert.deepEqual(sent, ["prepare-worktree", "create"]);
  assert.equal(seen[0], "run,wait,wait,wait");
  assert.equal(seen[1], "done,done,run,wait", "only the writer opens before the task is created");
  assert.deepEqual([created.executor.address, created.reviewer, created.reviewLater.account], ["w1", undefined, "personal"]);
  const { openReviewer } = await import("../run-launcher.js");
  sent.length = 0;
  await openReviewer({ id: "t1", goalId: "g", root: "/w/fix", executor: { label: "Personal" }, worktree: { branch: "run/fix-7-a1b2c3" }, reviewLater: { account: "work", label: "Work" } }, fakeCx());
  assert.deepEqual(sent, ["assign-reviewer"], "the reviewer opens in its Reviewer tab and is named to the task");
  assert.equal(fake.stored[RUN_LAUNCH], null, "the steps go once it started");
  assert.deepEqual(launchSteps([["A"], ["B"]], 1, true).map((s) => s.state), ["done", "ask"]);
});

test("Claude Code's question about the reports folder is answered, and only for that folder", async () => {
  const { ownFolderKeys } = await import("../run-launch.js");
  const ask = (path, cursor = "No") => ` Adding a new directory:\n\n ${path}\n\n This session hasn't worked here before.\n\n ${cursor === "No" ? "❯ No, exit\n   Yes, add it" : "  No, exit\n ❯ Yes, add it"}`;
  const mine = "/home/test/.config/herdr-app/relevo-workflow/reports";
  assert.deepEqual(ownFolderKeys(ask(mine), mine), ["down", "enter"]);
  assert.deepEqual(ownFolderKeys(ask(mine, "Yes"), mine), ["enter"]);
  assert.equal(ownFolderKeys(ask("/home/test/elsewhere"), mine), null, "any other folder waits for the person");
  assert.equal(ownFolderKeys("❯ Yes, I trust this folder", mine), null);
});

test("a fix run sits under the deep review it came from, and finished runs read newest first with when", async () => {
  const { parentRun, finishedWords } = await import("../lib/run-panel.js");
  const review = { goal: newGoal("r", "Deep review"), closed: false, group: "ready", finishedAt: 1 };
  const fix = { goal: { ...newGoal("f", "Fix #7"), from: "r" }, closed: false, group: "flight" };
  const legacy = { goal: newGoal("l", "Fix #7 old"), closed: true, group: "ready" };
  const tasks = { r: [claude], f: [], l: [{ worktree: { prUrl: PR.url } }] };
  assert.equal(parentRun(fix, [review, fix, legacy], (g) => tasks[g.id]), review, "named by the fix");
  assert.equal(parentRun(legacy, [review, fix, legacy], (g) => tasks[g.id]), review, "an older fix is matched by its pull request");
  assert.match(finishedWords(Date.parse("2026-11-17T16:42:00Z"), Date.parse("2026-11-17T18:42:00Z")), /^2h ago · Nov 17, \d\d:42$/);

  const v = new Inbox(), cx = fakeCx(); v.init({}, cx); await flush();
  v.runBucket = (goal) => ({ all: tasks[goal.id] ?? [] });
  const older = { goal: newGoal("o", "Older"), closed: false, group: "ready", finishedAt: 0 };
  const tree = v.runTree([older, review, fix, legacy]);
  const ready = tree.open.find((g) => g.group === "ready").rows.map((r) => [r.entry.goal.id, r.depth]);
  assert.deepEqual(ready, [["r", 0], ["f", 1], ["l", 1], ["o", 0]], "newest first, every fix under its open review");
  assert.deepEqual(tree.open.find((g) => g.group === "flight").rows.map((r) => r.entry.goal.id), [], "the fix in flight sits under its review, not in its own group");
});

test("the dialog's models are what each account used here lately, then the names its CLI takes", async () => {
  const { recentModels } = await import("../lib/deep-setup.js");
  const report = { rows: [{ account: "personal", model: "claude-opus-5-5", day: "2026-11-10" }, { account: "personal", model: "claude-sonnet-5-5", day: "2026-11-17" },
    { account: "personal", model: "<synthetic>", day: "2026-11-17" }, { account: "work", model: "claude-haiku-5-5", day: "2026-11-17" }] };
  assert.deepEqual(recentModels(report, "personal").map((m) => m.model), ["claude-sonnet-5-5", "claude-opus-5-5"]);
  const { DeepReviewDialog } = await import("../deep-review-dialog.js");
  fake.props = { pr: { url: PR.url, number: 7, repo: "me/app", headRefOid: "a".repeat(40) }, folder: "/work/app", overlay: 1 };
  const d = new DeepReviewDialog(), cx = fakeCx(); d.init({}, cx); await flush();
  d.report = report;
  assert.deepEqual(d.modelOptions(d.rows[0]).map((o) => o.model), ["claude-sonnet-5-5", "claude-opus-5-5", "opus", "sonnet", "haiku"]);
});

test("a stalled start shows its steps, why one waits and the way on, instead of the form", async () => {
  const { Workflow } = await import("../workflow.js");
  const w = new Workflow(), cx = fakeCx(); w.init({}, cx); await flush();
  w.launch = { stage: "stalled", fields: { title: "Fix #7", root: "/work/app", goalId: "g" }, accounts: { executor: "personal", reviewer: "work" },
    worktree: { path: "/wt", branch: "run/fix-7", base: "/work/app" }, tabs: { executor: "fix-7 · build", reviewer: "fix-7 · review" }, ready: { executor: false, reviewer: false }, stuck: true, at: Date.now() };
  fake.terminals = [{ address: "t1", cwd: "/wt" }]; fake.panes = [{ pane: "p1", terminal: "t1", tab: "tb1" }]; fake.spaces = [{ id: "s", tabs: [{ id: "tb1", name: "fix-7 · build" }] }];
  const card = find(w.taskForm(theme(), cx), "workflow-launch-card");
  assert.match(text(card), /^Still starting · Fix #7 ✓? ?Worktree run\/fix-7 .*Writer Personal · waits on a question in its tab/);
  find(card, "workflow-launch-open").handlers.on_click({}, cx);
  assert.deepEqual(fake.runs.at(-1), ["agent.focus", { terminal: "t1" }]);
  find(card, "workflow-launch-wait").handlers.on_click({}, cx);
  assert.equal(w.launch.stage, "waiting");
  find(w.taskForm(theme(), cx), "workflow-launch-cancel").handlers.on_click({}, cx);
  await flush();
  assert.equal(w.launch, null);
  assert.ok(calls(/worktree remove \/wt/).length && calls(/branch -D run\/fix-7/).length, "its empty worktree and branch go");
  w.close();
});
