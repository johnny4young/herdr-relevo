// The folders file: one that can't be read is never saved over, and a failed save says so.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake } from "./fake/herdr.mjs";

const { loadFolders, updateFolders, folderData, KEY } = await import("../../relevo-spaces/folders.js");
const { default: Spaces } = await import("../../relevo-spaces/main.js");
const { fakeCx } = await import("./fake/ui.mjs");

beforeEach(() => resetFake());
const saves = () => fake.execs.filter((e) => e.includes("mktemp"));

test("no file yet loads empty and saves", async () => {
  fake.exec = (cmd, args) => (args.join(" ").includes("cat ") ? { code: 3 } : null);
  assert.deepEqual((await loadFolders()).list, []);
  await updateFolders((d) => ({ ...d, list: [{ id: "a", name: "A" }] }));
  assert.equal(saves().length, 1);
  assert.equal(fake.notices.length, 0);
});

for (const [what, answer, reason] of [
  ["not valid JSON", { stdout: "{ list: oops" }, /not valid JSON/],
  ["unreadable", { code: 1, stderr: "cat: herdr-space-folders.json: Permission denied" }, /Permission denied/],
]) {
  test(`a folders file that is ${what} is never saved over`, async () => {
    fake.exec = (cmd, args) => (args.join(" ").includes("cat ") ? answer : null);
    await loadFolders();
    assert.match(fake.notices[0].body, reason);
    await updateFolders((d) => ({ ...d, list: [{ id: "a", name: "A" }] }));
    assert.equal(saves().length, 0);
    assert.match(fake.notices.at(-1).title, /didn't save/);
    // Once it reads again, saving works.
    fake.exec = (cmd, args) => (args.join(" ").includes("cat ") ? { stdout: JSON.stringify({ list: [{ id: "w", name: "Work" }], of: {} }) } : null);
    assert.deepEqual((await loadFolders()).list.map((f) => f.id), ["w"]);
    await updateFolders((d) => d);
    assert.equal(saves().length, 1);
  });
}

test("a save that fails says so", async () => {
  fake.stored[KEY] = { "": { list: [], of: {}, at: 0 } };
  fake.exec = (cmd, args) => (args.join(" ").includes("mktemp") ? { code: 1, stderr: "No space left on device" } : null);
  await updateFolders((d) => ({ ...d, list: [{ id: "a", name: "A" }] }));
  assert.equal(folderData().list[0].id, "a");
  assert.match(fake.notices.at(-1).body, /No space left on device/);
});

test("a stored value that no longer parses doesn't break the sidebar", () => {
  localStorage.setItem("closed", "[oops");
  localStorage.setItem("touched", "{");
  fake.stored[KEY] = { "": { list: [], of: {}, at: 0 } };
  const mod = new Spaces();
  mod.init({}, fakeCx());
  assert.deepEqual([...mod.closed], []);
  assert.deepEqual(mod.touched, {});
  localStorage.removeItem("closed");
  localStorage.removeItem("touched");
});
