// Spaces reads git a few places at a time, looks at quiet spaces less often, and forgets what no space shows.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import { fake, resetFake, calls } from "./fake/herdr.mjs";
import { fakeCx, flush } from "./fake/ui.mjs";

const { default: Spaces } = await import("../../relevo-spaces/main.js");
const { where } = await import("../../relevo-spaces/model.js");

beforeEach(() => {
  resetFake();
  for (const k of ["opened", "closed", "touched"]) localStorage.removeItem(k);
});

const space = (id) => ({ id, name: id, folder: `/home/test/code/${id}`, machine: null, active: false, status: null, tabs: [{ id: `tb-${id}` }] });
let active = 0, most = 0;
async function open(ids) {
  fake.spaces = ids.map(space);
  fake.stored["space-folders"] = { "": { list: [{ id: "p", name: "P", match: "~" }], of: {} } };
  active = 0; most = 0;
  fake.exec = async (cmd, args, options) => {
    const a = args.join(" "), cwd = options?.cwd ?? "";
    active += 1; most = Math.max(most, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    if (a.includes("--show-toplevel")) return { stdout: `${cwd}\n` };
    if (a.includes("--git-common-dir")) return { stdout: `${cwd}/.git\n` };
    if (a.includes("symbolic-ref")) return { stdout: "refs/heads/main\n" };
    if (a.includes("rev-list")) return { stdout: "0\t0\n" };
    return { stdout: "" };
  };
  const mod = new Spaces(), cx = fakeCx();
  mod.init({}, cx);
  cx.fire(500);
  for (let i = 0; i < 20; i += 1) await flush();
  return { mod, cx };
}
const statusReads = () => calls(/ status --porcelain/).length;
const settle = async () => { for (let i = 0; i < 20; i += 1) await flush(); };

test("the first look reads at most four places at once", async () => {
  await open(["a", "b", "c", "d", "e", "f", "g", "h"]);
  assert.equal(statusReads(), 8);
  assert.ok(most <= 4 * 3, `at most four places, three reads each, at a time (saw ${most})`);
});

test("the once-a-minute look takes the two oldest places per tick, and a quiet space waits five minutes", async () => {
  const { mod, cx } = await open(["a", "b", "c", "d"]);
  const now = Date.now();
  for (const [i, k] of Object.keys(mod.checked).entries()) mod.checked[k] = now - 61000 - i * 1000;
  const before = statusReads();
  cx.fire(500); await settle();
  assert.equal(statusReads() - before, 2);
  const oldest = Object.keys(mod.checked).slice(-2);
  for (const k of oldest) assert.ok(now - mod.checked[k] < 5000, "the two oldest went first");
  for (const k of Object.keys(mod.checked)) mod.checked[k] = now - 120000;
  mod.quiet = new Set(["a", "b", "c"]);
  const again = statusReads();
  cx.fire(500); await settle();
  assert.equal(statusReads() - again, 1, "only the space that isn't quiet");
  assert.ok(now - mod.checked[where(fake.spaces[3], [])] < 5000);
});

test("a closed space's git and watch are let go", async () => {
  const { mod, cx } = await open(["a", "b"]);
  assert.equal(Object.keys(mod.git).length, 2);
  fake.spaces = [space("a")];
  cx.fire(500); await settle();
  assert.deepEqual(Object.keys(mod.git), [where(space("a"), [])]);
  mod.refreshGit(new Set([where(space("a"), [])]), cx); await settle();
  assert.deepEqual(fake.cancelledWatches, ["/home/test/code/b/.git"]);
  assert.deepEqual([...mod.watching.keys()], ["/home/test/code/a/.git"]);
});
