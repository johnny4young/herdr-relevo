// The review pane on a branch with no PR: uncommitted work, or everything since its base.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake } from "./fake/herdr.mjs";
import { fakeCx, find, flush, text, click } from "./fake/ui.mjs";

const { ReviewDiff } = await import("../review.js");
const settled = async () => { for (let i = 0; i < 12; i++) await flush(); };
const diffs = () => fake.execs.filter((l) => l.includes(" diff ") && l.includes("--numstat")).map((l) => l.split(" diff ")[1].split(" ")[0]);

function git({ base = "origin/main\n", mergeBase = "abc123\n" } = {}) {
  fake.exec = (cmd, args) => {
    if (cmd !== "git") return null;
    if (args.includes("symbolic-ref")) return base ? { stdout: base } : { code: 1, stdout: "" };
    if (args.includes("merge-base")) return { stdout: mergeBase };
    if (args.includes("--numstat")) return { stdout: args.includes("abc123") ? "1\t0\tcommitted.txt\n2\t1\tedited.txt\n" : "2\t1\tedited.txt\n" };
    return null;
  };
}

async function open(p = {}) {
  fake.props = { root: "/work/app", ...p };
  const v = new ReviewDiff(), cx = fakeCx();
  v.init(p, cx);
  await settled();
  return { v, cx };
}

beforeEach(() => {
  resetFake();
  git();
});

test("it starts on uncommitted work, and All changes compares with the branch's base", async () => {
  const { v, cx } = await open();
  assert.deepEqual(v.files.map((f) => f.path), ["edited.txt"]);
  assert.equal(diffs().at(-1), "HEAD");
  v.setScope("all", cx);
  await settled();
  assert.equal(diffs().at(-1), "abc123");
  assert.deepEqual(v.files.map((f) => f.path), ["committed.txt", "edited.txt"]);
  assert.match(v.subject(), /against origin\/main, committed and uncommitted/);
  v.setScope("uncommitted", cx);
  await settled();
  assert.deepEqual(v.files.map((f) => f.path), ["edited.txt"]);
  assert.equal(v.subject(), undefined);
});

test("without a base branch it says so and shows the uncommitted work", async () => {
  git({ base: "" });
  fake.exec = ((inner) => (cmd, args, o) => (args.includes("rev-parse") ? { code: 1, stdout: "" } : inner(cmd, args, o)))(fake.exec);
  const { v, cx } = await open({ root: "/work/nobase" });
  v.setScope("all", cx);
  await settled();
  assert.equal(diffs().at(-1), "HEAD");
  assert.equal(v.empty(), "No base branch to compare with");
  assert.equal(v.subject(), undefined);
});

test("a PR review has no picker; a branch review does", async () => {
  const { v } = await open();
  assert.ok(find(v.header(fake.theme ?? {}), "rv-scope"));
  const { v: pr } = await open({ pr: { repo: "me/app", number: 3, url: "u", base: "main" } });
  assert.equal(find(pr.header(fake.theme ?? {}), "rv-scope"), null);
  assert.match(text(pr.header(fake.theme ?? {})), /app #3 · against main/);
});

test("review scope is a named native keyboard control that changes comparison without accepting or sending", async () => {
  const { v, cx } = await open();
  const scope = find(v.render(), "rv-scope-all");
  assert.equal(scope.kind, "button"); assert.equal(scope.tabIndex, 0);
  assert.equal(scope.hasFocusStyle, true); assert.match(scope.accessibleLabel, /branch base/);
  assert.equal(scope.isSelected, false);
  click(scope, cx); await settled();
  assert.equal(v.scope, "all"); assert.equal(find(v.render(), "rv-scope-all").isSelected, true);
  assert.equal(diffs().at(-1), "abc123");
  assert.equal(fake.execs.some((s) => s.startsWith("hc send ")), false);
  assert.equal(v.seenMark(), null);
});

test("a run's range shows its two revisions only: no scope to pick, no checkpoint, the asked file first, nothing read again", async () => {
  const from = "b".repeat(40), to = "c".repeat(40);
  fake.exec = (cmd, args) => (cmd === "git" && args.includes("--numstat")
    ? { stdout: args.includes(from) && args.includes(to) ? "1\t0\tREADME.md\n6\t1\tslug.js\n" : "" } : null);
  const { v, cx } = await open({ range: { from, to, label: "Slugify · as reviewed", file: "slug.js" } });
  assert.deepEqual(v.files.map((f) => f.path), ["README.md", "slug.js"]);
  assert.equal(v.open.path, "slug.js");
  assert.equal(fake.execs.filter((l) => l.includes("ls-files --others")).length, 0, "two revisions have no untracked files");
  const view = v.render(cx);
  assert.equal(find(view, "rv-scope"), null);
  assert.equal(find(view, "rv-mark-seen"), null);
  assert.match(text(view), /Slugify · as reviewed/);
  const reads = fake.execs.length;
  for (const tick of cx.timers ?? []) tick.fn?.(cx);
  await settled();
  assert.equal(fake.execs.filter((l) => l.includes("--numstat")).length, fake.execs.slice(0, reads).filter((l) => l.includes("--numstat")).length);
});

test("a run's range has no agent to send comments to, so it shows no send bar", async () => {
  fake.exec = (cmd, args) => (cmd === "git" && args.includes("--numstat") ? { stdout: "1\t0\tREADME.md\n" } : null);
  const { v, cx } = await open({ range: { from: "b".repeat(40), to: "c".repeat(40), label: "Run · as accepted" } });
  assert.doesNotMatch(text(v.render(cx)), /No agent in this folder|Send to agent/);
  const plain = await open();
  assert.match(text(plain.v.render(plain.cx)), /No agent in this folder/);
});

test("opened with nothing uncommitted, it shows the branch's changes", async () => {
  fake.exec = (cmd, args) => {
    if (cmd !== "git") return null;
    if (args.includes("symbolic-ref")) return { stdout: "origin/main\n" };
    if (args.includes("merge-base")) return { stdout: "abc123\n" };
    if (args.includes("--numstat")) return { stdout: args.includes("abc123") ? "1\t0\tcommitted.txt\n" : "" };
    return null;
  };
  const { v, cx } = await open();
  assert.equal(v.scope, "all");
  assert.deepEqual(v.files.map((f) => f.path), ["committed.txt"]);
  // Uncommitted chosen by hand stays, even when empty.
  v.setScope("uncommitted", cx);
  await settled();
  assert.equal(v.scope, "uncommitted");
  assert.equal(v.empty(), "No uncommitted changes");
});

test("an agent's branch with an open PR starts on that PR: its commits only, untracked files left out", async () => {
  fake.stored["relevo.agentPRs"] = { t7: { number: 141, url: "https://github.com/me/app/pull/141", base: "main" } };
  const inner = fake.exec;
  fake.exec = (cmd, args, o) => (args?.includes("--others") ? { stdout: "notes.md\n" } : inner(cmd, args, o));
  const { v, cx } = await open({ terminal: "t7" });
  assert.equal(v.scope, "branch");
  assert.ok(fake.execs.some((l) => l.includes("merge-base origin/main HEAD")));
  assert.match(fake.execs.find((l) => l.includes("--numstat")), / diff abc123 HEAD /);
  assert.deepEqual(v.files.map((f) => f.path), ["committed.txt", "edited.txt"]);
  assert.match(v.subject(), /^PR #141 \(https:\/\/github\.com\/me\/app\/pull\/141\): the branch's commits against origin\/main$/);
  assert.equal(text(find(v.header(fake.theme ?? {}), "rv-scope-branch")), "PR #141");
  v.setScope("uncommitted", cx);
  await settled();
  assert.deepEqual(v.files.map((f) => f.path), ["edited.txt", "notes.md"]);
  const tagged = find(v.render(), "rv-tag-untracked-notes.md");
  assert.equal(tagged.tip, "Never committed: not in PR #141");
  assert.equal(find(v.render(), "rv-tag-new-notes.md"), null);
});

test("an agent without a PR, or a PR's own review, keeps its usual scopes", async () => {
  const { v } = await open({ terminal: "t8" });
  assert.equal(v.scope, "uncommitted");
  assert.equal(find(v.header(fake.theme ?? {}), "rv-scope-branch"), null);
  fake.stored["relevo.agentPRs"] = { t7: { number: 141, url: "u", base: "main" } };
  const { v: pr } = await open({ terminal: "t7", pr: { repo: "me/app", number: 3, url: "u", base: "main" } });
  assert.equal(pr.scope, "pr");
});
