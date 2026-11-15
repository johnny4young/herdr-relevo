// The keys that work on Reviews' rows and lists, and in the review pane.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake, calls } from "./fake/herdr.mjs";
import { fakeCx, find, text, flush } from "./fake/ui.mjs";

const { Inbox } = await import("../inbox.js");
const { GOAL_MODE } = await import("../inbox-goals.js");

const NOW = new Date().toISOString();
const url = (n) => `https://github.com/acme/app/pull/${n}`;
const pr = (n, extra = {}) => ({ url: url(n), number: n, repo: "acme/app", title: `PR ${n}`, reasons: ["CI failing"], skills: [], updatedAt: NOW, ...extra });

beforeEach(() => {
  resetFake();
  fake.exec = (cmd) => (cmd === "gh"
    ? { stdout: JSON.stringify({ data: { viewer: { login: "me", merged: { nodes: [] }, pullRequests: { nodes: [] } }, search: { nodes: [] } } }) }
    : null);
});

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
  const row = find(inbox.render(cx), `pr-${url(1)}`);
  const pairs = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    const kids = n.items ?? [];
    if (kids.length === 2 && typeof kids[1]?.key === "string" && text(kids[0]).length === 1) pairs.push([text(kids[0]), kids[1].key]);
    kids.forEach(walk);
  };
  walk(row);
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
  assert.match(text(find(inbox.render(cx), "list-keys")), /^j k move do the action m maintenance \? all keys$/);
  fake.stored["relevo.inbox.view"] = "maintenance";
  assert.match(text(find(inbox.render(cx), "list-keys")), /n now/);
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
