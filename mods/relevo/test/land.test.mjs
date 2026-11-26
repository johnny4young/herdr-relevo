// Land on the fake app: the two clicks, the merge, its workflows, and the cleanup that loses nothing.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake, calls } from "./fake/herdr.mjs";
import { fakeCx, find, text, click, flush } from "./fake/ui.mjs";
import { landLine, mergeFlag, prMoves, runsPhase } from "../lib/land.js";

const { Inbox } = await import("../inbox.js");
const { LANDING } = await import("../inbox-land.js");

const URL = "https://github.com/me/app/pull/1", MAIN = "/work/app", WT = "/work/.herdr/worktrees/app/feat", OID = "abc123";

const pr = (over = {}) => ({
  number: 1, title: "Fix", url: URL, isDraft: false, updatedAt: new Date().toISOString(), reviewDecision: "APPROVED",
  headRefName: "feat", baseRefName: "main", isCrossRepository: false, headRefOid: OID, additions: 1, deletions: 1,
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", autoMergeRequest: null,
  repository: { nameWithOwner: "me/app", viewerDefaultMergeMethod: "SQUASH", squashMergeAllowed: true, autoMergeAllowed: true },
  commits: { nodes: [{ commit: { committedDate: new Date().toISOString(), statusCheckRollup: { state: "SUCCESS", contexts: { pageInfo: { hasNextPage: false }, nodes: [] } } } }] },
  reviews: { nodes: [] }, reviewThreads: { nodes: [] }, ...over,
});

test("the merge method is the repo's default for you, else one it allows", () => {
  assert.equal(mergeFlag({ viewerDefaultMergeMethod: "MERGE", mergeCommitAllowed: true }), "--merge");
  assert.equal(mergeFlag({ viewerDefaultMergeMethod: "MERGE", mergeCommitAllowed: false, rebaseMergeAllowed: true }), "--rebase");
  assert.equal(mergeFlag(undefined), "--squash");
});

test("what a PR can do comes from GitHub's merge state", () => {
  assert.equal(prMoves(pr()).land, true);
  assert.deepEqual([prMoves(pr({ mergeStateStatus: "BLOCKED" })).land, prMoves(pr({ mergeStateStatus: "BLOCKED" })).auto], [false, true]);
  assert.equal(prMoves(pr({ mergeStateStatus: "BLOCKED", autoMergeRequest: { enabledAt: "x" } })).auto, false);
  assert.equal(prMoves(pr({ mergeStateStatus: "BEHIND" })).update, true);
  assert.equal(prMoves(pr({ mergeStateStatus: "UNKNOWN", mergeable: "UNKNOWN" })).land, true);
  assert.equal(prMoves(pr({ mergeStateStatus: "UNKNOWN", mergeable: "CONFLICTING" })).land, false);
  assert.equal(prMoves(pr({ isDraft: true })).land, false);
  const red = pr({ mergeStateStatus: "BLOCKED", commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } });
  assert.deepEqual([prMoves(red).auto, prMoves(red).rerun], [false, true]);
});

test("workflows after a merge: running, failed, or landed; none after a while is landed", () => {
  const run = (status, conclusion = null) => ({ name: "Deploy", status, conclusion, url: "https://x" });
  assert.equal(runsPhase([run("in_progress"), run("completed", "success")], 0, 10).phase, "ci");
  assert.equal(runsPhase([run("completed", "failure")], 0, 10).failed.name, "Deploy");
  assert.equal(runsPhase([run("completed", "success"), run("completed", "skipped")], 0, 10).phase, "landed");
  assert.equal(runsPhase([], 0, 10).phase, "ci");
  assert.equal(runsPhase([], 0, 1000).phase, "landed");
  assert.equal(landLine({ phase: "ci", running: 1, total: 3 }), "Merged · 1 of 3 workflows running");
});

test("a red run after the merge counts as the base branch's newer run of the same workflow", () => {
  const merge = { name: "CI", status: "completed", conclusion: "cancelled", headSha: "m1", createdAt: "2026-01-01T00:00:00Z" };
  const later = (status, conclusion = null, over = {}) => ({ name: "CI", status, conclusion, headSha: "n2", createdAt: "2026-01-01T00:00:10Z", ...over });
  assert.deepEqual([runsPhase([merge], 0, 10, [later("completed", "success")]).phase, runsPhase([merge], 0, 10, [later("completed", "success")]).moved], ["landed", ["CI"]]);
  assert.equal(runsPhase([merge], 0, 10, [later("in_progress")]).phase, "ci");
  assert.equal(runsPhase([merge], 0, 10, []).phase, "failed", "a cancel nothing replaced stays red");
  assert.equal(runsPhase([merge], 0, 10, [later("completed", "failure")]).phase, "failed");
  assert.equal(runsPhase([merge], 0, 10, [later("completed", "success", { name: "Deploy" })]).phase, "failed");
  assert.equal(runsPhase([merge], 0, 10, [later("completed", "success", { createdAt: "2025-12-31T00:00:00Z" })]).phase, "failed");
});

let runs, branchRuns, view, head, remote;
beforeEach(() => {
  resetFake();
  runs = [{ name: "Deploy", status: "completed", conclusion: "success", url: "https://github.com/me/app/actions/runs/9" }];
  branchRuns = [];
  view = { state: "MERGED", mergeCommit: { oid: "merge1" }, mergedAt: new Date().toISOString() };
  head = OID;
  remote = OID;
  fake.exec = (cmd, args) => {
    const line = args.join(" ");
    if (cmd === "gh" && args[0] === "api") {
      return { stdout: JSON.stringify({ data: { viewer: { login: "me", merged: { nodes: [] }, pullRequests: { nodes: [pr()] } }, search: { nodes: [] } } }) };
    }
    if (cmd === "gh" && line.startsWith("pr view") && line.includes("headRefOid,state")) return { stdout: JSON.stringify({ headRefOid: remote, state: "OPEN" }) };
    if (cmd === "gh" && line.startsWith("pr view")) return { stdout: JSON.stringify(view) };
    if (cmd === "gh" && line.startsWith("run list") && line.includes("--branch main")) return { stdout: JSON.stringify(branchRuns) };
    if (cmd === "gh" && line.startsWith("run list")) return { stdout: JSON.stringify(runs) };
    if (cmd === "sh" && line.includes("worktree list --porcelain")) {
      return { stdout: [`worktree ${MAIN}`, "branch refs/heads/main", "", `worktree ${WT}`, "branch refs/heads/feat", ""].map((l) => `${MAIN}\t${l}`).join("\n") };
    }
    if (cmd === "sh" && line.includes("absolute-git-dir")) return { stdout: `${WT}\t1\n` };
    if (cmd === "git" && line.includes("worktree list")) return { stdout: `worktree ${WT}\nHEAD ${OID}\n\n` };
    if (cmd === "git" && line.endsWith("rev-parse HEAD")) return { stdout: `${head}\n` };
    if (cmd === "git" && line.includes("rev-parse refs/heads/feat")) return { stdout: `${OID}\n` };
    return null;
  };
});

async function inbox() {
  const box = new Inbox(), cx = fakeCx();
  box.init({}, cx);
  await flush();
  box.clones["me/app"] = MAIN;
  return { box, cx };
}

test("Land asks for a second click, then merges the commit the card showed", async () => {
  const { box, cx } = await inbox();
  click(find(box.render(cx), `land-btn-${URL}`), cx);
  await flush();
  assert.equal(calls(/^gh pr merge/).length, 0);
  assert.match(text(find(box.render(cx), `land-btn-${URL}`)), /Confirm land/);
  click(find(box.render(cx), `land-btn-${URL}`), cx);
  await flush();
  assert.deepEqual(calls(/^gh pr merge/), [`gh pr merge 1 --repo me/app --squash --match-head-commit ${OID}`]);
});

test("a landed PR whose worktree holds only the merged commit loses its worktree and branch", async () => {
  const { box, cx } = await inbox();
  click(find(box.render(cx), `land-btn-${URL}`), cx);
  click(find(box.render(cx), `land-btn-${URL}`), cx);
  await flush();
  await box.landTick(cx);
  await flush();
  const entry = fake.stored[LANDING][URL];
  assert.deepEqual([entry.phase, entry.note], ["landed", "worktree removed"]);
  assert.equal(calls(new RegExp(`^git -C ${MAIN} worktree remove ${WT}$`)).length, 1);
  assert.equal(calls(/branch -D feat/).length, 1);
  assert.match(text(find(box.render(cx), `land-${URL}`)), /Landed/, "Now shows it landed for a minute");
  fake.stored[LANDING] = { [URL]: { ...entry, done: entry.done - 120 } };
  assert.equal(find(box.render(cx), `land-${URL}`), null);
  click(find(box.render(cx), "view-maintenance"), cx);
  assert.match(text(find(box.render(cx), "maintenance-done")), /^1 marked addressed or landed/);
  click(find(box.render(cx), "maintenance-done"), cx);
  assert.match(text(find(box.render(cx), `land-${URL}`)), /Landed · worktree removed/);
});

test("a worktree with commits the PR doesn't have stays", async () => {
  head = "local999";
  const { box, cx } = await inbox();
  click(find(box.render(cx), `land-btn-${URL}`), cx);
  click(find(box.render(cx), `land-btn-${URL}`), cx);
  await flush();
  await box.landTick(cx);
  await flush();
  assert.equal(fake.stored[LANDING][URL].note, "kept its worktree: it has commits the PR doesn't");
  assert.equal(calls(/worktree remove/).length, 0);
});

test("a workflow failing after the merge says so and keeps the worktree", async () => {
  runs = [{ name: "Deploy", status: "completed", conclusion: "failure", url: "https://github.com/me/app/actions/runs/9" }];
  const { box, cx } = await inbox();
  click(find(box.render(cx), `land-btn-${URL}`), cx);
  click(find(box.render(cx), `land-btn-${URL}`), cx);
  await flush();
  await box.landTick(cx);
  await flush();
  assert.equal(fake.stored[LANDING][URL].phase, "failed");
  assert.equal(fake.notices.at(-1).title, "Deploy failed · app #1");
  assert.equal(calls(/worktree remove/).length, 0);
  assert.ok(find(box.render(cx), `land-run-${URL}`));
});

test("a merge GitHub refuses says why and starts nothing", async () => {
  const base = fake.exec;
  fake.exec = (cmd, args) => (cmd === "gh" && args[1] === "merge" ? { code: 1, stderr: "Pull request is not mergeable\n" } : base(cmd, args));
  const { box, cx } = await inbox();
  click(find(box.render(cx), `land-btn-${URL}`), cx);
  click(find(box.render(cx), `land-btn-${URL}`), cx);
  await flush();
  assert.equal(fake.notices.at(-1).body, "Pull request is not mergeable");
  assert.equal(fake.stored[LANDING]?.[URL], undefined, "the landing it showed while checking goes");
  assert.ok(find(box.render(cx), `land-btn-${URL}`), "and Land is back");
});

test("a PR with commits newer than its card isn't merged; the card is read again", async () => {
  remote = "newer456";
  const { box, cx } = await inbox();
  click(find(box.render(cx), `land-btn-${URL}`), cx);
  click(find(box.render(cx), `land-btn-${URL}`), cx);
  await flush();
  assert.equal(calls(/^gh pr merge/).length, 0);
  assert.equal(fake.notices.at(-1).title, "app #1 has new commits");
  assert.ok(calls(/^gh api graphql[\s\S]*review-requested/).length >= 2);
});

test("a PR scan that never answered doesn't block the next one for good", async () => {
  const { box, cx } = await inbox();
  const scans = () => calls(/^gh api graphql[\s\S]*review-requested/).length;
  const before = scans();
  box.scanningPRs = true;
  box.scanStarted = Date.now();
  box.scanPRs(cx);
  await flush();
  assert.equal(scans(), before);
  box.scanStarted = Date.now() - 200000;
  box.scanPRs(cx);
  await flush();
  assert.equal(scans(), before + 1);
});

test("Confirm land turns the card into a landing at once, and the PR's own card goes", async () => {
  let answer;
  const base = fake.exec;
  fake.exec = (cmd, args) => (cmd === "gh" && args[1] === "view" && args.includes("headRefOid,state") ? new Promise((r) => { answer = () => r(base(cmd, args)); }) : base(cmd, args));
  const { box, cx } = await inbox();
  click(find(box.render(cx), `land-btn-${URL}`), cx);
  click(find(box.render(cx), `land-btn-${URL}`), cx);
  assert.match(text(find(box.render(cx), `land-${URL}`)), /Landing…/, "before GitHub answers");
  assert.equal(find(box.render(cx), `pr-${URL}`), null);
  await flush();
  answer();
  await flush();
  await flush();
  assert.ok(fake.notices.some((n) => /^Merged · app #1/.test(n.title)));
});

test("a landed worktree's space closes and its programs stop before the folder goes", async () => {
  fake.spaces = [{ id: "sp9", name: "feat", folder: WT, machine: "", tabs: [{ id: "tb9", name: "dev" }] }];
  fake.panes = [{ pane: "p9", tab: "tb9", terminal: "t9", cwd: WT, status: "idle", program: { agent: false } }];
  const { box, cx } = await inbox();
  click(find(box.render(cx), `land-btn-${URL}`), cx);
  click(find(box.render(cx), `land-btn-${URL}`), cx);
  await flush();
  // The dev server is still stopping: nothing is removed.
  await box.landTick(cx);
  await flush();
  assert.equal(fake.runs.filter(([name]) => name === "space.close").length, 1);
  assert.equal(fake.stored[LANDING][URL].note, "kept its worktree: its programs are still stopping");
  assert.equal(calls(/worktree remove/).length, 0);
});

test("once its programs stop, a landed worktree goes", async () => {
  fake.spaces = [{ id: "sp9", name: "feat", folder: WT, machine: "", tabs: [{ id: "tb9", name: "dev" }] }];
  fake.panes = [{ pane: "p9", tab: "tb9", terminal: "t9", cwd: WT, status: "idle", program: { agent: false } }];
  const { box, cx } = await inbox();
  cx.sleep = async () => { fake.panes = []; };
  click(find(box.render(cx), `land-btn-${URL}`), cx);
  click(find(box.render(cx), `land-btn-${URL}`), cx);
  await flush();
  await box.landTick(cx);
  await flush();
  assert.equal(fake.stored[LANDING][URL].note, "worktree removed");
  assert.equal(calls(/worktree remove/).length, 1);
});

async function landed() {
  const { box, cx } = await inbox();
  click(find(box.render(cx), `land-btn-${URL}`), cx);
  click(find(box.render(cx), `land-btn-${URL}`), cx);
  await flush();
  await box.landTick(cx);
  await flush();
  return { box, cx };
}

test("a merge run a newer push cancelled lands once that push's run passes", async () => {
  runs = [{ name: "CI", status: "completed", conclusion: "cancelled", headSha: "merge1", createdAt: "2026-01-01T00:00:00Z", url: "https://x/1" }];
  branchRuns = [{ name: "CI", status: "completed", conclusion: "success", headSha: "next2", createdAt: "2026-01-01T00:00:10Z", url: "https://x/2" }];
  await landed();
  const entry = fake.stored[LANDING][URL];
  assert.deepEqual([entry.phase, entry.note], ["landed", "CI passed on a newer commit · worktree removed"]);
});

test("a failed landing is read again, and a rerun that passes lands it", async () => {
  runs = [{ name: "CI", status: "completed", conclusion: "failure", url: "https://x/1" }];
  const { box, cx } = await landed();
  assert.equal(fake.stored[LANDING][URL].phase, "failed");
  const warned = fake.notices.length;
  await box.landTick(cx);
  assert.equal(calls(/^gh run list/).filter((c) => c.includes("--commit")).length, 1, "not before two minutes");
  box.landAsked[URL] = 0;
  await box.landTick(cx);
  await flush();
  assert.equal(fake.stored[LANDING][URL].phase, "failed");
  assert.equal(fake.notices.length, warned, "still red: no second warning");
  runs = [{ name: "CI", status: "completed", conclusion: "success", url: "https://x/1" }];
  box.landAsked[URL] = 0;
  await box.landTick(cx);
  await flush();
  assert.equal(fake.stored[LANDING][URL].phase, "landed");
  assert.equal(fake.notices.at(-1).title, "Landed · app #1");
});

test("a landing saved without its base branch asks GitHub for it", async () => {
  runs = [{ name: "CI", status: "completed", conclusion: "cancelled", headSha: "merge1", createdAt: "2026-01-01T00:00:00Z", url: "https://x/1" }];
  branchRuns = [{ name: "CI", status: "completed", conclusion: "success", headSha: "next2", createdAt: "2026-01-01T00:00:10Z", url: "https://x/2" }];
  view = { ...view, baseRefName: "main" };
  const { box, cx } = await inbox();
  fake.stored[LANDING] = { [URL]: { repo: "me/app", number: 1, title: "Fix", phase: "failed", sha: "merge1", mergedAt: 0, done: Math.round(Date.now() / 1000) } };
  await box.landTick(cx);
  await flush();
  assert.deepEqual([fake.stored[LANDING][URL].phase, fake.stored[LANDING][URL].base], ["landed", "main"]);
});
