// Since I looked and Viewed, on a real git repo: only what changed after the mark, untracked files included.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fake, resetFake } from "./fake/herdr.mjs";
import { fakeCx, find, flush, text } from "./fake/ui.mjs";

const { ReviewDiff, parseHashes } = await import("../review.js");
// Real git runs here, so each step gets real time as well as the event loop.
const settled = async () => { for (let i = 0; i < 30; i++) { await flush(); await new Promise((r) => setTimeout(r, 15)); } };

let repo;
beforeEach(() => {
  resetFake();
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = mkdtempSync(join(tmpdir(), "relevo-seen-"));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args]);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, "b.txt"), "one\n");
  writeFileSync(join(repo, ".gitignore"), "secret.env\n");
  git("add", "-A");
  git("commit", "-qm", "start");
  fake.exec = (cmd, args, options = {}) => {
    try {
      return { code: 0, stdout: execFileSync(cmd, args, { cwd: options.cwd }).toString() };
    } catch (e) {
      return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
    }
  };
});

async function open() {
  fake.props = { root: repo };
  const v = new ReviewDiff(), cx = fakeCx();
  v.init({}, cx);
  await settled();
  return { v, cx };
}

test("after a mark, Since I looked shows only what changed since, new files too, ignored ones never", async () => {
  writeFileSync(join(repo, "a.txt"), "two\n");
  const { v, cx } = await open();
  assert.deepEqual(v.files.map((f) => f.path), ["a.txt"]);
  await v.markSeen(cx);
  assert.match(text(find(v.header({}), "rv-scope")), /Since I looked/);
  writeFileSync(join(repo, "b.txt"), "two\n");
  writeFileSync(join(repo, "new.txt"), "fresh\n");
  writeFileSync(join(repo, "secret.env"), "TOKEN=x\n");
  v.setScope("seen", cx);
  await settled();
  assert.deepEqual(v.files.map((f) => f.path).sort(), ["b.txt", "new.txt"]);
  assert.match(v.rows.map((r) => r.text).join("\n"), /two/);
  assert.match(v.subject(), /since I last looked/);
  const refs = execFileSync("git", ["-C", repo, "for-each-ref", "refs/relevo/seen"]).toString();
  assert.match(refs, /tree\trefs\/relevo\/seen\//);
});

test("nothing new since the mark says so", async () => {
  writeFileSync(join(repo, "a.txt"), "two\n");
  const { v, cx } = await open();
  await v.markSeen(cx);
  v.setScope("seen", cx);
  await settled();
  assert.equal(v.files.length, 0);
  assert.match(v.empty(), /^Nothing changed since you looked/);
});

test("a viewed file unmarks itself when it changes", async () => {
  writeFileSync(join(repo, "a.txt"), "two\n");
  const { v, cx } = await open();
  v.toggleViewed("a.txt", cx);
  assert.equal(v.viewed("a.txt"), true);
  assert.match(text(v.header({})), /1 of 1 viewed/);
  writeFileSync(join(repo, "a.txt"), "three\n");
  v.load(cx);
  await settled();
  assert.equal(v.viewed("a.txt"), false);
});

test("sending comments marks what the agent had done by then", async () => {
  writeFileSync(join(repo, "a.txt"), "two\n");
  fake.agents = [{ address: "t1", pane: "p1", tab_name: "fix" }];
  fake.panes = [{ pane: "p1", cwd: repo }];
  const { v, cx } = await open();
  v.setComments([{ file: "a.txt", key: "+1", line: 1, side: "+", code: "two", text: "why" }]);
  v.send(cx);
  await settled();
  assert.ok(fake.stored["relevo.review.seen"][repo].tree);
});

test("hashes come from one git call, a gone file reads as gone", () => {
  const work = parseHashes("a.txt\nb.txt\n--\naaa\nbbb\n", "");
  assert.deepEqual([...work], [["a.txt", "aaa"], ["b.txt", "bbb"]]);
  const tree = parseHashes("100644 blob abc\ta b.txt\u0000100644 blob def\tc.txt\u0000", "HEAD");
  assert.deepEqual([...tree], [["a b.txt", "abc"], ["c.txt", "def"]]);
  assert.equal(parseHashes("\n--\n", "").size, 0);
});

test("a file deleted after the mark shows as changed, and a viewed one stays viewed until it changes", async () => {
  writeFileSync(join(repo, "a.txt"), "two\n");
  writeFileSync(join(repo, "b.txt"), "two\n");
  const { v, cx } = await open();
  v.toggleViewed("a.txt", cx);
  rmSync(join(repo, "b.txt"));
  v.load(cx);
  await settled();
  assert.equal(v.viewed("a.txt"), true);
  assert.equal(v.hashes.get("b.txt"), "-");
});
