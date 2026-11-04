// The review pane on a branch with no PR: uncommitted work, or everything since its base.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake } from "./fake/herdr.mjs";
import { fakeCx, find, flush, text } from "./fake/ui.mjs";

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
