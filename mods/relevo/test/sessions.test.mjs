// The session finder on a fake app: which sessions it offers, the keyboard, and how one resumes.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
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
  const details = [`${id(1)}\t"file":true`, `${id(1)}\t"customTitle":"Fix the CI"`, `${id(2)}\t"file":true`,
    `${id(2)}\t"lastPrompt":"trim the silence"`, `${id(2)}\t"gitBranch":"feat"`, `${id(3)}\t"file":true`, `${id(5)}\t"file":true`].join("\n");
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
