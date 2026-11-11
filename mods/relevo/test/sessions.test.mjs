// The session finder on a fake app: which sessions it offers, the keyboard, and how one resumes.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fake, resetFake } from "./fake/herdr.mjs";
import { fakeCx, find, text, flush } from "./fake/ui.mjs";

const { SessionFinder } = await import("../sessions.js");
const { ACCOUNTS } = await import("../accounts.js");
const id = (n) => `0000000${n}-0000-4000-8000-000000000000`;
const ACCT = ACCOUNTS[0].key;

beforeEach(() => {
  resetFake();
  fake.props = { top: "/r/app", overlay: "o1" };
  fake.terminals = [{ address: "t9", labels: { "agent.transcript": `/home/test/.claude/projects/x/${id(5)}.jsonl` } }];
  const index = [[1, 500, "/r/app"], [2, 400, "/home/test/.herdr/worktrees/app/feat"], [3, 300, "/r/other"], [4, 200, "/r/app"],
    [5, 600, "/r/app"]].map(([n, at, p]) => `${ACCT}\t${at}\t${p}\t${id(n)}`).join("\n");
  const details = [`${ACCT}/${id(1)}\t"file":true`, `${ACCT}/${id(1)}\t"customTitle":"Fix the CI"`, `${ACCT}/${id(2)}\t"file":true`,
    `${ACCT}/${id(2)}\t"lastPrompt":"trim the silence"`, `${ACCT}/${id(2)}\t"gitBranch":"feat"`, `${ACCT}/${id(3)}\t"file":true`, `${ACCT}/${id(5)}\t"file":true`].join("\n");
  fake.exec = (cmd, args) => {
    if (cmd !== "sh") return null;
    if (args[1].includes("sessionId")) return { stdout: index };
    if (args[1].includes("customTitle")) return { stdout: details };
    return { stdout: "" };
  };
});

async function finder() {
  const view = new SessionFinder(), cx = fakeCx();
  view.init({}, cx);
  await flush();
  return { view, cx, ui: () => view.render(cx), press: (key, more = {}) => view.key({ key, modifiers: {}, ...more }, cx) };
}

test("this repo's sessions, its worktrees' too, never one running or one whose transcript is gone", async () => {
  const { ui } = await finder();
  const shown = text(ui());
  assert.match(shown, /Fix the CI/);
  assert.match(shown, /trim the silence/);
  assert.ok(!find(ui(), `session-${ACCT}-${id(3)}`), "another repo");
  assert.ok(!find(ui(), `session-${ACCT}-${id(4)}`), "no transcript");
  assert.ok(!find(ui(), `session-${ACCT}-${id(5)}`), "running now");
});

test("typing filters, Enter resumes it in its folder with its account, Tab shows every repo", async () => {
  const { view, ui, press } = await finder();
  for (const c of "trim") press(c, { key_char: c });
  assert.deepEqual(view.rows().map((r) => r.id), [id(2)]);
  press("enter");
  const [name, args] = fake.runs.at(-1);
  assert.equal(name, "space.new");
  assert.equal(args.folder, "/home/test/.herdr/worktrees/app/feat");
  assert.equal(args.argv.at(-1), id(2));
  assert.match(args.argv[2], /--resume "\$1"$/);
  for (let i = 0; i < 4; i++) press("backspace");
  press("tab");
  await flush();
  assert.ok(find(ui(), `session-${ACCT}-${id(3)}`));
});

test("sessions copied between accounts keep their own title, branch and PR", async () => {
  fake.terminals = [];
  const other = ACCOUNTS[1].key;
  const index = [
    `${ACCT}\t200\t/r/app\t${id(1)}`,
    `${other}\t100\t/r/app\t${id(1)}`,
  ].join("\n");
  const details = [
    `${ACCT}/${id(1)}\t"file":true`, `${ACCT}/${id(1)}\t"customTitle":"Personal fix"`,
    `${ACCT}/${id(1)}\t"gitBranch":"personal-fix"`, `${ACCT}/${id(1)}\t"prNumber":11`,
    `${other}/${id(1)}\t"file":true`, `${other}/${id(1)}\t"customTitle":"Work fix"`,
    `${other}/${id(1)}\t"gitBranch":"work-fix"`, `${other}/${id(1)}\t"prNumber":22`,
  ].join("\n");
  fake.exec = (_cmd, args) => ({ stdout: args[1].includes("sessionId") ? index : args[1].includes("customTitle") ? details : "" });

  const { view } = await finder();

  assert.deepEqual(view.rows().map((r) => [r.account, r.title, r.branch, r.pr]), [
    [ACCT, "Personal fix", "personal-fix", 11], [other, "Work fix", "work-fix", 22],
  ]);
});

test("a missing transcript in one account never borrows another account copy", async () => {
  fake.terminals = [];
  const other = ACCOUNTS[1].key;
  const index = `${ACCT}\t200\t/r/app\t${id(1)}\n${other}\t100\t/r/app\t${id(1)}`;
  const details = `${ACCT}/${id(1)}\t"file":true\n${ACCT}/${id(1)}\t"customTitle":"Available copy"`;
  fake.exec = (_cmd, args) => ({ stdout: args[1].includes("sessionId") ? index : args[1].includes("customTitle") ? details : "" });

  const { view } = await finder();

  assert.deepEqual(view.rows().map((r) => r.account), [ACCT]);
});

test("a running session only hides the copy in its own account", async () => {
  const other = ACCOUNTS[1].key;
  const index = `${ACCT}\t200\t/r/app\t${id(5)}\n${other}\t100\t/r/app\t${id(5)}`;
  const details = [`${ACCT}/${id(5)}\t"file":true`, `${ACCT}/${id(5)}\t"customTitle":"Active copy"`,
    `${other}/${id(5)}\t"file":true`, `${other}/${id(5)}\t"customTitle":"Resting copy"`].join("\n");
  fake.exec = (_cmd, args) => ({ stdout: args[1].includes("sessionId") ? index : args[1].includes("customTitle") ? details : "" });

  const { view, press } = await finder();
  press("enter");

  assert.deepEqual(view.rows().map((r) => [r.account, r.title]), [[other, "Resting copy"]]);
  assert.equal(fake.runs.at(-1)[1].argv[2], `${ACCOUNTS[1].launcher} --resume "$1"`);
});

test("the session detail shell keeps account copies separate, with spaces and pipes in their paths", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relevo sessions | "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "app");
  mkdirSync(project);
  fake.props = { top: project, overlay: "o1" };
  fake.terminals = [];
  const first = ACCOUNTS[0], second = ACCOUNTS[1];
  const seed = (account, timestamp, title, branch, prNumber) => {
    const config = join(root, account.claudeDir), folder = join(config, "projects", "synthetic");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(config, "history.jsonl"), JSON.stringify({ timestamp, project, sessionId: id(1) }) + "\n");
    writeFileSync(join(folder, `${id(1)}.jsonl`), JSON.stringify({ customTitle: title, gitBranch: branch, prNumber }) + "\n");
  };
  seed(first, 200, "First copy", "first-branch", 11);
  seed(second, 100, "Second copy", "second-branch", 22);
  fake.exec = (cmd, args) => ({ stdout: execFileSync(cmd, args.map((a) => a.replaceAll("/home/test/", `${root}/`)), { encoding: "utf8" }) });

  const { view } = await finder();

  assert.deepEqual(view.rows().map((r) => [r.account, r.title, r.branch, r.pr]), [
    [first.key, "First copy", "first-branch", 11], [second.key, "Second copy", "second-branch", 22],
  ]);
});

test("an account directory with a trailing slash still hides its running session", async (t) => {
  const original = ACCOUNTS[0].claudeDir;
  t.after(() => { ACCOUNTS[0].claudeDir = original; });
  ACCOUNTS[0].claudeDir = original + "/";
  const other = ACCOUNTS[1].key;
  const index = `${ACCT}\t200\t/r/app\t${id(5)}\n${other}\t100\t/r/app\t${id(5)}`;
  const details = `${ACCT}/${id(5)}\t"file":true\n${other}/${id(5)}\t"file":true`;
  fake.exec = (_cmd, args) => ({ stdout: args[1].includes("sessionId") ? index : args[1].includes("customTitle") ? details : "" });

  const { view } = await finder();

  assert.deepEqual(view.rows().map((r) => [r.account, r.id]), [[other, id(5)]]);
});

test("accounts that share a config dir all hide its running session", async (t) => {
  const original = ACCOUNTS[1].claudeDir;
  t.after(() => { ACCOUNTS[1].claudeDir = original; });
  ACCOUNTS[1].claudeDir = ACCOUNTS[0].claudeDir;
  const index = `${ACCT}\t200\t/r/app\t${id(5)}\n${ACCOUNTS[1].key}\t100\t/r/app\t${id(5)}`;
  const details = `${ACCT}/${id(5)}\t"file":true\n${ACCOUNTS[1].key}/${id(5)}\t"file":true`;
  fake.exec = (_cmd, args) => ({ stdout: args[1].includes("sessionId") ? index : args[1].includes("customTitle") ? details : "" });

  const { view } = await finder();

  assert.deepEqual(view.rows(), []);
});

test("a running transcript outside the configured roots is never offered for resume", async () => {
  fake.terminals = [{ address: "t9", labels: { "agent.transcript": `/external/projects/x/${id(5)}.jsonl` } }];

  const { view } = await finder();

  assert.ok(!view.rows().some((r) => r.id === id(5)));
});
