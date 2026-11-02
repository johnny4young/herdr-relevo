import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { URL } from "node:url";

// Exercise the real editor with an in-memory host. No files, accounts or native UI are used.
function harness(read = async () => "original") {
  const writes = [], notifications = [], timers = [];
  const source = readFileSync(new URL("../editor.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace("export class FileEditor", "class FileEditor") + "\nglobalThis.FileEditor = FileEditor;";
  const host = vm.createContext({
    writeTextFile(path, text, expected) {
      return new Promise((resolve, reject) => writes.push({ path, text, expected, resolve, reject }));
    },
    readTextFile: read,
    exec: async () => ({ code: 0, stdout: "10" }),
    textState: text => ({ editable: true, value: text }),
    theme: () => ({}), settings: () => ({}), languageOf: () => "text",
    EditorState: { new: ({ value }) => ({ value: () => value, release() {}, on() {} }) },
  });
  vm.runInContext(source, host);
  const editor = new host.FileEditor("/synthetic/example.txt");
  let value = "first edit", released = false;
  editor.base = "original";
  editor.editing = true;
  editor.dirty = true;
  editor.state = { value: () => value, release: () => { released = true; } };
  editor.watch = () => {};
  const cx = { notify: () => notifications.push(true), timer: { after: (...args) => timers.push(args) } };
  return { editor, cx, writes, notifications, timers, type: text => { value = text; editor.editVersion++; editor.dirty = true; }, released: () => released };
}

test("a save keeps edits typed while its write is pending dirty", async () => {
  const h = harness();
  const saving = h.editor.save(h.cx);
  h.type("newer edit");
  h.writes[0].resolve();
  await saving;
  assert.equal(h.writes[0].text, "first edit");
  assert.equal(h.editor.base, "first edit");
  assert.equal(h.editor.state.value(), "newer edit");
  assert.equal(h.editor.dirty, true, "Back must still ask before discarding the newer edit");
});

test("overlapping save requests share the active write and preserve the next edit", async () => {
  const h = harness();
  const first = h.editor.save(h.cx);
  h.type("second edit");
  const second = h.editor.save(h.cx);
  assert.equal(h.writes.length, 1, "do not race two compare-and-write calls against the same base");
  h.writes[0].resolve();
  await Promise.all([first, second]);
  assert.equal(h.editor.dirty, true);
  const next = h.editor.save(h.cx);
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].expected, "first edit");
  assert.equal(h.writes[1].text, "second edit");
  h.writes[1].resolve();
  await next;
  assert.equal(h.editor.dirty, false);
});

test("closing during a pending save releases state without notifying the closed editor", async () => {
  const h = harness();
  const saving = h.editor.save(h.cx);
  h.editor.close();
  h.writes[0].resolve();
  await saving;
  assert.equal(h.released(), true);
  assert.equal(h.editor.state, null);
  assert.equal(h.notifications.length, 0);
  assert.equal(h.timers.length, 0);
});

test("a completed unchanged save becomes clean and releases the save guard", async () => {
  const h = harness();
  const saving = h.editor.save(h.cx);
  h.writes[0].resolve();
  await saving;
  assert.equal(h.editor.base, "first edit");
  assert.equal(h.editor.dirty, false);
  assert.equal(h.notifications.length, 1);
});


test("a rejected write preserves edits and permits a later save", async () => {
  const h = harness();
  const first = h.editor.save(h.cx);
  h.writes[0].reject(new Error("synthetic write failure"));
  await first;
  assert.equal(h.editor.dirty, true);
  assert.match(h.editor.note, /synthetic write failure/);
  const next = h.editor.save(h.cx);
  assert.equal(h.writes.length, 2);
  h.writes[1].resolve();
  await next;
  assert.equal(h.editor.dirty, false);
});

test("Keep mine does not change the expected base during an active save", async () => {
  const h = harness();
  const first = h.editor.save(h.cx);
  h.editor.disk = "external text";
  const keep = h.editor.keepMine(h.cx);
  assert.equal(h.editor.base, "original");
  assert.equal(h.writes.length, 1);
  h.writes[0].resolve();
  await Promise.all([first, keep]);
});


function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("a load preserves edits typed while its read is pending and shows the disk conflict", async () => {
  const h = harness(), read = deferred();
  h.editor.dirty = false;
  const loading = h.editor.load(h.cx, () => read.promise);
  h.type("typed during load");
  read.resolve("disk version");
  await loading;
  assert.equal(h.editor.state.value(), "typed during load");
  assert.equal(h.editor.base, "original");
  assert.equal(h.editor.dirty, true);
  assert.equal(h.editor.disk, "disk version");
});

test("only the newest load can replace editor state", async () => {
  const h = harness(), first = deferred(), second = deferred();
  h.editor.dirty = false;
  const a = h.editor.load(h.cx, () => first.promise);
  const b = h.editor.load(h.cx, () => second.promise);
  second.resolve("newest disk");
  await b;
  first.resolve("stale disk");
  await a;
  assert.equal(h.editor.state.value(), "newest disk");
  assert.equal(h.editor.base, "newest disk");
  assert.equal(h.notifications.length, 1);
});

test("closing during a load cannot recreate released state or notify", async () => {
  const h = harness(), read = deferred();
  const loading = h.editor.load(h.cx, () => read.promise);
  h.editor.close();
  read.resolve("disk");
  await loading;
  assert.equal(h.editor.state, null);
  assert.equal(h.notifications.length, 0);
});

test("a load cannot replace editor state while a save is pending", async () => {
  const h = harness(), read = deferred();
  const saving = h.editor.save(h.cx);
  const loading = h.editor.load(h.cx, () => read.promise);
  read.resolve("old disk");
  await loading;
  assert.equal(h.editor.state.value(), "first edit");
  assert.equal(h.editor.base, "original");
  h.writes[0].resolve();
  await saving;
  assert.equal(h.editor.base, "first edit");
});

test("a read started before a completed save cannot roll it back", async () => {
  const h = harness(), read = deferred();
  h.editor.dirty = false;
  const loading = h.editor.load(h.cx, () => read.promise);
  const saving = h.editor.save(h.cx);
  h.writes[0].resolve();
  await saving;
  read.resolve("old disk");
  await loading;
  assert.equal(h.editor.state.value(), "first edit");
  assert.equal(h.editor.base, "first edit");
});


test("explicit Reload discards only edits present when clicked", async () => {
  const read = deferred(), h = harness(() => read.promise);
  const loading = h.editor.reload(h.cx);
  read.resolve("selected disk");
  await loading;
  assert.equal(h.editor.state.value(), "selected disk");
  assert.equal(h.editor.base, "selected disk");
  assert.equal(h.editor.dirty, false);
});

test("explicit Reload preserves edits typed after the click", async () => {
  const read = deferred(), h = harness(() => read.promise);
  const loading = h.editor.reload(h.cx);
  h.type("after Reload");
  read.resolve("selected disk");
  await loading;
  assert.equal(h.editor.state.value(), "after Reload");
  assert.equal(h.editor.dirty, true);
  assert.equal(h.editor.disk, "selected disk");
});

test("Reload also preserves edits undone to the initial value during its read", async () => {
  const read = deferred(), h = harness(() => read.promise);
  const loading = h.editor.reload(h.cx);
  h.type("temporary edit");
  h.type("first edit");
  read.resolve("selected disk");
  await loading;
  assert.equal(h.editor.state.value(), "first edit");
  assert.equal(h.editor.dirty, true);
  assert.equal(h.editor.disk, "selected disk");
});

test("a failed superseded read cannot replace the newer result with an error", async () => {
  const h = harness(), first = deferred(), second = deferred();
  h.editor.dirty = false;
  const a = h.editor.load(h.cx, () => first.promise);
  const b = h.editor.load(h.cx, () => second.promise);
  second.resolve("newest disk");
  await b;
  first.reject(new Error("stale read"));
  await a;
  assert.equal(h.editor.state.value(), "newest disk");
  assert.equal(h.editor.error, null);
  assert.equal(h.notifications.length, 1);
});

test("a failed read after close does not notify or restart watching", async () => {
  const h = harness(), read = deferred();
  let watched = false;
  h.editor.watch = () => { watched = true; };
  const loading = h.editor.load(h.cx, () => read.promise);
  h.editor.close();
  read.reject(new Error("closed read"));
  await loading;
  assert.equal(h.notifications.length, 0);
  assert.equal(watched, false);
});

test("an automatic load never discards edits that were already dirty", async () => {
  const h = harness();
  await h.editor.load(h.cx, async () => "external");
  assert.equal(h.editor.state.value(), "first edit");
  assert.equal(h.editor.dirty, true);
  assert.equal(h.editor.disk, "external");
});
