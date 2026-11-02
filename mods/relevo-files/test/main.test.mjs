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
