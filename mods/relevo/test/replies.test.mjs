// The quick replies popup on a fake app: what it sends, and to whom.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake, calls } from "./fake/herdr.mjs";
import { fakeCx, find, click, flush } from "./fake/ui.mjs";

const { QuickReplies, openReplies, replies } = await import("../replies.js");
const SEND = /^hc send/;

beforeEach(() => {
  resetFake();
  fake.agents = [{ address: "t1", tab_name: "api", focused: true }, { address: "t2", tab_name: "web", focused: false }];
  fake.props = { address: "t2", name: "web" };
});

test("the shortcut opens the menu for the focused agent, and says so when none is", () => {
  openReplies();
  assert.equal(fake.overlays.at(-1).props.address, "t1");
  fake.agents = [];
  openReplies();
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
