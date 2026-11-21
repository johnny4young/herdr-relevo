// A PR's description in the review pane: read first, then the files.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake, calls } from "./fake/herdr.mjs";
import { fakeCx, find, click, text, flush } from "./fake/ui.mjs";
import { diffRows } from "../lib/diff.js";

const { ReviewDiff } = await import("../review.js");
const PR = { repo: "demo/app", number: 7, url: "https://github.com/demo/app/pull/7", base: "main" };
const key = (k) => ({ key: k, modifiers: {} });

beforeEach(resetFake);

async function review(body = "Why: the limiter drifted.\n\n<!-- template --> ![shot](https://x/y.png)\n- [x] tested") {
  fake.props = { pr: PR };
  fake.exec = (cmd, args) => (cmd === "gh" && args[1] === "view" ? { stdout: JSON.stringify({ title: "fix: steady limiter", body }) } : null);
  const v = new ReviewDiff(), cx = fakeCx();
  v.init({}, cx);
  await flush();
  v.files = [{ path: "a.js", add: 1, del: 0 }, { path: "b.js", add: 2, del: 1 }];
  v.open = v.files[0];
  v.hashes = new Map(v.files.map((f) => [f.path, `hash-${f.path}`]));
  v.rows = diffRows(["@@ -0,0 +1 @@", "+one"]);
  return { v, cx };
}

test("a PR review opens on its description, cleaned of HTML and images, without the diff", async () => {
  const { v } = await review();
  assert.equal(calls(/^gh pr view 7 --repo demo\/app --json title,body$/).length, 1);
  const el = v.render();
  assert.equal(text(find(el, "rv-about-row")), "Description");
  const body = text(find(el, "rv-about"));
  assert.match(body, /fix: steady limiter/);
  assert.match(body, /Why: the limiter drifted/);
  assert.doesNotMatch(body, /<!--|png|!\[/);
  assert.equal(find(el, "rv-diff"), null);
  assert.equal(text(find(el, "rv-files")).includes("a.js"), true, "the files stay listed under it");
});

test("] leaves for the first file, [ on the first file comes back, and a click on a file reads its diff", async () => {
  const { v, cx } = await review();
  v.handleKey(key("]"), cx);
  await flush();
  assert.equal(v.reading, false);
  assert.ok(find(v.render(), "rv-diff"));
  v.handleKey(key("["), cx);
  assert.equal(v.reading, true);
  click(find(v.render(), "rv-file-b.js"), cx);
  await flush();
  assert.equal(v.reading, false);
  assert.equal(v.open.path, "b.js");
  click(find(v.render(), "rv-about-row"), cx);
  assert.equal(v.reading, true);
  assert.equal(v.handleKey(key("c"), cx), undefined);
  assert.equal(v.editing, null, "no file comment while reading");
});

test("no body, no description; a file picked before it arrives stays open", async () => {
  const { v } = await review("  ");
  assert.equal(v.about, undefined);
  assert.equal(find(v.render(), "rv-about-row"), null);
  assert.ok(find(v.render(), "rv-diff"));

  fake.props = { pr: PR };
  let answer;
  fake.exec = (cmd) => (cmd === "gh" ? new Promise((resolve) => { answer = resolve; }) : null);
  const late = new ReviewDiff(), cx = fakeCx();
  late.init({}, cx);
  late.files = [{ path: "a.js", add: 1, del: 0 }];
  await late.showFile(late.files[0], cx);
  answer({ stdout: JSON.stringify({ title: "t", body: "why" }) });
  await flush();
  assert.equal(late.about.body, "why");
  assert.equal(late.reading, false);
});

test("a local review never asks GitHub", async () => {
  const v = new ReviewDiff();
  v.init({}, fakeCx());
  await flush();
  assert.equal(calls(/^gh /).length, 0);
});
