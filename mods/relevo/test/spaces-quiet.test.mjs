// Spaces: each repo's open PRs from Reviews, and spaces quiet for over a day folded away (never closed on their own).
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake } from "./fake/herdr.mjs";
import { fakeCx, find, flush, text } from "./fake/ui.mjs";

const { DAY_MS, buildModel, quietSpaces } = await import("../../relevo-spaces/model.js");
const { default: Spaces } = await import("../../relevo-spaces/main.js");
const { Inbox } = await import("../inbox.js");
const { focusInbox } = await import("../inbox-keys.js");

beforeEach(() => {
  resetFake();
  for (const k of ["opened", "closed", "touched"]) localStorage.removeItem(k);
});

const NOW = 2_000_000_000_000;
const space = (id, name, cwd, over = {}) => ({ id, name, folder: cwd, machine: null, active: false, status: null, tabs: [{ id: `tb-${id}` }], ...over });
const EMPTY = { agents: [], sessions: [], terminals: [], servers: [] };

test("a space is quiet after a day with nothing running, asking, changed, listening or waiting on you in Reviews", () => {
  const rows = [space("a", "a"), space("b", "b"), space("c", "c", null, { status: "working" }), space("d", "d")].map((w) => ({ w, g: { name: w.name, changed: w.id === "d" ? 2 : 0 } }));
  const touched = { a: NOW - 2 * DAY_MS, b: NOW - 2 * DAY_MS, c: NOW - 2 * DAY_MS, d: NOW - 2 * DAY_MS };
  const by = new Map([["b", { ...EMPTY, terminals: [{ state: "idle", ports: [3000] }] }]]);
  const { quiet, changed } = quietSpaces(rows, by, { touched, now: NOW });
  assert.deepEqual([...quiet], ["a"]);
  assert.deepEqual(changed.sort(), ["b", "c", "d"]);
  assert.equal(touched.c, NOW);
  const prs = quietSpaces([rows[0]], new Map(), { touched: { a: NOW - 2 * DAY_MS }, now: NOW, prs: { a: { open: 1, me: 1 } } });
  assert.equal(prs.quiet.size, 0, "a PR that needs you keeps its repo in sight");
});

test("a space seen for the first time counts from its newest terminal", () => {
  const touched = {};
  const r = quietSpaces([{ w: space("a", "a"), g: null }], new Map(), { touched, now: NOW, firstSeen: () => NOW - 3 * DAY_MS });
  assert.deepEqual([...r.quiet], ["a"]);
  const fresh = quietSpaces([{ w: space("b", "b"), g: null }], new Map(), { touched, now: NOW, firstSeen: () => NOW - 3600e3 });
  assert.equal(fresh.quiet.size, 0);
});

test("quiet spaces go last in their folder, so ⌃1…⌃9 count the rows shown", () => {
  const spaces = [space("a", "a", "/home/test/a"), space("b", "b", "/home/test/b"), space("c", "c", "/home/test/c")];
  const m = buildModel({ spaces, panes: [], folders: { list: [{ id: "p", name: "P", match: "~" }], of: {} }, quiet: new Set(["a"]) });
  assert.deepEqual(m.order, ["b", "c", "a"]);
  assert.deepEqual(m.groups[0].rows.map((r) => [r.w.id, r.quiet]), [["b", false], ["c", false], ["a", true]]);
});

async function open(spaces, { prs = {}, touched = {} } = {}) {
  fake.spaces = spaces;
  fake.stored["space-folders"] = { "": { list: [{ id: "p", name: "Personal", color: "ansi2", match: "~" }], of: {} } };
  fake.stored["relevo.repoPRs"] = prs;
  localStorage.setItem("touched", JSON.stringify(touched));
  fake.exec = (cmd, args, options) => {
    const a = args.join(" "), cwd = options?.cwd ?? "";
    if (a.includes("--show-toplevel")) return { stdout: `${cwd}\n` };
    if (a.includes("--git-common-dir")) return { stdout: `${cwd}/.git\n` };
    if (a.includes("status")) return { stdout: "# branch.head main\n# branch.ab +0 -0\n" };
    return null;
  };
  const mod = new Spaces(), cx = fakeCx();
  mod.init({}, cx);
  cx.fire(500);
  await flush();
  return { mod, cx, ui: () => mod.render(cx) };
}

test("a repo's open PRs show on its row, red when one needs you, and a click opens Reviews on them", async () => {
  const { cx, ui } = await open([space("a", "acme-api", "/home/test/code/acme-api", { active: true }), space("b", "blog", "/home/test/code/blog")],
    { prs: { "acme-api": { open: 3, me: 1 }, blog: { open: 1, me: 0 } } });
  const chip = find(ui(), "prs-a");
  assert.match(text(chip), /3/);
  assert.equal(chip.ink, "#blocked");
  assert.equal(find(ui(), "prs-b").ink, "#dim");
  chip.handlers.on_click({}, cx);
  assert.deepEqual(fake.runs.at(-1), ["relevo.reviews-for-acme-api", undefined]);
});

test("quiet spaces go last under one line, shown until you fold it, and close only on a second click", async () => {
  const old = Date.now() - 2 * DAY_MS;
  const { cx, ui } = await open([space("a", "api", "/home/test/code/api", { active: true }), space("b", "blog", "/home/test/code/blog"), space("c", "notes", "/home/test/code/notes")],
    { touched: { a: old, b: old, c: old } });
  assert.match(text(find(ui(), "quiet-p")), /2 quiet for over a day close 2/);
  assert.ok(find(ui(), "space-b"), "quiet spaces are shown");
  assert.ok(find(ui(), "space-a"), "the space you are in is never quiet");
  find(ui(), "quiet-p").handlers.on_click({}, cx);
  assert.equal(find(ui(), "space-b"), null);
  find(ui(), "quiet-p").handlers.on_click({}, cx);
  assert.ok(find(ui(), "space-b"));
  find(ui(), "quiet-p-close").handlers.on_click({}, cx);
  assert.equal(fake.runs.filter(([n]) => n === "space.close").length, 0);
  assert.match(text(find(ui(), "quiet-p-close")), /Close 2\?/);
  find(ui(), "quiet-p-close").handlers.on_click({}, cx);
  assert.deepEqual(fake.runs.filter(([n]) => n === "space.close").map(([, a]) => a), [{ id: "b", confirmed: true }, { id: "c", confirmed: true }]);
});

test("Reviews publishes open PRs by repo, and a request to show one repo fills the filter", async () => {
  const inbox = new Inbox();
  inbox.filterField = { value: () => inbox.q ?? "", set_value: (v) => { inbox.q = v; } };
  inbox.publishRepoPRs([{ id: "pr-1", repo: "me/acme-api", turn: "me" }, { id: "pr-2", repo: "me/acme-api", turn: "flight" }, { id: "in-x", turn: "me" }]);
  assert.deepEqual(fake.stored["relevo.repoPRs"], { "acme-api": { open: 2, me: 1 } });
  focusInbox(null, "acme-api");
  inbox.h = { focus() {} };
  inbox.takeFocus(fakeCx());
  assert.equal(inbox.q, "acme-api");
  await flush();
});

test("close N disarms after a few seconds, and when the quiet spaces change", async () => {
  const old = Date.now() - 2 * DAY_MS;
  const { mod, cx, ui } = await open([space("a", "api", "/home/test/code/api", { active: true }), space("b", "blog", "/home/test/code/blog"), space("c", "notes", "/home/test/code/notes")],
    { touched: { a: old, b: old, c: old } });
  const closes = () => fake.runs.filter(([n]) => n === "space.close").length;
  find(ui(), "quiet-p-close").handlers.on_click({}, cx);
  mod.armedAt -= 5000;
  assert.match(text(find(ui(), "quiet-p-close")), /^close 2$/, "a late second click finds it disarmed");
  find(ui(), "quiet-p-close").handlers.on_click({}, cx);
  assert.equal(closes(), 0);
  mod.armedIds = ["b"];
  find(ui(), "quiet-p-close").handlers.on_click({}, cx);
  assert.equal(closes(), 0, "armed on other spaces, so this click arms again");
  find(ui(), "quiet-p-close").handlers.on_click({}, cx);
  assert.equal(closes(), 2);
});
