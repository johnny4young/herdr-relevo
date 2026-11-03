// The quick replies popup on a fake app: what it sends, and to whom.
import "./fake/register.mjs";
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake, calls } from "./fake/herdr.mjs";
import { fakeCx, find, click, flush } from "./fake/ui.mjs";

const { QuickReplies, openReplies, replies } = await import("../replies.js");
const { CONTEXTS } = await import("../config.js");
const SEND = /^hc send/;

beforeEach(() => {
  resetFake();
  fake.agents = [{ address: "t1", tab_name: "api", focused: true }, { address: "t2", tab_name: "web", focused: false }];
  fake.props = { address: "t2", name: "web" };
});

test("the shortcut opens the menu for the focused agent, and says so when none is", async () => {
  await openReplies();
  assert.equal(fake.overlays.at(-1).props.address, "t1");
  fake.agents = [];
  await openReplies();
  assert.equal(fake.notices.at(-1).title, "No agent in focus");
});

test("a click sends that reply without --force, so a question on screen is never answered by it", async () => {
  const view = new QuickReplies(), cx = fakeCx();
  view.init({}, cx);
  click(find(view.render(cx), "reply-0"), cx);
  await flush();
  assert.deepEqual(calls(SEND), [`hc send t2 ${replies()[0]}`]);
  assert.equal(fake.notices.at(-1).title, "Sent to web");
});

test("a refused send says why and can be tried again", async () => {
  fake.exec = (cmd) => (cmd === "hc" ? { code: 1, stderr: "t2 is blocked\nmore" } : null);
  const view = new QuickReplies(), cx = fakeCx();
  view.init({}, cx);
  click(find(view.render(cx), "reply-1"), cx);
  await flush();
  assert.equal(fake.notices.at(-1).body, "t2 is blocked");
  assert.equal(view.sending, false);
});

const press = (view, cx, key, extra = {}) => view.key({ key, modifiers: {}, ...extra }, cx);

test("the keyboard picks a reply: arrows and Enter, or its number", async () => {
  const view = new QuickReplies(), cx = fakeCx();
  view.init({}, cx);
  press(view, cx, "down");
  press(view, cx, "down");
  press(view, cx, "up");
  press(view, cx, "enter");
  await flush();
  press(view, cx, "3");
  await flush();
  assert.deepEqual(calls(SEND), [`hc send t2 ${replies()[1]}`, `hc send t2 ${replies()[2]}`]);
});

test("a held modifier or a number past the list sends nothing, and typing moves to the field", async () => {
  const view = new QuickReplies(), cx = fakeCx();
  view.init({}, cx);
  press(view, cx, "1", { modifiers: { platform: true } });
  press(view, cx, "9");
  press(view, cx, "h", { key_char: "h" });
  await flush();
  assert.deepEqual(calls(SEND), []);
  assert.equal(view.input.value(), "h");
});

const USAGE = "/home/test/.local/state/relevo/replies.json";

test("the menu lists saved replies by use, then what this context keeps typing, and a send counts", async (t) => {
  // Past the hour the history is kept for, whatever earlier tests read.
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 2 * 3600e3 });
  t.after(() => mock.timers.reset());
  const at = Date.now() - 3600e3, said = (display, project) => JSON.stringify({ display, timestamp: at, project });
  const history = [...Array(3)].flatMap(() => [said("open the PR now", "/p/app"), said("work only thing", "/w/acme-api")]);
  fake.exec = (cmd, args) => (cmd === "sh" && args.some((a) => a.endsWith("history.jsonl")) ? { stdout: history.join("\n") } : null);
  fake.stored["space-folders"] = { "": { list: [{ id: CONTEXTS[1].key, match: "acme-api" }] } };
  fake.panes = [{ pane: "p1", cwd: "/p/app" }];
  fake.agents = [{ address: "t1", tab_name: "api", focused: true, pane: "p1" }];
  const [first, second] = replies();
  fake.files[USAGE] = JSON.stringify({ [second.toLowerCase().replace(/[.!?…]+$/, "")]: { score: 2, at: Date.now() } });
  await openReplies();
  const list = fake.overlays.at(-1).props.replies;
  assert.deepEqual(list.slice(0, 2).map((r) => r.text), [second, first]);
  assert.deepEqual(list.filter((r) => r.uses).map((r) => r.text), ["open the PR now"]);
  fake.props = { address: "t1", name: "api", replies: list };
  const view = new QuickReplies(), cx = fakeCx();
  view.init({}, cx);
  click(find(view.render(cx), `reply-${list.length - 1}`), cx);
  await flush();
  click(find(view.render(cx), "reply-1"), cx);
  await flush();
  const stored = JSON.parse(fake.files[USAGE]);
  assert.deepEqual(Object.keys(stored).sort(), [first, second].map((r) => r.toLowerCase().replace(/[.!?…]+$/, "")).sort());
  assert.ok(stored[first.toLowerCase().replace(/[.!?…]+$/, "")].score >= 1);
});
