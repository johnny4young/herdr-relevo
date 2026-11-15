// The keys that work on Reviews' rows and lists, and in the review pane.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake, calls, theme } from "./fake/herdr.mjs";
import { fakeCx, find, text, flush } from "./fake/ui.mjs";

const { Inbox } = await import("../inbox.js");
const { GOAL_MODE } = await import("../inbox-goals.js");
const { keysOf } = await import("../ui.js");

const NOW = new Date().toISOString();
const url = (n) => `https://github.com/acme/app/pull/${n}`;
const pr = (n, extra = {}) => ({ url: url(n), number: n, repo: "acme/app", title: `PR ${n}`, reasons: ["CI failing"], skills: [], updatedAt: NOW, ...extra });

beforeEach(() => {
  resetFake();
  fake.exec = (cmd) => (cmd === "gh"
    ? { stdout: JSON.stringify({ data: { viewer: { login: "me", merged: { nodes: [] }, pullRequests: { nodes: [] } }, search: { nodes: [] } } }) }
    : null);
});

// [keycap, button id] for each keycap drawn beside a button.
function capPairs(node, pairs = []) {
  if (!node || typeof node !== "object") return pairs;
  const kids = node.items ?? [];
  if (kids.length === 2 && typeof kids[1]?.key === "string" && text(kids[0]).length === 1) pairs.push([text(kids[0]), kids[1].key]);
  kids.forEach((k) => capPairs(k, pairs));
  return pairs;
}

async function open(prs = [pr(1), pr(2), pr(3)]) {
  const inbox = new Inbox(), cx = fakeCx();
  inbox.init({}, cx);
  await flush();
  inbox.mine = prs;
  inbox.h.is_focused = () => true;
  inbox.render(cx);
  const key = (k) => { inbox.navKey({ key: k }, cx); return inbox.render(cx); };
  return { inbox, cx, key };
}

test("j and k move like the arrows; g g goes to the top and G to the bottom", async () => {
  const { inbox, key } = await open();
  key("j");
  assert.equal(inbox.sel, `pr-${url(1)}`);
  key("j");
  assert.equal(inbox.sel, `pr-${url(2)}`);
  key("k");
  assert.equal(inbox.sel, `pr-${url(1)}`);
  key("G");
  assert.equal(inbox.sel, `pr-${url(3)}`);
  key("g");
  assert.equal(inbox.sel, `pr-${url(3)}`, "one g waits for the second");
  key("g");
  assert.equal(inbox.sel, `pr-${url(1)}`);
  key("G");
  key("g");
  key("k");
  key("g");
  assert.equal(inbox.sel, `pr-${url(2)}`, "a key between the two g starts over");
});

test("on a selected PR, o opens it, a marks it addressed and u takes that back", async () => {
  const { inbox, key } = await open();
  inbox.sel = `pr-${url(2)}`;
  key("o");
  assert.equal(calls(new RegExp(`^open ${url(2)}$`)).length, 1);
  key("a");
  assert.ok(inbox.addressed[url(2)], "a marks the selected PR addressed");
  key("u");
  assert.equal(inbox.addressed[url(2)], undefined, "u brings it back");
});

test("the selected row shows each action's key beside its button", async () => {
  const { inbox, cx } = await open();
  inbox.clones = { "acme/app": "/w/app" };
  inbox.sel = `pr-${url(1)}`;
  const pairs = capPairs(find(inbox.render(cx), `pr-${url(1)}`));
  assert.deepEqual(pairs.find(([, id]) => id === `open-${url(1)}`), ["o", `open-${url(1)}`]);
  assert.deepEqual(pairs.find(([, id]) => id === `addressed-${url(1)}`), ["a", `addressed-${url(1)}`]);
});

test("/ opens a filter that narrows Now to matching rows; Esc clears it", async () => {
  const { inbox, cx, key } = await open([pr(1, { title: "Retry payments" }), pr(2, { title: "Invoice rounding" })]);
  key("/");
  assert.equal(inbox.filtering, true);
  assert.ok(find(inbox.render(cx), "inbox-filter"));
  inbox.filterField.type("invoice", cx);
  const tree = inbox.render(cx);
  assert.ok(find(tree, `pr-${url(2)}`));
  assert.equal(find(tree, `pr-${url(1)}`), null);
  key("escape");
  assert.equal(inbox.filtering, false);
  assert.ok(find(inbox.render(cx), `pr-${url(1)}`));
});

test("each list says its keys at its foot", async () => {
  const { inbox, cx } = await open();
  assert.match(text(find(inbox.render(cx), "list-keys")), /^j k move do the action tab maintenance \? keys$/);
  fake.stored["relevo.inbox.view"] = "maintenance";
  assert.match(text(find(inbox.render(cx), "list-keys")), /tab now/);
  fake.stored[GOAL_MODE] = true;
  assert.match(text(find(inbox.render(cx), "list-keys")), /open the run n new run/);
});

test("the review pane: c comments on the file, v marks it viewed, ] and [ move between files", async () => {
  const { ReviewDiff } = await import("../review.js");
  const v = new ReviewDiff(), cx = fakeCx();
  v.init({}, cx);
  v.key = "/demo"; v.root = "/demo";
  v.files = [{ path: "a.ts", add: 1, del: 0 }, { path: "b.ts", add: 2, del: 0 }];
  v.open = v.files[0];
  v.hashes = new Map(v.files.map((f) => [f.path, `h-${f.path}`]));
  let picked = null;
  v.pick = async (f) => { picked = f.path; };
  v.handleKey({ key: "]", modifiers: {} }, cx);
  await flush();
  assert.equal(picked, "b.ts");
  v.handleKey({ key: "v", modifiers: {} }, cx);
  assert.equal(v.viewed("a.ts"), true);
  v.handleKey({ key: "c", modifiers: {} }, cx);
  assert.equal(v.editing, "file");
  picked = null;
  v.handleKey({ key: "[", modifiers: {} }, cx);
  assert.equal(picked, null, "keys wait while a comment is open");
});

test("each row's keycaps are the keys its table answers", async () => {
  const { inbox } = await open();
  const t = theme(), caps = (id, card) => {
    inbox.sel = id;
    return capPairs(card()).map(([k]) => k).sort();
  };
  const draft = pr(7), desk = { id: "s1", project: "app", state: "review", at: 0 };
  const local = { kind: "diff", agent: { address: "t1", pane: "p1" }, repo: "app", top: "/w/app", files: 1, add: 1, del: 0, at: 0 };
  const landing = { repo: "acme/app", number: 8, title: "x", phase: "failed", failed: { url: "https://github.com/acme/app/actions/runs/1" }, at: 0 };
  for (const [id, card, table] of [
    [`pr-${draft.url}`, () => inbox.draftCard(t, draft), () => inbox.draftActions(draft)],
    ["dk-s1", () => inbox.desktopCard(t, desk), () => inbox.desktopActions(desk)],
    ["in-t1", () => inbox.localCard(t, local), () => inbox.localActions(local)],
    [`land-${url(8)}`, () => inbox.landCard(t, url(8), landing), () => inbox.landActions(url(8), landing)],
  ]) assert.deepEqual(caps(id, card), Object.keys(keysOf(table())).sort(), id);
  assert.deepEqual(Object.keys(keysOf(inbox.localActions(local))).sort(), ["a", "o", "r"]);
  assert.deepEqual(Object.keys(keysOf(inbox.desktopActions(desk))).sort(), ["a", "o"]);
  assert.deepEqual(Object.keys(keysOf(inbox.draftActions(draft))), ["o"]);
  assert.deepEqual(Object.keys(keysOf(inbox.landActions(url(8), landing))), ["o"], "✓ on a landing only clears it");
});

test("the ? sheet lists the review pane's keys too", async () => {
  const { inbox, cx } = await open();
  inbox.goalHelp = true;
  assert.ok(find(inbox.render(cx), "shortcut-help-review.comment"));
});

test("the filter narrows the list but never the badge, and only Now opens it", async () => {
  const { COUNT } = await import("../toolbar.js");
  const { inbox, cx, key } = await open([pr(1, { title: "Retry payments" }), pr(2, { title: "Invoice rounding" })]);
  const before = fake.stored[COUNT];
  key("/");
  inbox.filterField.type("invoice", cx);
  inbox.render(cx);
  assert.equal(fake.stored[COUNT], before);
  inbox.filterField.type("github", cx);
  assert.equal(find(inbox.render(cx), `pr-${url(2)}`), null, "a row's URL is not its words");
  key("escape");
  fake.stored["relevo.inbox.view"] = "maintenance";
  key("/");
  assert.equal(inbox.filtering, false, "/ does nothing in Maintenance");
});

test("a click on a row while filtering gives the keys back to the list", async () => {
  const { inbox, cx, key } = await open();
  key("/");
  inbox.pick(`pr-${url(1)}`, cx);
  key("j");
  assert.equal(inbox.sel, `pr-${url(2)}`);
});

test("shift-g goes to the bottom, and a held l does not confirm a land", async () => {
  const { inbox, cx, key } = await open([pr(1), pr(2, { mergeStateStatus: "CLEAN" })]);
  inbox.navKey({ key: "g", modifiers: { shift: true } }, cx);
  assert.equal(inbox.sel, `pr-${url(2)}`);
  key("l");
  assert.ok(inbox.arming, "the first l arms");
  inbox.navKey({ key: "l", is_held: true }, cx);
  assert.ok(inbox.arming, "a repeat leaves it armed");
});

test("] moves on after the file list is read again with the same files", async () => {
  const { ReviewDiff } = await import("../review.js");
  const v = new ReviewDiff(), cx = fakeCx();
  v.init({}, cx);
  v.files = [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }];
  v.open = { path: "b.ts" };
  let picked = null;
  v.pick = async (f) => { picked = f.path; };
  v.handleKey({ key: "]", modifiers: {} }, cx);
  await flush();
  assert.equal(picked, "c.ts");
});
