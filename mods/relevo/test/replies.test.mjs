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
