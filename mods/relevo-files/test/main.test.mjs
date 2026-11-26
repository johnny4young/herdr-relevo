// The Files tree on the fake host: another tree's actions can't take unsaved edits away.
import "../../relevo/test/fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fake, resetFake } from "../../relevo/test/fake/herdr.mjs";
import { fakeCx, flush } from "../../relevo/test/fake/ui.mjs";

const { Files, directory } = await import("../main.js");
const ROOT = "/work", EVENT = "relevo-files.event";
let n = 0;

async function open({ dirty }) {
  fake.spaces = [{ id: "sp1", active: true, folder: ROOT }];
  fake.files[`${ROOT}/a.txt`] = "original";
  const files = new Files(), cx = fakeCx();
  files.init({}, cx);
  await flush();
  files.show("a.txt", cx);
  await flush();
  files.editor.edit(cx);
  if (dirty) files.editor.state.type("my edit", cx);
  fake.stored[EVENT] = { kind: "none", root: ROOT, n: ++n };
  files.follow(cx);
  return { files, cx, event: (e) => { fake.stored[EVENT] = { root: ROOT, n: ++n, ...e }; files.follow(cx); } };
}

beforeEach(resetFake);

test("a new file from another tree doesn't close unsaved edits", async () => {
  const { files, event } = await open({ dirty: true });
  const editor = files.editor;
  event({ kind: "open", path: "new.txt" });
  assert.equal(files.editor, editor);
  assert.equal(files.file, "a.txt");
  assert.equal(editor.state.value(), "my edit");
});

test("a new file opens when nothing is unsaved", async () => {
  const { files, event } = await open({ dirty: false });
  event({ kind: "open", path: "new.txt" });
  assert.equal(files.file, "new.txt");
});

test("trashing a file with unsaved edits keeps them and shows it deleted", async () => {
  const { files, event } = await open({ dirty: true });
  event({ kind: "trashed", path: "a.txt" });
  assert.equal(files.editor.state.value(), "my edit");
  assert.equal(files.editor.disk, null);
});

test("trashing a clean file closes it", async () => {
  const { files, event } = await open({ dirty: false });
  event({ kind: "trashed", path: "a.txt" });
  assert.equal(files.file, null);
  assert.equal(files.editor, null);
});

test("a folder symlink opens as a folder, and a dangling one stays a file", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "relevo-files-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "real"));
  symlinkSync(join(root, "real"), join(root, "linked"));
  symlinkSync(join(root, "gone"), join(root, "dangling"));
  fake.exec = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const kinds = Object.fromEntries((await directory(root)).map((e) => [e.name, e.dir]));
  assert.deepEqual(kinds, { real: true, linked: true, dangling: false });
});

test("git status is asked for the files inside a new folder", async () => {
  const seen = [];
  fake.exec = (cmd, args) => {
    if (cmd === "git") seen.push(args);
    return cmd === "git" && args.includes("--show-toplevel") ? { stdout: `${ROOT}\n` } : null;
  };
  await open({ dirty: false });
  assert.ok(seen.some((a) => a.includes("--untracked-files=all")));
});

test("a watched local folder isn't read on a timer; a new folder, or an unwatched one in front, is", async () => {
  const { fakeCx } = await import("../../relevo/test/fake/ui.mjs");
  const { Files } = await import("../main.js");
  resetFake();
  fake.spaces = [{ id: "s1", active: true, folder: "/work/app", machine: null }];
  const files = new Files(), cx = fakeCx(), reads = [];
  files.refresh = () => reads.push(1);
  files.tick(cx);
  assert.equal(reads.length, 1);
  files.context = { key: JSON.stringify({ cwd: "/work/app", on: null, space: "s1" }) };
  files.watched = "/work/app";
  files.readAt = 0;
  files.tick(cx);
  assert.equal(reads.length, 1);
  files.watched = null;
  fake.window = { active: false };
  files.tick(cx);
  assert.equal(reads.length, 1);
  fake.window = { active: true };
  files.tick(cx);
  assert.equal(reads.length, 2);
});

test("a restarted watch on the same folder outlives the cancelled loop and runs alone", async () => {
  const files = new Files(), cx = fakeCx();
  let reads = 0;
  fake.spaces = [{ id: "s1", active: true, folder: "/work/app", machine: null }];
  files.context = { key: JSON.stringify({ cwd: "/work/app", on: null, space: "s1" }) };
  files.refresh = () => { reads++; };
  files.watch("/work/app", cx);
  await flush();
  files.stopWatch();
  files.watch("/work/app", cx);
  await flush();
  assert.equal(files.watched, "/work/app");
  assert.equal(reads, 0, "the cancelled loop neither reads nor watches again");
  const before = fake.cancelledWatches.length;
  files.stopWatch();
  await flush();
  assert.equal(fake.cancelledWatches.length, before + 1, "only one live watch to cancel");
  assert.equal(files.watched, null);
});

test("Files shown again reads at once; a failed watch isn't retried every tick", async () => {
  fake.spaces = [{ id: "s1", active: true, folder: "/work/app", machine: null }];
  const panel = (hidden) => ({ id: "root", children: [{ id: "panel", hidden, children: [{ id: "panel-body", active: "files" }] }] });
  const files = new Files(), cx = fakeCx();
  let reads = 0;
  files.context = { key: JSON.stringify({ cwd: "/work/app", on: null, space: "s1" }) };
  files.root = "/work/app";
  files.refresh = () => { reads++; };
  files.watched = "/work/app";
  files.readAt = Date.now();
  fake.layout = panel(true);
  files.tick(cx);
  fake.layout = panel(false);
  files.tick(cx);
  assert.equal(reads, 1, "shown again reads what changed while hidden");
  files.watched = null;
  files.tick(cx);
  files.tick(cx);
  assert.equal(files.watched, null, "a watch that failed waits for the next read to retry");
  assert.equal(reads, 1);
});

test("the tree is a virtual list: clicks arrive by key, and its rows carry no handlers", async () => {
  fake.spaces = [{ id: "sp1", active: true, folder: ROOT }];
  const files = new Files(), cx = fakeCx();
  files.init({}, cx);
  await flush();
  files.root = ROOT;
  files.entries = new Map([["", [{ name: "src", dir: true }, { name: "a.txt", dir: false }]], ["src", [{ name: "b.txt", dir: false }]]]);
  const find = (node, id) => (node?.key === id ? node : (node?.items ?? []).map((x) => find(x, id)).find(Boolean) ?? null);
  let list = find(files.render(cx), "files-rows");
  assert.deepEqual(list.keys, ["file-src", "file-a.txt"]);
  assert.ok(list.items.every((row) => !Object.keys(row.handlers ?? {}).length), "a row inside a virtual list may not register handlers");
  list.handlers.on_item_click("file-src", cx);
  list = find(files.render(cx), "files-rows");
  assert.deepEqual(list.keys, ["file-src", "file-src/b.txt", "file-a.txt"]);
  list.handlers.on_item_secondary_click("file-a.txt", {}, { ...cx, stop_propagation() {} });
  assert.equal(fake.overlays.at(-1)?.props?.path, "a.txt");
});
