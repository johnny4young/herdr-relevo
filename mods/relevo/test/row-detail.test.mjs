import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetFake } from "./fake/herdr.mjs";
import { find, text, fakeCx, flush } from "./fake/ui.mjs";

const { checksOf, mapDrafts, mineQuery, othersQuery } = await import("../lib/github.js");
const { Inbox } = await import("../inbox.js");
beforeEach(resetFake);

const run = (name, status, conclusion = null) => ({ name, status, conclusion });
const rollup = (nodes, state = "FAILURE") => ({ commits: { nodes: [{ commit: { statusCheckRollup: { state, contexts: { pageInfo: { hasNextPage: false }, nodes } } } }] } });

test("the query asks each check's name and state, and how many files changed", () => {
  assert.match(mineQuery(), /CheckRun \{ name status conclusion startedAt \}/);
  assert.match(mineQuery(), /StatusContext \{ context state \}/);
  assert.match(mineQuery(), /changedFiles/);
  assert.match(othersQuery(), /changedFiles/);
});

test("each check reads as passed, failed, running or cancelled, in GitHub's order", () => {
  const pr = rollup([run("lint", "COMPLETED", "SUCCESS"), run("unit", "COMPLETED", "FAILURE"), run("e2e", "IN_PROGRESS"),
    run("deploy", "COMPLETED", "CANCELLED"), { context: "ci/legacy", state: "PENDING" }, run("docs", "COMPLETED", "SKIPPED")]);
  assert.deepEqual(checksOf(pr), [
    { name: "lint", state: "ok" }, { name: "unit", state: "bad" }, { name: "e2e", state: "run" },
    { name: "deploy", state: "cancel" }, { name: "ci/legacy", state: "run" }, { name: "docs", state: "ok" },
  ]);
  assert.deepEqual(checksOf({}), []);
});

test("checksOf keeps only the newest run of each check; one not started yet is the newest", () => {
  const at = (name, conclusion, startedAt) => ({ name, status: conclusion ? "COMPLETED" : "QUEUED", conclusion, startedAt });
  assert.deepEqual(checksOf(rollup([at("lint", "CANCELLED", "2026-11-22T05:10:00Z"), at("docs", "SKIPPED", "2026-11-22T05:10:01Z"), at("lint", "SUCCESS", "2026-11-22T05:10:06Z")])),
    [{ name: "docs", state: "ok" }, { name: "lint", state: "ok" }]);
  assert.deepEqual(checksOf(rollup([at("lint", "CANCELLED", "2026-11-22T05:10:00Z"), at("lint", null, null)])), [{ name: "lint", state: "run" }]);
});

test("a selected PR names what failed and what passed, with its size and whether anyone reviewed it", async () => {
  const inbox = new Inbox(), cx = fakeCx();
  inbox.init({}, cx);
  await flush();
  const url = "https://github.com/acme/web/pull/142";
  const pr = { url, repo: "acme/web", number: 142, title: "test(ratelimit): pin the limiter", reasons: ["CI failing"], skills: [], threads: 0,
    updatedAt: new Date().toISOString(), createdAt: new Date(Date.now() - 86400e3).toISOString(), additions: 48, deletions: 6, changedFiles: 3,
    reviewed: false, ...rollup([run("unit", "COMPLETED", "FAILURE"), run("lint", "COMPLETED", "SUCCESS"), run("build", "COMPLETED", "SUCCESS")]) };
  const tree = inbox.prLines(new Proxy({}, { get: (_t, n) => `#${String(n)}` }), pr);
  const wrap = { items: tree.filter(Boolean) };
  assert.equal(text(find(wrap, `ci-failed-${url}`)), "unit failed");
  assert.match(text(find(wrap, `ci-passed-${url}`)), /^lint, build passed/);
  assert.match(text(find(wrap, `size-${url}`)), /^3 files \+48 −6 nobody reviewed it yet opened 24h ago$/);
});

test("a stale check is not running, and a cut list keeps the rollup's word", () => {
  assert.deepEqual(checksOf(rollup([run("old", "COMPLETED", "STALE")])), [{ name: "old", state: "bad" }]);
  const inbox = new Inbox(), url = "https://github.com/acme/web/pull/7";
  const pr = { url, title: "t", threads: 0, ...rollup([run("lint", "COMPLETED", "SUCCESS")]) };
  pr.commits.nodes[0].commit.statusCheckRollup.contexts.pageInfo.hasNextPage = true;
  const wrap = { items: inbox.prLines(new Proxy({}, { get: (_t, n) => `#${String(n)}` }), pr).filter(Boolean) };
  assert.equal(text(find(wrap, `ci-${url}`)), "CI failing");
});

test("your own replies on your PR are not someone reviewing it", () => {
  const node = (login, state) => ({ author: { login }, state, submittedAt: new Date().toISOString() });
  const pr = (reviews) => ({ number: 1, title: "t", url: "u", isDraft: true, createdAt: "", updatedAt: "", repository: { nameWithOwner: "me/app" },
    commits: { nodes: [] }, reviews: { nodes: reviews }, reviewThreads: { nodes: [] } });
  const data = (reviews) => ({ viewer: { login: "me", pullRequests: { nodes: [pr(reviews)] } } });
  assert.equal(mapDrafts(data([node("me", "COMMENTED")]))[0].reviewed, false);
  assert.equal(mapDrafts(data([node("ana", "COMMENTED")]))[0].reviewed, true);
});
