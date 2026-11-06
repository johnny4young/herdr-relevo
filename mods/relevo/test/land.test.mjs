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

let runs, view, head, remote;
beforeEach(() => {
  resetFake();
  runs = [{ name: "Deploy", status: "completed", conclusion: "success", url: "https://github.com/me/app/actions/runs/9" }];
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
  box.expanded["mine-ready"] = true;
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
  assert.equal(find(box.render(cx), `land-${URL}`), null);
  assert.match(text(find(box.render(cx), "landed")), /▸ 1 landed/);
  click(find(box.render(cx), "landed"), cx);
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
  assert.equal(fake.stored[LANDING], undefined);
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
