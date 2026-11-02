// The Files tree on the fake host: another tree's actions can't take unsaved edits away.
import "../../relevo/test/fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake } from "../../relevo/test/fake/herdr.mjs";
import { fakeCx, flush } from "../../relevo/test/fake/ui.mjs";

const { Files } = await import("../main.js");
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
