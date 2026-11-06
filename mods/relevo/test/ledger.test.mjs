// Which project an agent's time goes to, with real git folders.
import "./fake/register.mjs";
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fake, resetFake, calls, theme } from "./fake/herdr.mjs";
import { find, text } from "./fake/ui.mjs";
import { repoOfGitDir, totals } from "../lib/ledger.js";

const { ledgerTick, today } = await import("../ledger.js");
const OPEN = "relevo.ledger.open";

function repos(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "relevo-ledger-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, "app"), tree = join(root, "app-ABC-1"), plain = join(root, "notes");
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "i"], { cwd: main });
  execFileSync("git", ["worktree", "add", "-q", "-b", "feat/ABC-1", tree], { cwd: main });
  mkdirSync(join(tree, "src"));
  mkdirSync(plain);
  fake.exec = (cmd, args, options) => {
    if (cmd !== "git") return null;
    const r = spawnSync(cmd, args, { cwd: options?.cwd, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: root } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return { main, tree, plain };
}

function working(...list) {
  fake.agents = list.map(([address], i) => ({ address, pane: `p${i}`, status: "working", space_name: "space" }));
  fake.panes = list.map(([, cwd, branch], i) => ({ pane: `p${i}`, cwd, branch: branch ?? null }));
  fake.terminals = list.map(([address]) => ({ address, labels: {} }));
}
const opened = () => fake.stored[OPEN];

beforeEach(resetFake);

test("a worktree's time goes to its repo", async (t) => {
  const { tree } = repos(t);
  working(["t1", tree, "review-pr-19"]);
  await ledgerTick();
  assert.equal(opened().t1.repo, "app");
});

test("so does a subfolder's, and the main checkout's", async (t) => {
  const { main, tree } = repos(t);
  working(["t1", join(tree, "src")], ["t2", main]);
  await ledgerTick();
  assert.equal(opened().t1.repo, "app");
  assert.equal(opened().t2.repo, "app");
});

test("a folder outside git keeps its name, and git can't change that by failing", async (t) => {
  const { plain } = repos(t);
  working(["t1", plain], ["t2", "/gone/away"], ["t3", null]);
  fake.agents[2].space_name = "from-space";
  await ledgerTick();
  assert.equal(opened().t1.repo, "notes");
  assert.equal(opened().t2.repo, "away");
  assert.equal(opened().t3.repo, "from-space");
});

test("a ticket stays the key, with the repo beside it", async (t) => {
  const { tree } = repos(t);
  working(["t1", tree, "feat/ABC-1"]);
  await ledgerTick();
  assert.equal(opened().t1.jira, "ABC-1");
  assert.equal(opened().t1.repo, "app");
});

test("work in a worktree and in the main checkout add up as one project, overlaps once", async (t) => {
  const { main, tree } = repos(t);
  working(["t1", main], ["t2", tree, "review-pr-19"]);
  await ledgerTick();
  fake.stored[OPEN].t1.start -= 600;
  fake.stored[OPEN].t2.start -= 300;
  const rows = await today();
  assert.deepEqual(rows.map((r) => r.key), ["app"]);
  assert.ok(rows[0].seconds > 590 && rows[0].seconds < 610, String(rows[0].seconds));
});

test("today shows projects only: a ticket's time joins its repo, overlaps once", async () => {
  const noon = new Date().setHours(12, 0, 0, 0);
  mock.timers.enable({ apis: ["Date"], now: noon });
  const line = (repo, jira, from, to) => JSON.stringify({ start: noon / 1000 - from, end: noon / 1000 - to, repo, jira });
  fake.files["/home/test/.local/state/relevo/ledger.jsonl"] = [line("app", "ABC-1", 1200, 600), line("app", null, 900, 300), line("other", "XYZ-9", 200, 80)].join("\n");
  const rows = await today();
  mock.timers.reset();
  assert.deepEqual(rows.map((r) => [r.key, r.jira, r.seconds]), [["app", null, 900], ["other", null, 120]]);
});

test("git is asked once per folder, and only when a stretch opens", async (t) => {
  const { tree } = repos(t);
  const folder = join(tree, "src");
  working(["t1", folder]);
  await ledgerTick();
  await ledgerTick();
  const asked = calls(/git-common-dir/).length;
  assert.equal(asked, 1);
  fake.stored[OPEN] = {};
  await ledgerTick();
  assert.equal(calls(/git-common-dir/).length, asked);
});

test("a closed stretch keeps the project it opened with", async (t) => {
  const { tree } = repos(t);
  working(["t1", tree]);
  await ledgerTick();
  working();
  await ledgerTick();
  const line = calls(/ledger\.jsonl/).at(-1);
  assert.equal(JSON.parse(line.slice(line.indexOf('{"start"'), line.lastIndexOf("}") + 1)).repo, "app");
  assert.deepEqual(opened(), {});
});

test("repoOfGitDir: a checkout, a bare repo and a trailing slash", () => {
  assert.equal(repoOfGitDir("/code/app/.git"), "app");
  assert.equal(repoOfGitDir("/code/app/.git/"), "app");
  assert.equal(repoOfGitDir("/code/app.git"), "app");
  assert.equal(repoOfGitDir("/code/super/.git/modules/lib"), "lib");
  assert.equal(repoOfGitDir(""), null);
});

test("totals still counts a ticket apart from its repo", () => {
  const rows = [{ start: 0, end: 120, jira: "ABC-1", repo: "app" }, { start: 0, end: 300, jira: null, repo: "app" }];
  assert.deepEqual(totals(rows, 0).map((r) => [r.key, r.repo, r.seconds]), [["app", "app", 300], ["ABC-1", "app", 120]]);
});

test("a row of today's time draws the project and its time, nothing else", async () => {
  const { Inbox } = await import("../inbox.js");
  const inbox = new Inbox();
  inbox.expanded = { today: true };
  const [, list] = inbox.todayGroup(theme(), [{ key: "app", repo: "app", jira: null, seconds: 7200 }]);
  assert.equal(text(find(list, "day-app")), "app 2h 00m");
});

test("past its limit the ledger keeps its newest half and moves the rest to ledger.old.jsonl", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { APPEND } = await import("../ledger.js");
  const dir = mkdtempSync(join(tmpdir(), "relevo-ledger-")), file = join(dir, "state", "ledger.jsonl");
  for (let i = 1; i <= 6; i++) execFileSync("sh", ["-c", APPEND, "sh", file, `{"n":${i}}`, "40"]);
  const kept = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l).n);
  const old = readFileSync(join(dir, "state", "ledger.old.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).n);
  assert.deepEqual([...old, ...kept], [1, 2, 3, 4, 5, 6]);
  assert.equal(kept.at(-1), 6);
  assert.ok(kept.length < 6);
});
