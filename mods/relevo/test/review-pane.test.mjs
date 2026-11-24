// The review pane's file rows, gutter, saved comment boxes and ⌘↵.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake, calls } from "./fake/herdr.mjs";
import { fakeCx, find, click, text, flush } from "./fake/ui.mjs";
import { diffRows, lineComment, fileComment, commentId } from "../lib/diff.js";

const { ReviewDiff } = await import("../review.js");
const t = fake.theme ?? new Proxy({}, { get: (_t, name) => `#${String(name)}` });
const NOTES = "relevo.review.notes";
const cmdEnter = { key: "enter", keystroke: "cmd-enter", modifiers: { platform: true, shift: false, alt: false, control: false } };

beforeEach(resetFake);

function review() {
  const v = new ReviewDiff(), cx = fakeCx();
  v.init({}, cx);
  v.key = "/synthetic";
  v.root = "/synthetic";
  v.files = [
    { path: "src/limiter/clock.ts", add: 31, del: 0, added: true },
    { path: "src/limiter/bucket.ts", add: 9, del: 6, added: false },
    { path: "README.md", add: 2, del: 0, added: false },
    { path: "notes/draft.txt", add: 0, del: 0, untracked: true, added: true },
  ];
  v.open = v.files[0];
  v.hashes = new Map(v.files.map((f) => [f.path, `hash-${f.path}`]));
  v.rows = diffRows(["@@ -0,0 +1,4 @@", "+one", "+two", "+three", "+four"]);
  return { v, cx };
}
const icons = (node) => (typeof node?.src === "string" ? [node.src] : []).concat((node?.items ?? []).flatMap(icons));
const fills = (node) => (node && typeof node === "object" ? [node.fill, ...(node.items ?? []).flatMap(fills)] : []);
const diffList = (v) => find(v.render(), "rv-diff");
// Any element under a node that would answer a click.
const clickable = (node) => (node && typeof node === "object"
  ? (Object.keys(node.handlers ?? {}).length ? [node] : []).concat((node.items ?? []).flatMap(clickable)) : []);
const clickItem = (v, cx, key) => diffList(v).handlers.on_item_click(key, cx);

test("a file row dims the folder and keeps the name in the foreground", () => {
  const { v } = review();
  const row = find(v.fileList(t), "rv-file-src/limiter/bucket.ts"), [, path] = row.items;
  assert.deepEqual(path.items.map(text), ["src/limiter/", "bucket.ts"]);
  const top = find(v.fileList(t), "rv-file-README.md");
  assert.deepEqual(top.items[1].items.map(text), ["README.md"]);
  assert.match(text(row), /\+9 −6$/);
  assert.equal(row.items.at(-1).items.length, 5);
  assert.deepEqual(row.items.at(-1).items.map((box) => box.fill), ["#ansi2", "#ansi2", "#ansi2", "#ansi1", "#ansi1"]);
});

test("the comment count is a tag with the comment icon, only on files that have comments", () => {
  const { v } = review();
  v.setComments([lineComment("src/limiter/clock.ts", v.rows, 1, 1, "a"), fileComment("src/limiter/clock.ts", "b"), fileComment("README.md", "c")]);
  const list = v.fileList(t), count = find(list, "rv-count-src/limiter/clock.ts");
  assert.equal(text(count), "2");
  assert.deepEqual(icons(count), ["mods/relevo/icons/comment.svg"]);
  assert.equal(count.fill, "#accent26");
  assert.equal(text(find(list, "rv-count-README.md")), "1");
  assert.equal(find(list, "rv-count-src/limiter/bucket.ts"), null);
  assert.doesNotMatch(text(list), /●/);
});

test("only a file the diff creates carries the new tag; one never committed says untracked", () => {
  const { v } = review(), list = v.fileList(t);
  assert.equal(text(find(list, "rv-tag-new-src/limiter/clock.ts")), "new");
  assert.equal(find(list, "rv-tag-new-src/limiter/clock.ts").fill, "#ansi226");
  assert.equal(find(list, "rv-tag-new-notes/draft.txt"), null);
  assert.equal(text(find(list, "rv-tag-untracked-notes/draft.txt")), "untracked");
  assert.equal(find(list, "rv-tag-new-src/limiter/bucket.ts"), null);
  assert.equal(find(list, "rv-tag-new-README.md"), null);
  assert.match(text(find(list, "rv-file-src/limiter/clock.ts")), /new \+31$/);
});

test("reading the diff marks the files git says it creates", async () => {
  const { v, cx } = review();
  fake.exec = (_cmd, args) => (args.includes("--numstat")
    ? { stdout: "3\t0\tsrc/new file.ts\n1\t1\told.ts\n create mode 100644 src/new file.ts\n delete mode 100644 gone.ts\n" }
    : null);
  await v.read(cx);
  assert.deepEqual(v.files, [{ path: "src/new file.ts", add: 3, del: 0, added: true, binary: false }, { path: "old.ts", add: 1, del: 1, added: false, binary: false }]);
  assert.equal(calls(/ diff .*--numstat --summary/).length, 1);
  v.close();
});

test("the gutter keeps the line number and adds the comment icon where a comment starts", () => {
  const { v } = review();
  v.setComments([lineComment("src/limiter/clock.ts", v.rows, 2, 3, "range"), lineComment("src/limiter/clock.ts", v.rows, 4, 4, "line")]);
  const list = diffList(v);
  assert.deepEqual(list.keys, ["0", "1", "2", "3", "c:+2..+3", "4", "c:+4"]);
  const rows = [1, 2, 3, 5].map((n) => list.items[n]);
  assert.deepEqual(rows.map((row) => text(row.items[0])), ["1", "2", "3", "4"]);
  assert.deepEqual(rows.map(icons), [[], ["mods/relevo/icons/comment.svg"], [], ["mods/relevo/icons/comment.svg"]]);
  assert.doesNotMatch(text(list), /●/);
  // The range is tinted; a single commented line is not.
  assert.deepEqual(rows.map((row) => row.fill), ["#ansi218", "#accent1f", "#accent1f", "#ansi218"]);
});

test("a saved comment shows as a box with its lines and text, and nothing in the list answers a click itself", () => {
  const { v } = review();
  const range = lineComment("src/limiter/clock.ts", v.rows, 2, 3, "Keep this in test/"), line = lineComment("src/limiter/clock.ts", v.rows, 4, 4, "Why?");
  v.setComments([range, line, fileComment("src/limiter/clock.ts", "Whole thing")]);
  const root = v.render(), list = find(root, "rv-diff");
  assert.equal(text(list.items[4]), "L2-3 Keep this in test/");
  assert.equal(text(list.items[6]), "L4 Why?");
  assert.deepEqual(icons(list.items[4]), []);
  assert.deepEqual(list.items.flatMap(clickable), []);
  assert.equal(find(list, `rv-del-${commentId(range)}`), null);
  assert.equal(text(find(root, "rv-file-note")), "File Whole thing");
  assert.ok(!fills(list.items[4]).includes("#accent"));
});

test("the strip above the footer lists the open file's comments, each with a real ×", () => {
  const { v } = review();
  const range = lineComment("src/limiter/clock.ts", v.rows, 2, 3, "range"), file = fileComment("src/limiter/clock.ts", "file");
  assert.equal(find(v.render(), "rv-saved"), null);
  v.setComments([fileComment("README.md", "other")]);
  assert.equal(find(v.render(), "rv-saved"), null);
  v.setComments([range, file, fileComment("README.md", "other")]);
  const strip = find(v.render(), "rv-saved");
  assert.deepEqual(strip.items.map(text), ["L2-3 range", "File file"]);
  for (const c of [range, file]) {
    const x = find(strip, `rv-del-${commentId(c)}`);
    assert.equal(x.kind, "button");
    assert.deepEqual(icons(x), ["mods/relevo/icons/x.svg"]);
    assert.equal(x.tip, "Delete this comment");
  }
  v.close();
});

test("× in the strip deletes only its comment and saves the rest", () => {
  const { v, cx } = review();
  const range = lineComment("src/limiter/clock.ts", v.rows, 2, 3, "range"), line = lineComment("src/limiter/clock.ts", v.rows, 4, 4, "line");
  const file = fileComment("src/limiter/clock.ts", "file"), other = fileComment("README.md", "other");
  v.setComments([range, line, file, other]);
  click(find(v.render(), `rv-del-${commentId(range)}`), cx);
  assert.deepEqual(v.comments, [line, file, other]);
  assert.deepEqual(fake.stored[NOTES][v.key], [line, file, other]);
  assert.equal(v.editing, null);
  click(find(v.render(), "rv-del-file"), cx);
  assert.deepEqual(fake.stored[NOTES][v.key], [line, other]);
  click(find(v.render(), `rv-del-${commentId(line)}`), cx);
  assert.deepEqual(fake.stored[NOTES][v.key], [other]);
  assert.equal(find(v.render(), "rv-saved"), null);
  assert.deepEqual(fake.execs, []);
  v.close();
});

test("× on one comment leaves an open edit of another alone, and the last one clears the store", () => {
  const { v, cx } = review();
  const line = lineComment("src/limiter/clock.ts", v.rows, 4, 4, "line");
  v.setComments([line]);
  v.edit({ start: 1, end: 1 }, cx);
  v.input.set_value("draft");
  click(find(v.render(), `rv-del-${commentId(line)}`), cx);
  assert.deepEqual(v.editing, { start: 1, end: 1 });
  assert.equal(v.input.value(), "draft");
  assert.equal(fake.stored[NOTES][v.key], undefined);
  v.close();
});

test("a click on a comment's box in the diff opens it, a range as a range, and never deletes", () => {
  const { v, cx } = review();
  const range = lineComment("src/limiter/clock.ts", v.rows, 2, 3, "range");
  v.setComments([range]);
  // Wherever the press lands, right edge included.
  for (const x of [0, 300, 599, null]) {
    const at = x === null ? {} : { local_position: { x, y: 0 }, bounds: { x: 0, y: 0, width: 600, height: 400 } };
    find(v.render(), "rv-diff-area").handlers["on_mouse_down:left"]({ modifiers: { shift: false }, ...at });
    clickItem(v, cx, `c:${commentId(range)}`);
    assert.deepEqual(v.editing, { start: 2, end: 3 });
    assert.equal(v.input.value(), "range");
    assert.deepEqual(v.comments, [range]);
    assert.deepEqual(fake.stored[NOTES][v.key], [range]);
    assert.ok(find(v.render(), "rv-comment-delete"));
    v.cancelEdit(cx);
  }
  v.close();
});

test("⌘↵ sends like the button", async () => {
  const sent = [];
  for (const how of ["button", "key"]) {
    resetFake();
    const { v, cx } = review();
    fake.agents = [{ address: "t1", pane: "p1", tab_name: "fix" }];
    fake.panes = [{ pane: "p1", cwd: "/synthetic" }];
    v.snapshot = async () => "abc";
    v.setComments([fileComment("README.md", "Shorter")]);
    if (how === "button") click(find(v.render(), "rv-send"), cx);
    else v.render().handlers.on_key_down(cmdEnter, cx);
    await flush();
    sent.push(calls(/^hc send t1 /));
    assert.equal(sent.at(-1).length, 1);
    assert.match(v.note, /^Sent to fix/);
    assert.deepEqual(v.comments, []);
    assert.equal(fake.stored[NOTES]?.[v.key], undefined);
    v.close();
  }
  assert.deepEqual(sent[0], sent[1]);
});

test("⌘↵ does nothing where the button is disabled, and other chords never send", async () => {
  const { v, cx } = review();
  const down = (e) => v.render().handlers.on_key_down(e, cx);
  fake.agents = [{ address: "t1", pane: "p1" }];
  fake.panes = [{ pane: "p1", cwd: "/synthetic" }];
  down(cmdEnter);
  v.setComments([fileComment("README.md", "Shorter")]);
  for (const mods of [{ platform: false }, { platform: true, shift: true }, { platform: true, alt: true }, { platform: true, control: true }]) down({ key: "enter", modifiers: mods });
  down({ key: "s", modifiers: { platform: true } });
  down({ ...cmdEnter, is_held: true });
  v.render().handlers.on_key_up(cmdEnter, cx);
  fake.agents = [];
  assert.equal(find(v.render(), "rv-send").isDisabled, true);
  down(cmdEnter);
  await flush();
  assert.deepEqual(fake.execs, []);
  assert.equal(v.comments.length, 1);
  v.close();
});

test("⌘↵ in the comment field saves that comment and keeps the key from the pane", async () => {
  const { v, cx } = review();
  let stopped = 0;
  cx.stop_propagation = () => { stopped += 1; };
  fake.agents = [{ address: "t1", pane: "p1" }];
  fake.panes = [{ pane: "p1", cwd: "/synthetic" }];
  v.setComments([fileComment("README.md", "Shorter")]);
  v.edit({ start: 1, end: 1 }, cx);
  v.input.set_value("Rename");
  const field = () => find(v.render(), "rv-comment-field");
  field().handlers.on_key_down({ key: "enter", modifiers: {} }, cx);
  assert.equal(stopped, 0);
  assert.deepEqual(v.editing, { start: 1, end: 1 });
  // The field's own submit may have saved already; the key is still stopped and nothing is saved twice.
  const again = field();
  again.handlers.on_key_down(cmdEnter, cx);
  again.handlers.on_key_down(cmdEnter, cx);
  assert.equal(stopped, 2);
  assert.equal(v.editing, null);
  assert.deepEqual(v.comments.map((c) => c.text), ["Shorter", "Rename"]);
  await flush();
  assert.deepEqual(fake.execs, []);
  // With the editor closed the pane takes the key: held it does nothing, pressed it sends.
  v.render().handlers.on_key_down({ ...cmdEnter, is_held: true }, cx);
  v.render().handlers.on_key_up(cmdEnter, cx);
  await flush();
  assert.deepEqual(fake.execs.filter((line) => line.startsWith("hc ")), []);
  v.render().handlers.on_key_down(cmdEnter, cx);
  await flush();
  assert.equal(calls(/^hc send t1 /).length, 1);
  v.close();
});

test("⌘↵ on the pane with an editor open does not send", async () => {
  const { v, cx } = review();
  fake.agents = [{ address: "t1", pane: "p1" }];
  fake.panes = [{ pane: "p1", cwd: "/synthetic" }];
  v.setComments([fileComment("README.md", "Shorter")]);
  v.edit("file", cx);
  v.render().handlers.on_key_down(cmdEnter, cx);
  await flush();
  assert.equal(v.editing, "file");
  assert.deepEqual(fake.execs, []);
  v.close();
});

test("the editor names its lines the way the saved comment does, and the diff list is rebuilt only on a change", () => {
  const { v, cx } = review();
  v.edit({ start: 2, end: 3 }, cx);
  assert.match(text(find(v.render(), "rv-comment-editor")), /^Add comment · src\/limiter\/clock\.ts · L2-3 /);
  v.cancelEdit(cx);
  v.edit("file", cx);
  assert.match(text(find(v.render(), "rv-comment-editor")), /· File /);
  const model = v.diffModel();
  v.input.set_value("typing");
  v.render();
  assert.equal(v.diffModel(), model);
  v.save(cx);
  assert.notEqual(v.diffModel(), model);
  const saved = v.diffModel();
  v.rows = [...v.rows];
  assert.notEqual(v.diffModel(), saved);
  v.close();
});

test("the footer shows the ⌘↵ keys beside Send", () => {
  const { v } = review(), key = find(v.render(), "rv-send-key");
  assert.equal(text(key), "⌘");
  assert.deepEqual(icons(key), ["mods/relevo/icons/enter.svg"]);
  v.close();
});

test("a second ⌘↵ while hc send is still answering sends nothing more", async () => {
  const { v, cx } = review();
  fake.agents = [{ address: "t1", pane: "p1", tab_name: "fix" }];
  fake.panes = [{ pane: "p1", cwd: "/synthetic" }];
  v.snapshot = async () => "abc";
  let answer;
  fake.exec = (cmd) => (cmd === "hc" ? new Promise((resolve) => { answer = resolve; }) : null);
  v.setComments([fileComment("README.md", "Shorter")]);
  v.render().handlers.on_key_down(cmdEnter, cx);
  await flush();
  assert.equal(find(v.render(), "rv-send").isDisabled, true);
  v.render().handlers.on_key_down(cmdEnter, cx);
  v.send(cx);
  answer({});
  await flush();
  assert.equal(calls(/^hc send t1 /).length, 1);
  assert.deepEqual(v.comments, []);
  v.close();
});

test("a shift-click after opening a range comment extends from that range", () => {
  const { v, cx } = review();
  v.rows = diffRows(["@@ -0,0 +1,6 @@", "+one", "+two", "+three", "+four", "+five", "+six"]);
  const range = lineComment("src/limiter/clock.ts", v.rows, 3, 4, "range");
  v.setComments([range]);
  v.clickRow(1, cx);
  v.cancelEdit(cx);
  v.clickRow(1, cx);
  clickItem(v, cx, `c:${commentId(range)}`);
  v.shift = true;
  v.clickRow(6, cx);
  assert.deepEqual(v.editing, { start: 3, end: 6 });
  v.close();
});

test("a press anywhere in the pane gives it focus for ⌘↵, but not while a comment is open", () => {
  const { v, cx } = review();
  let focused = 0;
  v.focus.focus = () => { focused += 1; };
  v.render().handlers["on_mouse_down:left"]({});
  assert.equal(focused, 1);
  v.edit("file", cx);
  v.render().handlers["on_mouse_down:left"]({});
  assert.equal(focused, 1);
  v.close();
});

test("a saved range whose first line left the diff opens as itself and keeps its lines when saved", () => {
  const { v, cx } = review();
  const range = lineComment("src/limiter/clock.ts", v.rows, 1, 3, "Keep the range"), other = fileComment("README.md", "other");
  v.setComments([range, other]);
  // The refreshed diff starts at line 3: the range's last line is drawn, its first is not.
  v.rows = diffRows(["@@ -2,0 +3,2 @@", "+three", "+four"]);
  assert.deepEqual(diffList(v).keys, ["0", "1", `c:${commentId(range)}`, "2"]);
  clickItem(v, cx, `c:${commentId(range)}`);
  assert.deepEqual(v.editing, { id: commentId(range) });
  assert.equal(v.input.value(), "Keep the range");
  assert.match(text(find(v.render(), "rv-comment-editor")), /^Edit comment · src\/limiter\/clock\.ts · L1-3 /);
  assert.ok(find(v.render(), "rv-comment-delete"));
  // No row reads as being edited, and a second click changes nothing.
  assert.ok(!diffList(v).items.some((row) => row.fill === "#selected"));
  const target = v.editing;
  clickItem(v, cx, `c:${commentId(range)}`);
  assert.equal(v.editing, target);
  v.input.set_value("Reworded");
  v.save(cx);
  assert.equal(v.editing, null);
  assert.deepEqual(v.comments, [other, { ...range, text: "Reworded" }]);
  assert.deepEqual(fake.stored[NOTES][v.key], v.comments);
  v.close();
});

test("a binary file says so instead of counts and squares", async () => {
  const { v, cx } = review();
  fake.exec = (_cmd, args) => (args.includes("--numstat") ? { stdout: "-\t-\tlogo.png\n0\t0\tempty.txt\n" } : null);
  await v.read(cx);
  assert.deepEqual(v.files, [{ path: "logo.png", add: 0, del: 0, added: false, binary: true }, { path: "empty.txt", add: 0, del: 0, added: false, binary: false }]);
  const list = v.fileList(t), row = find(list, "rv-file-logo.png");
  assert.equal(text(find(list, "rv-tag-binary-logo.png")), "binary");
  assert.match(text(row), /logo\.png binary$/);
  assert.equal(row.items.at(-1).key, "rv-tag-binary-logo.png");
  assert.equal(find(list, "rv-tag-binary-empty.txt"), null);
  assert.match(text(find(list, "rv-file-empty.txt")), /\+0$/);
  v.close();
});

test("a comment in the strip opens for editing from its label and text, × apart", () => {
  const { v, cx } = review();
  const range = lineComment("src/limiter/clock.ts", v.rows, 2, 3, "range"), file = fileComment("src/limiter/clock.ts", "file");
  // A comment on lines the diff does not draw has no box in the list: the strip is its only way in.
  const far = { file: "src/limiter/clock.ts", key: "+900", line: 900, side: "+", code: "far", text: "far away" };
  v.setComments([range, file, far]);
  assert.ok(!diffList(v).keys.includes(`c:${commentId(far)}`));
  const strip = () => find(v.render(), "rv-saved");
  for (const c of [range, file, far]) {
    const edit = find(strip(), `rv-edit-${commentId(c)}`);
    assert.equal(edit.kind, "button");
    assert.equal(find(edit, `rv-del-${commentId(c)}`), null);
    assert.ok(find(strip(), `rv-del-${commentId(c)}`));
  }
  click(find(strip(), `rv-edit-${commentId(range)}`), cx);
  assert.deepEqual(v.editing, { start: 2, end: 3 });
  assert.equal(v.input.value(), "range");
  click(find(strip(), "rv-edit-file"), cx);
  assert.equal(v.editing, "file");
  click(find(strip(), `rv-edit-${commentId(far)}`), cx);
  assert.deepEqual(v.editing, { id: "+900" });
  assert.equal(v.input.value(), "far away");
  v.input.set_value("still far");
  v.save(cx);
  assert.deepEqual(v.comments, [range, file, { ...far, text: "still far" }]);
  v.close();
});

test("deleting matches a comment by what it is on, and says deleted only when one went", () => {
  const { v, cx } = review();
  const line = lineComment("src/limiter/clock.ts", v.rows, 4, 4, "line"), other = fileComment("README.md", "other");
  v.setComments([line, other]);
  // The stored objects were replaced since this × was drawn, as a save or a restart does.
  const stale = find(v.render(), `rv-del-${commentId(line)}`);
  v.setComments(JSON.parse(JSON.stringify(v.comments)));
  click(stale, cx);
  assert.deepEqual(v.comments, [other]);
  assert.equal(v.note, "Comment deleted");
  v.note = null;
  const before = v.comments;
  click(stale, cx);
  v.removeComment(fileComment("src/limiter/clock.ts", "never saved"), cx);
  assert.equal(v.comments, before);
  assert.equal(v.note, null);
  assert.deepEqual(fake.stored[NOTES][v.key], [other]);
  v.close();
});

test("a huge review lists its first 200 files and counts the rest, reading the viewed marks once per draw", () => {
  const { v } = review();
  v.files = Array.from({ length: 450 }, (_, i) => ({ path: `src/f${i}.ts`, add: 1, del: 0 }));
  v.hashes = new Map(v.files.map((f) => [f.path, `h${f.path}`]));
  fake.sharedReads = {};
  const drawn = v.render();
  assert.equal(fake.sharedReads["relevo.review.viewed"], 1);
  assert.ok(find(drawn, "rv-file-src/f199.ts"));
  assert.equal(find(drawn, "rv-file-src/f200.ts"), null);
  assert.equal(text(find(drawn, "rv-files-more")), "250 more files");
});
