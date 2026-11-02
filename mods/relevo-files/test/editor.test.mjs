// The real editor on the fake host: saves, reads and typing that overlap.
import "../../relevo/test/fake/register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake } from "../../relevo/test/fake/herdr.mjs";
import { fakeCx, flush } from "../../relevo/test/fake/ui.mjs";

const { FileEditor } = await import("../editor.js");
const PATH = "/synthetic/example.txt";

async function harness(read) {
  resetFake();
  const writes = [], cx = fakeCx(), editor = new FileEditor(PATH);
  fake.files[PATH] = "original";
  fake.write = (path, text, expected) => new Promise((resolve, reject) => writes.push({ path, text, expected, resolve, reject }));
  await editor.load(cx);
  editor.edit(cx);
  const type = (text) => editor.state.type(text, cx);
  type("first edit");
  if (read) fake.read = read;
  cx.notified = 0;
  return { editor, cx, writes, type };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("a save keeps edits typed while its write is pending dirty", async () => {
  const h = await harness();
  const saving = h.editor.save(h.cx);
  h.type("newer edit");
  h.writes[0].resolve();
  await saving;
  assert.equal(h.writes[0].text, "first edit");
  assert.equal(h.editor.base, "first edit");
  assert.equal(h.editor.state.value(), "newer edit");
  assert.equal(h.editor.dirty, true, "Back must still ask before discarding the newer edit");
});

test("a Save during a write runs after it, from the new base", async () => {
  const h = await harness();
  const first = h.editor.save(h.cx);
  h.type("second edit");
  const second = h.editor.save(h.cx);
  assert.equal(h.writes.length, 1, "do not race two compare-and-write calls against the same base");
  h.writes[0].resolve();
  await flush();
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].expected, "first edit");
  assert.equal(h.writes[1].text, "second edit");
  h.writes[1].resolve();
  await Promise.all([first, second]);
  assert.equal(h.editor.dirty, false);
});

test("a Save during a write that fails is not retried", async () => {
  const h = await harness();
  const first = h.editor.save(h.cx);
  h.editor.save(h.cx);
  h.writes[0].reject(new Error("synthetic write failure"));
  await first;
  assert.equal(h.writes.length, 1);
  assert.match(h.editor.note, /synthetic write failure/);
});

test("closing during a pending save releases state without notifying the closed editor", async () => {
  const h = await harness();
  let released = false;
  h.editor.state.release = () => { released = true; };
  const saving = h.editor.save(h.cx);
  h.editor.close();
  h.writes[0].resolve();
  await saving;
  assert.equal(released, true);
  assert.equal(h.editor.state, null);
  assert.equal(h.cx.notified, 0);
  assert.equal(h.cx.timers.length, 0);
});

test("a completed unchanged save becomes clean and releases the save guard", async () => {
  const h = await harness();
  const saving = h.editor.save(h.cx);
  h.writes[0].resolve();
  await saving;
  assert.equal(h.editor.base, "first edit");
  assert.equal(h.editor.dirty, false);
  assert.equal(h.editor.saving, null);
  assert.equal(h.cx.notified, 1);
});

test("a rejected write preserves edits and permits a later save", async () => {
  const h = await harness();
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

test("a save that lands replaces an old failure note, even with newer typing", async () => {
  const h = await harness();
  const first = h.editor.save(h.cx);
  h.writes[0].reject(new Error("synthetic write failure"));
  await first;
  const next = h.editor.save(h.cx);
  h.type("newer edit");
  h.writes[1].resolve();
  await next;
  assert.equal(h.editor.note, "Saved");
  assert.equal(h.editor.dirty, true);
});

test("a file renamed during a save still records the result", async () => {
  const h = await harness();
  const saving = h.editor.save(h.cx);
  h.editor.path = "/synthetic/renamed.txt";
  h.writes[0].resolve();
  await saving;
  assert.equal(h.editor.base, "first edit");
  assert.equal(h.editor.dirty, false);
  assert.equal(h.cx.notified, 1);
});

test("a write failing after a rename still reports the failure", async () => {
  const h = await harness();
  const saving = h.editor.save(h.cx);
  h.editor.path = "/synthetic/renamed.txt";
  fake.files["/synthetic/renamed.txt"] = "original";
  h.writes[0].reject(new Error("synthetic write failure"));
  await saving;
  assert.match(h.editor.note, /synthetic write failure/);
});

test("the Saved note's timer does nothing once the editor is closed", async () => {
  const h = await harness();
  const saving = h.editor.save(h.cx);
  h.writes[0].resolve();
  await saving;
  h.editor.close();
  const before = h.cx.notified;
  h.cx.timers.find((t) => t.once).fn(h.cx);
  assert.equal(h.cx.notified, before);
});

test("Keep mine waits for an active save without changing its base", async () => {
  const h = await harness();
  const first = h.editor.save(h.cx);
  h.editor.disk = "external text";
  const keep = h.editor.keepMine(h.cx);
  assert.equal(h.editor.base, "original");
  assert.equal(h.writes.length, 1);
  h.writes[0].resolve();
  await Promise.all([first, keep]);
  assert.equal(h.writes.length, 1, "the save settled the conflict and nothing newer was typed");
});

test("Keep mine during a save that hits a conflict writes over the disk text afterwards", async () => {
  const h = await harness();
  const first = h.editor.save(h.cx);
  const keep = h.editor.keepMine(h.cx);
  fake.files[PATH] = "external";
  h.writes[0].reject(new Error("changed"));
  await first;
  await flush();
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].expected, "external");
  h.writes[1].resolve();
  await keep;
  assert.equal(h.editor.dirty, false);
});

test("Reload during a save that hits a conflict takes the disk text afterwards", async () => {
  const h = await harness();
  const first = h.editor.save(h.cx);
  const reload = h.editor.reload(h.cx);
  fake.files[PATH] = "external";
  h.writes[0].reject(new Error("changed"));
  await Promise.all([first, reload]);
  assert.equal(h.editor.state.value(), "external");
  assert.equal(h.editor.dirty, false);
  assert.equal(h.editor.disk, undefined);
});

test("Reload during a save keeps text typed while it waited", async () => {
  const h = await harness();
  const first = h.editor.save(h.cx);
  const reload = h.editor.reload(h.cx);
  h.type("typed while waiting");
  fake.files[PATH] = "external";
  h.writes[0].reject(new Error("changed"));
  await Promise.all([first, reload]);
  assert.equal(h.editor.state.value(), "typed while waiting");
  assert.equal(h.editor.disk, "external");
});

test("a watcher read from before a save cannot raise a conflict after it", async () => {
  const stale = deferred(), reads = [stale.promise, Promise.resolve("first edit")];
  const h = await harness(() => reads.shift());
  const watching = h.editor.changedOnDisk(h.cx);
  const saving = h.editor.save(h.cx);
  h.type("newer edit");
  h.writes[0].resolve();
  await saving;
  stale.resolve("original");
  await watching;
  assert.equal(h.editor.disk, undefined);
  assert.equal(h.editor.dirty, true);
});

test("an outside change during a write shows a conflict after it, over newer typing", async () => {
  const h = await harness(async () => "external");
  const saving = h.editor.save(h.cx);
  h.type("newer edit");
  await h.editor.changedOnDisk(h.cx);
  h.writes[0].resolve();
  await saving;
  assert.equal(h.editor.disk, "external");
  assert.equal(h.editor.state.value(), "newer edit");
});

test("an outside change during a write reloads a clean editor after it", async () => {
  const h = await harness(async () => "external");
  const saving = h.editor.save(h.cx);
  await h.editor.changedOnDisk(h.cx);
  h.writes[0].resolve();
  await saving;
  assert.equal(h.editor.state.value(), "external");
  assert.equal(h.editor.dirty, false);
});

test("the watcher seeing this editor's own save changes nothing", async () => {
  const h = await harness(async () => "first edit");
  const saving = h.editor.save(h.cx);
  h.type("newer edit");
  await h.editor.changedOnDisk(h.cx);
  h.writes[0].resolve();
  await saving;
  assert.equal(h.editor.disk, undefined);
  assert.equal(h.editor.state.value(), "newer edit");
});

test("a load preserves edits typed while its read is pending and shows the disk conflict", async () => {
  const h = await harness(), read = deferred();
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
  const h = await harness(), first = deferred(), second = deferred();
  h.editor.dirty = false;
  const a = h.editor.load(h.cx, () => first.promise);
  const b = h.editor.load(h.cx, () => second.promise);
  second.resolve("newest disk");
  await b;
  first.resolve("stale disk");
  await a;
  assert.equal(h.editor.state.value(), "newest disk");
  assert.equal(h.editor.base, "newest disk");
  assert.equal(h.cx.notified, 1);
});

test("closing during a load cannot recreate released state or notify", async () => {
  const h = await harness(), read = deferred();
  const loading = h.editor.load(h.cx, () => read.promise);
  h.editor.close();
  read.resolve("disk");
  await loading;
  assert.equal(h.editor.state, null);
  assert.equal(h.cx.notified, 0);
});

test("a load started during a save reads nothing and changes nothing", async () => {
  const h = await harness();
  let reads = 0;
  const saving = h.editor.save(h.cx);
  await h.editor.load(h.cx, async () => { reads++; return "old disk"; });
  assert.equal(reads, 0);
  assert.equal(h.editor.state.value(), "first edit");
  assert.equal(h.editor.base, "original");
  h.writes[0].resolve();
  await saving;
  assert.equal(h.editor.base, "first edit");
});

test("Edit clicked during a load keeps the editor from being replaced", async () => {
  const h = await harness(), read = deferred();
  h.editor.editing = false;
  h.editor.dirty = false;
  const loading = h.editor.load(h.cx, () => read.promise);
  h.editor.edit(h.cx);
  read.resolve("disk version");
  await loading;
  assert.equal(h.editor.state.value(), "first edit");
  assert.equal(h.editor.disk, "disk version");
});

test("closing during a failed save leaves no note or conflict", async () => {
  const read = deferred(), h = await harness(() => read.promise);
  const saving = h.editor.save(h.cx);
  h.writes[0].reject(new Error("synthetic write failure"));
  await flush();
  h.editor.close();
  read.resolve("external");
  await saving;
  assert.equal(h.editor.note, null);
  assert.equal(h.editor.disk, undefined);
  assert.equal(h.cx.notified, 0);
});

test("a read started before a completed save cannot roll it back", async () => {
  const h = await harness(), read = deferred();
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
  const read = deferred(), h = await harness(() => read.promise);
  const loading = h.editor.reload(h.cx);
  read.resolve("selected disk");
  await loading;
  assert.equal(h.editor.state.value(), "selected disk");
  assert.equal(h.editor.base, "selected disk");
  assert.equal(h.editor.dirty, false);
});

test("explicit Reload preserves edits typed after the click", async () => {
  const read = deferred(), h = await harness(() => read.promise);
  const loading = h.editor.reload(h.cx);
  h.type("after Reload");
  read.resolve("selected disk");
  await loading;
  assert.equal(h.editor.state.value(), "after Reload");
  assert.equal(h.editor.dirty, true);
  assert.equal(h.editor.disk, "selected disk");
});

test("Reload also preserves edits undone to the initial value during its read", async () => {
  const read = deferred(), h = await harness(() => read.promise);
  const loading = h.editor.reload(h.cx);
  h.type("temporary edit");
  h.type("first edit");
  read.resolve("selected disk");
  await loading;
  assert.equal(h.editor.state.value(), "first edit");
  assert.equal(h.editor.dirty, true);
  assert.equal(h.editor.disk, "selected disk");
});

test("a successful reload clears a note about an earlier failed one", async () => {
  const h = await harness(async () => { throw new Error("transient"); });
  await h.editor.reload(h.cx);
  assert.match(h.editor.note, /edits were kept/);
  fake.read = async () => "fine";
  await h.editor.reload(h.cx);
  assert.equal(h.editor.state.value(), "fine");
  assert.equal(h.editor.note, null);
});

test("a failed superseded read cannot replace the newer result with an error", async () => {
  const h = await harness(), first = deferred(), second = deferred();
  h.editor.dirty = false;
  const a = h.editor.load(h.cx, () => first.promise);
  const b = h.editor.load(h.cx, () => second.promise);
  second.resolve("newest disk");
  await b;
  first.reject(new Error("stale read"));
  await a;
  assert.equal(h.editor.state.value(), "newest disk");
  assert.equal(h.editor.error, null);
  assert.equal(h.cx.notified, 1);
});

test("a failed read after close does not notify or restart watching", async () => {
  const h = await harness(), read = deferred();
  let watched = false;
  h.editor.watch = () => { watched = true; };
  const loading = h.editor.load(h.cx, () => read.promise);
  h.editor.close();
  read.reject(new Error("closed read"));
  await loading;
  assert.equal(h.cx.notified, 0);
  assert.equal(watched, false);
});

test("an automatic load never discards edits that were already dirty", async () => {
  const h = await harness();
  await h.editor.load(h.cx, async () => "external");
  assert.equal(h.editor.state.value(), "first edit");
  assert.equal(h.editor.dirty, true);
  assert.equal(h.editor.disk, "external");
});
