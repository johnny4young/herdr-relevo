// Regression tests for P0 stability, edge-case, concurrency and security fixes.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { fake, resetFake, calls } from "./fake/herdr.mjs";
import { fakeCx, find, text, flush } from "./fake/ui.mjs";
import { prMoves } from "../lib/land.js";
import { ciOf, joinPRs, mapReady, prChanges } from "../lib/github.js";
import { parseIndex } from "../lib/sessions.js";
import { AWK, CLAUDE_SCAN, CODEX_SCAN, parseScan } from "../lib/usage-scan.js";
import { acquireOwned, releaseOwned } from "../runtime/store.mjs";
import { prepareReview, removeRunWorktree } from "../runtime/worktree.mjs";

const { Inbox } = await import("../inbox.js");
const { LANDING } = await import("../inbox-land.js");
const { Handoff } = await import("../handoff.js");
const { AccountStatus } = await import("../account-status.js");
const { ACCOUNTS, API_QUOTAS, CLI_FOUND, CODEX, resumeArgv } = await import("../accounts.js");
const { deepReviewers, startDeepReview } = await import("../deep-review.js");
const { agentTimeBetween } = await import("../ledger.js");
const { deleteLocalBranch, nestedRepo } = await import("../worktrees.js");
const { openUrl } = await import("../ui.js");

const pr = (over = {}) => ({
  number: 1, title: "Fix", url: "https://github.com/me/app/pull/1", isDraft: false,
  updatedAt: new Date().toISOString(), reviewDecision: "APPROVED",
  headRefName: "feat", baseRefName: "main", isCrossRepository: false, headRefOid: "a".repeat(40),
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", autoMergeRequest: null,
  repository: { nameWithOwner: "me/app", viewerDefaultMergeMethod: "SQUASH", squashMergeAllowed: true, autoMergeAllowed: true },
  commits: { nodes: [{ commit: { committedDate: new Date().toISOString(), statusCheckRollup: { state: "SUCCESS", contexts: { pageInfo: { hasNextPage: false }, nodes: [] } } } }] },
  reviews: { nodes: [] }, reviewThreads: { nodes: [] }, ...over,
});

beforeEach(resetFake);

test("prMoves blocks landing on failing/pending/cancelled CI, changes requested, open threads or conflicts even if CLEAN", () => {
  const withCI = (state) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] } });
  assert.equal(prMoves(pr()).land, true);
  assert.equal(prMoves(pr(withCI("FAILURE"))).land, false);
  assert.equal(prMoves(pr(withCI("ERROR"))).land, false);
  assert.equal(prMoves(pr(withCI("PENDING"))).land, false);
  assert.equal(prMoves(pr(withCI("CANCELLED"))).land, false);
  assert.equal(prMoves(pr({ reviewDecision: "CHANGES_REQUESTED" })).land, false);
  assert.equal(prMoves(pr({ reviewThreads: { nodes: [{ isResolved: false }] } })).land, false);
  assert.equal(prMoves(pr({ mergeable: "CONFLICTING" })).land, false);
  assert.equal(prMoves(pr({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })).land, true, "repos without CI can still land when CLEAN");
});

test("ciOf returns PENDING when a rerun check is still in progress rather than SUCCESS", () => {
  const runningRerun = pr({
    commits: {
      nodes: [{
        commit: {
          statusCheckRollup: {
            state: "FAILURE",
            contexts: {
              pageInfo: { hasNextPage: false },
              nodes: [
                { name: "lint", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-11-25T10:00:00Z" },
                { name: "lint", status: "IN_PROGRESS", conclusion: null, startedAt: "2026-11-25T10:05:00Z" },
                { name: "unit", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-25T10:00:00Z" },
              ],
            },
          },
        },
      }],
    },
  });
  assert.equal(ciOf(runningRerun), "PENDING");
});

test("mapReady excludes conflicting, dirty and behind PRs even when CI is green", () => {
  const data = {
    viewer: {
      pullRequests: {
        nodes: [
          pr({ url: "ok" }),
          pr({ url: "conflict", mergeable: "CONFLICTING" }),
          pr({ url: "dirty", mergeStateStatus: "DIRTY" }),
          pr({ url: "behind", mergeStateStatus: "BEHIND" }),
        ],
      },
    },
  };
  assert.deepEqual(mapReady(data).map((p) => p.url), ["ok"]);
});

test("prChanges alerts again when a new commit fails CI after an earlier failure", () => {
  const fail = (head) => ({
    viewer: {
      pullRequests: {
        nodes: [pr({ headRefOid: head, commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } })],
      },
    },
  });
  const first = prChanges(null, fail("1".repeat(40)));
  assert.deepEqual(prChanges(first.state, fail("1".repeat(40))).events, []);
  const next = prChanges(first.state, fail("2".repeat(40)));
  assert.deepEqual(next.events.map((e) => e.kind), ["ci-failed"]);
});

test("joinPRs flags truncated results when any query page reports hasNextPage", () => {
  const page = { viewer: { pullRequests: { pageInfo: { hasNextPage: true }, nodes: [] } } };
  assert.equal(joinPRs([page], {}).truncated, true);
  assert.equal(joinPRs([{ viewer: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] } } }], { search: { pageInfo: { hasNextPage: true }, nodes: [] } }).truncated, true);
  assert.equal(joinPRs([{ viewer: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] } } }], {}).truncated, false);
});

test("inbox-land handles malformed JSON and merges without a mergeCommit without looping on undefined", async () => {
  const box = new Inbox(), cx = fakeCx();
  box.init({}, cx);
  await flush();
  const url = "https://github.com/me/app/pull/5";
  fake.stored[LANDING] = { [url]: { repo: "me/app", number: 5, title: "Rebase", branch: "feat", oid: "a".repeat(40), clone: null, phase: "merging", at: Math.round(Date.now() / 1000) } };
  fake.exec = () => ({ code: 0, stdout: "{truncated" });
  await box.landTick(cx);
  assert.equal(fake.stored[LANDING][url].phase, "merging");

  fake.exec = (cmd, args) => (cmd === "gh" && args[1] === "view"
    ? { code: 0, stdout: JSON.stringify({ state: "MERGED", mergeCommit: null, mergedAt: new Date().toISOString() }) }
    : { code: 0, stdout: JSON.stringify({ data: { viewer: { login: "me", merged: { nodes: [] }, pullRequests: { nodes: [] } }, search: { nodes: [] } } }) });
  await box.landTick(cx);
  assert.equal(fake.stored[LANDING][url].phase, "landed");
  assert.equal(calls(/run list.*undefined/).length, 0);
});

test("addressed marks survive for quiet open PRs across scans, and deep review rejects fork PRs", async () => {
  const quiet = pr({ url: "https://github.com/me/app/pull/9", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", commits: { nodes: [{ commit: { committedDate: "2026-01-01T00:00:00Z", statusCheckRollup: { state: "PENDING" } } }] } });
  fake.exec = (cmd) => (cmd === "gh"
    ? { code: 0, stdout: JSON.stringify({ data: { viewer: { login: "me", merged: { nodes: [] }, pullRequests: { nodes: [quiet] } }, search: { nodes: [] } } }) }
    : null);
  const box = new Inbox(), cx = fakeCx();
  box.init({}, cx);
  await flush();
  box.addressed = { [quiet.url]: Date.now() / 1000 };
  await box.loadPRs();
  assert.ok(quiet.url in box.addressed, "still-open quiet PR keeps its addressed mark");

  await assert.rejects(startDeepReview(pr({ isCrossRepository: true, untrusted: true }), "/work/app", cx), /fork pull requests/);
});

test("Handoff never renders literal 'null' keycaps, closes on Escape, and reports when every other account is full", () => {
  fake.props = { terminal: "t1", space: "sp1", tab: "work", cwd: "/work/app", from: ACCOUNTS[0].key, overlay: "ov-h" };
  const view = new Handoff(), cx = fakeCx();
  view.quotas = null;
  assert.doesNotMatch(text(view.render()), /\bnull\b/);

  view.quotas = Object.fromEntries([...ACCOUNTS, CODEX].map((a) => [a.key, { h5: { pct: 100 } }]));
  assert.equal(text(find(view.render(), "handoff-title")), "Every other account is full");

  view.key({ key: "escape", modifiers: {} }, cx);
  assert.deepEqual(fake.closedOverlays, ["ov-h"]);
});

test("AccountStatus reflects dynamic CLI_FOUND updates, surfaces quota errors, and closes on Escape", () => {
  fake.stored[CLI_FOUND] = { claude: true, codex: false };
  fake.stored[API_QUOTAS] = { [ACCOUNTS[0].key]: { error: "token expired" } };
  fake.props = { overlay: "ov-as" };
  const view = new AccountStatus(), cx = fakeCx();
  view.detail = true;
  view.quota = {};
  const tree = view.render();
  assert.equal(find(tree, `account-status-card-${CODEX.key}`), null);
  assert.equal(text(find(tree, `account-status-${ACCOUNTS[0].key}-unknown`)), "Usage unavailable · token expired");

  view.key({ key: "escape", modifiers: {} }, cx);
  assert.deepEqual(fake.closedOverlays, ["ov-as"]);
  delete fake.stored[CLI_FOUND];
});

test("deepReviewers returns empty when all Claude accounts are 100% full", () => {
  const full = Object.fromEntries(ACCOUNTS.map((a) => [a.key, { h5: { pct: 100 } }]));
  assert.deepEqual(deepReviewers("me/app", full, [{ account: "repo", model: "opus", effort: "high" }]), []);
});

test("ledger reads across rotated ledger.old.jsonl when ledger.jsonl starts after since", async () => {
  const midnight = new Date().setHours(0, 0, 0, 0) / 1000;
  const line = (repo, a, b) => JSON.stringify({ start: midnight + a, end: midnight + b, repo, jira: null });
  fake.files["/home/test/.local/state/relevo/ledger.old.jsonl"] = line("app", 60, 660);
  fake.files["/home/test/.local/state/relevo/ledger.jsonl"] = line("app", 700, 1000);
  assert.equal(await agentTimeBetween(midnight, midnight + 3600), 900);
});

test("CLAUDE_SCAN and CODEX_SCAN handle pipes in paths and refuse shell arithmetic injection", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relevo-pipe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, "pwned");
  const file = path.join(dir, "a|b.jsonl");
  const msg = `${JSON.stringify({
    type: "assistant", timestamp: new Date().toISOString(), entrypoint: "cli", cwd: "/w/app", sessionId: "s1", requestId: "r1",
    message: { id: "msg_00000000000001", model: "claude-x", usage: { input_tokens: 1, cache_creation_input_tokens: 50, cache_read_input_tokens: 0, output_tokens: 5 } },
  })}\n`;
  fs.writeFileSync(file, msg);
  const parsed = parseScan(execFileSync("sh", ["-c", CLAUDE_SCAN, "sh", AWK, `${file}|0|${msg.length}|`]).toString());
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].msgs[0].write, 50);

  // Non-numeric start/end must be skipped rather than evaluated by $((...)).
  const evil = `${file}|a[$(touch ${marker})]|10|`;
  execFileSync("sh", ["-c", CLAUDE_SCAN, "sh", AWK, evil]);
  execFileSync("sh", ["-c", CODEX_SCAN, "sh", `${file}|a[$(touch ${marker})]|10`]);
  assert.equal(fs.existsSync(marker), false);
});

test("parseIndex rejects path-traversal and flag session ids, and resumeArgv enforces UUIDs", () => {
  const valid = "11111111-2222-3333-4444-555555555555";
  const out = parseIndex([
    `p\t500\t/app\t../../etc/passwd`,
    `p\t400\t/app\t--exec=evil`,
    `p\t300\t/app\t*`,
    `p\t200\t/app\t${valid}`,
  ].join("\n"));
  assert.deepEqual(out.map((r) => r.id), [valid]);
  assert.throws(() => resumeArgv(ACCOUNTS[0].key, "--evil"), /Invalid session id/);
  assert.ok(resumeArgv(ACCOUNTS[0].key, valid).includes(valid));
});

test("deleteLocalBranch rejects flag-like names and openUrl allows only https URLs", async () => {
  const bad = await deleteLocalBranch("/r/app", "-D");
  assert.equal(bad.code, 1);
  assert.equal(calls(/branch/).length, 0);

  openUrl("file:///etc/passwd");
  openUrl("javascript:alert(1)");
  openUrl("-a");
  assert.equal(calls(/^open /).length, 0);
  openUrl("https://github.com/me/app/pull/1");
  assert.deepEqual(calls(/^open /), ["open https://github.com/me/app/pull/1"]);
});

test("nestedRepo detects a nested git repo inside an untracked folder with spaces", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relevo-nested-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" });
  git(root, "init", "-q");
  fs.writeFileSync(path.join(root, "a.txt"), "1\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  const sub = path.join(root, "my dir", "child repo");
  fs.mkdirSync(sub, { recursive: true });
  git(sub, "init", "-q");
  fake.exec = (cmd, args, opts) => {
    const r = spawnSync(cmd, args, { cwd: opts?.cwd, encoding: "utf8" });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  assert.equal(await nestedRepo({ path: root }, []), "my dir/child repo");
});

test("acquireOwned never removes a successor's reclaimed guard directory", (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relevo-lock-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const errors = { guard: "busy", unsafe: "unsafe", incomplete: "incomplete", held: "held" };
  const first = acquireOwned(dir, "engine", { pid: process.pid, reclaimAbandoned: true, errors });
  assert.equal(fs.existsSync(path.join(dir, "engine.acquire")), false);
  releaseOwned(first);
});

test("prepareReview skips .worktreeinclude for untrusted PRs and removeRunWorktree cleans pruned empty runs", async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relevo-wt-p0-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const origin = path.join(base, "origin"), home = path.join(base, "home"), root = path.join(base, "app");
  fs.mkdirSync(origin); fs.mkdirSync(home);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { encoding: "utf8" }).trim();
  git(origin, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(origin, ".gitignore"), ".env\n");
  fs.writeFileSync(path.join(origin, ".worktreeinclude"), ".env\n");
  git(origin, "add", "."); git(origin, "commit", "-qm", "init");
  const head = git(origin, "rev-parse", "HEAD");
  git(origin, "update-ref", "refs/pull/9/head", head);
  execFileSync("git", ["clone", "-q", origin, root]);
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n");

  const tree = await prepareReview({ root, pr: { number: 9, head, base: "main", untrusted: true }, who: "first", home });
  assert.equal(fs.existsSync(path.join(tree.path, ".env")), false, "fork PR review must not receive .env");

  const wtPath = path.join(base, "gone-wt");
  git(root, "worktree", "add", "-b", "run/gone-123456", wtPath, head);
  fs.rmSync(wtPath, { recursive: true, force: true });
  const cleaned = await removeRunWorktree({ path: wtPath, base: root, branch: "run/gone-123456", baseCommit: head });
  assert.deepEqual(cleaned, { removed: false, branchDeleted: true });
  assert.notEqual(spawnSync("git", ["-C", root, "rev-parse", "--verify", "refs/heads/run/gone-123456"]).status, 0);
});

test("relevo-labels.sh rejects unsafe HC_TERMINAL_ID and ignores spoofed hook_event_name in tool_input", (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relevo-hook-p0-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const script = new URL("../hooks/relevo-labels.sh", import.meta.url).pathname;
  const env = (extra = {}) => ({ PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: home, ...extra });

  // Leading dash or quote in HC_TERMINAL_ID writes nothing.
  for (const bad of ["-rf", 't1","x', "t1 space"]) {
    const r = spawnSync("bash", [script], { env: env({ HC_TERMINAL_ID: bad }), input: JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash" }), encoding: "utf8" });
    assert.equal(r.status, 0);
  }
  assert.equal(fs.existsSync(path.join(home, ".local/state/relevo/asks")), false);

  // A PermissionRequest whose tool_input mentions SessionEnd is still treated as PermissionRequest, not SessionEnd.
  const r = spawnSync("bash", [script], {
    env: env({ HC_TERMINAL_ID: "t1" }),
    input: JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: '{"hook_event_name": "SessionEnd"}' } }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  const asksDir = path.join(home, ".local/state/relevo/asks/t1");
  assert.equal(fs.readdirSync(asksDir).length, 1);
});
