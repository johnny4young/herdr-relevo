import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetFake } from "./fake/herdr.mjs";
import { find, text, fakeCx, flush } from "./fake/ui.mjs";

const { checksOf, mineQuery, OTHERS_QUERY } = await import("../lib/github.js");
const { Inbox } = await import("../inbox.js");
beforeEach(resetFake);

const run = (name, status, conclusion = null) => ({ name, status, conclusion });
const rollup = (nodes, state = "FAILURE") => ({ commits: { nodes: [{ commit: { statusCheckRollup: { state, contexts: { pageInfo: { hasNextPage: false }, nodes } } } }] } });

test("the query asks each check's name and state, and how many files changed", () => {
  assert.match(mineQuery(), /CheckRun \{ name status conclusion \}/);
  assert.match(mineQuery(), /StatusContext \{ context state \}/);
  assert.match(mineQuery(), /changedFiles/);
  assert.match(OTHERS_QUERY, /changedFiles/);
});

test("each check reads as passed, failed, running or cancelled, in GitHub's order", () => {
  const pr = rollup([run("lint", "COMPLETED", "SUCCESS"), run("unit", "COMPLETED", "FAILURE"), run("e2e", "IN_PROGRESS"),
    run("deploy", "COMPLETED", "CANCELLED"), { context: "ci/legacy", state: "PENDING" }, run("docs", "COMPLETED", "SKIPPED")]);
  assert.deepEqual(checksOf(pr), [
    { name: "lint", state: "ok" }, { name: "unit", state: "bad" }, { name: "e2e", state: "run" },
    { name: "deploy", state: "wait" }, { name: "ci/legacy", state: "run" }, { name: "docs", state: "ok" },
  ]);
  assert.deepEqual(checksOf({}), []);
});

test("a selected PR names what failed and what passed, with its size and whether anyone reviewed it", async () => {
  const inbox = new Inbox(), cx = fakeCx();
  inbox.init({}, cx);
  await flush();
  const url = "https://github.com/acme/web/pull/142";
  const pr = { url, repo: "acme/web", number: 142, title: "test(ratelimit): pin the limiter", reasons: ["CI failing"], skills: [], threads: 0,
    updatedAt: new Date().toISOString(), createdAt: new Date(Date.now() - 86400e3).toISOString(), additions: 48, deletions: 6, changedFiles: 3,
    reviews: { nodes: [] }, ...rollup([run("unit", "COMPLETED", "FAILURE"), run("lint", "COMPLETED", "SUCCESS"), run("build", "COMPLETED", "SUCCESS")]) };
  const tree = inbox.prLines(inbox.constructor.prototype.theme ?? new Proxy({}, { get: (_t, n) => `#${String(n)}` }), pr);
  const wrap = { items: tree.filter(Boolean) };
  assert.equal(text(find(wrap, `ci-failed-${url}`)), "unit failed");
  assert.match(text(find(wrap, `ci-passed-${url}`)), /^lint, build passed/);
  assert.match(text(find(wrap, `size-${url}`)), /^3 files \+48 −6 nobody reviewed it yet opened 24h ago$/);
});
