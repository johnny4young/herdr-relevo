// Desktop sessions in the Inbox, and what reaches macOS while Herdr is behind another app.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake, calls } from "./fake/herdr.mjs";
import { fakeCx, find, text, click, flush } from "./fake/ui.mjs";
import { desktopChanges, desktopLink, desktopSession, isSettled, showable } from "../lib/desktop.js";

const { Inbox } = await import("../inbox.js");
const { AgentWatch, clickCommand, prAlerts } = await import("../alerts.js");
const { DESKTOP, DesktopWatch } = await import("../desktop.js");

const NOW = 1_000_000;
const session = (over = {}) => ({ id: "local_1", title: "Fix login", project: "app", cwd: "/w/app", state: "blocked", at: NOW, needs: "Pick one", ...over });

beforeEach(() => resetFake());

test("a question keeps showing for days, a finished turn only while fresh", () => {
  const day = 86400;
  assert.equal(showable([session({ at: NOW - 3 * day })], NOW).length, 1);
  assert.equal(showable([session({ state: "review", at: NOW - 3 * day })], NOW).length, 0);
  assert.equal(showable([session({ state: "done" })], NOW).length, 0);
});

test("the first read says nothing, later ones what changed", () => {
  assert.deepEqual(desktopChanges(undefined, [session()]), []);
  assert.deepEqual(desktopChanges([session({ state: "working" })], [session()]).length, 1);
  assert.deepEqual(desktopChanges([session()], [session()]), []);
  assert.equal(desktopChanges([session({ state: "working" })], [session({ state: "review" })]).length, 1);
  assert.equal(desktopChanges([session({ state: "idle" })], [session({ state: "review" })]).length, 0);
});

test("a settled session comes back when it does something new", () => {
  const marks = { "desktop:local_1": NOW };
  assert.equal(isSettled(session(), marks), true);
  assert.equal(isSettled(session({ at: NOW + 5 }), marks), false);
  assert.equal(isSettled(session(), {}), false);
});

test("the link names the session", () => {
  assert.equal(desktopLink("local_a b"), "claude://code/continue?session=local_a%20b");
});

async function inbox() {
  const box = new Inbox(), cx = fakeCx();
  box.init({}, cx);
  await flush();
  return { box, cx, ui: () => box.render(cx) };
}

test("a waiting session shows in the Inbox and counts", async () => {
  fake.stored[DESKTOP] = [session({ at: Date.now() / 1000 })];
  const { ui } = await inbox();
  const shown = text(find(ui(), "dk-local_1"));
  assert.match(shown, /app · Fix login/);
  assert.match(shown, /Pick one/);
  assert.equal(fake.stored["relevo.inbox.count"], 1);
});

test("Open in Desktop uses the session's link", async () => {
  fake.stored[DESKTOP] = [session({ at: Date.now() / 1000 })];
  const { ui, cx } = await inbox();
  click(find(ui(), "dk-open-local_1"), cx);
  await flush();
  assert.equal(calls(/^open claude:\/\/code\/continue\?session=local_1/).length, 1);
});

test("marking one addressed folds it and frees the count", async () => {
  fake.stored[DESKTOP] = [session({ at: Date.now() / 1000 - 60 })];
  const { ui, cx } = await inbox();
  click(find(ui(), "dk-settle-local_1"), cx);
  await flush();
  assert.equal(find(ui(), "dk-local_1"), null);
  assert.equal(fake.stored["relevo.inbox.count"], 0);
  assert.ok(find(ui(), "addressed-desktop"));
  assert.deepEqual(fake.stored["relevo.desktop.settled"], ["local_1"]);
});

const FILE = "/home/test/Library/Application Support/Claude/claude-code-sessions/o/a/local_1.json";
const desktopFile = (over = {}) => {
  const now = Date.now();
  return JSON.stringify({ sessionId: "local_1", title: "Fix login", cwd: "/w/.herdr/worktrees/app/x", lastActivityAt: now,
    lastTurnEdgeAt: now, latestUserFrameAt: now - 1000, ...over });
};

test("the watch publishes sessions and tells of a new question", async () => {
  let mtime = 1;
  fake.exec = (cmd) => (cmd === "sh" ? { stdout: `${mtime} ${FILE}\n` } : null);
  const now = Date.now();
  fake.files[FILE] = desktopFile({ lastTurnEdgeAt: now - 5000, latestUserFrameAt: now - 100 });
  const watch = new DesktopWatch();
  await watch.tick();
  assert.equal(fake.stored[DESKTOP][0].state, "working");
  assert.equal(fake.notices.length, 0);
  mtime = 2;
  fake.files[FILE] = desktopFile({ postTurnSummary: { status_category: "blocked", needs_action: "Pick one" } });
  await watch.tick();
  assert.equal(fake.notices[0].title, "app needs you in Desktop");
  assert.equal(fake.stored[DESKTOP][0].needs, "Pick one");
});

test("an unchanged file isn't read again", async () => {
  fake.exec = (cmd) => (cmd === "sh" ? { stdout: `5 ${FILE}\n` } : null);
  let reads = 0;
  fake.read = (path) => {
    reads += 1;
    return path === FILE ? desktopFile() : null;
  };
  const watch = new DesktopWatch();
  await watch.tick();
  await watch.tick();
  assert.equal(reads, 1);
});

test("a session's state comes from its file", () => {
  const now = Date.now(), at = (over) => desktopSession(JSON.parse(desktopFile(over)), now)?.state;
  assert.equal(at({ postTurnSummary: { status_category: "review_ready" } }), "review");
  assert.equal(at({ postTurnSummary: { status_category: "completed" } }), "done");
  assert.equal(at({}), "idle");
  assert.equal(at({ lastTurnEdgeAt: now - 5000, latestUserFrameAt: now - 100 }), "working");
  const old = now - 3600000;
  assert.equal(at({ lastActivityAt: old, lastTurnEdgeAt: old - 5000, latestUserFrameAt: old }), "idle");
  assert.equal(at({ isArchived: true }), undefined);
  assert.equal(desktopSession(JSON.parse(desktopFile()), now).project, "app");
});

test("with Herdr behind another app an alert also goes to macOS", async () => {
  fake.window = { active: false };
  prAlerts([{ kind: "ci-failed", title: "CI failed · app #1", repo: "acme/app" }], () => "all");
  await flush();
  assert.equal(calls(/^osascript /).length, 1);
});

test("with Herdr in front the toast is enough", async () => {
  fake.window = { active: true };
  prAlerts([{ kind: "ci-failed", title: "CI failed · app #1", repo: "acme/app" }], () => "all");
  await flush();
  assert.equal(calls(/^osascript /).length, 0);
  assert.equal(fake.notices.length, 1);
});

test("an agent that starts asking reaches macOS once", async () => {
  fake.window = { active: false };
  const set = (status) => {
    fake.agents = [{ address: "t1", status, pane: "p1", tab_name: "fix", space_name: "app" }];
  };
  fake.panes = [{ pane: "p1", cwd: "/w/app" }];
  const watch = new AgentWatch();
  set("working");
  watch.tick();
  set("blocked");
  watch.tick();
  watch.tick();
  await flush();
  assert.equal(calls(/^osascript /).length, 1);
  assert.match(calls(/^osascript /)[0], /fix needs you/);
});

test("Reviews keeps Desktop requests without the redundant summary tiles", async () => {
  fake.stored[DESKTOP] = [session({ at: Date.now() / 1000 })];
  const { ui } = await inbox();
  assert.equal(find(ui(), "inbox-summary"), null);
  assert.ok(find(ui(), "dk-local_1"));
});

test("a click runs the alert's own Herdr command, quoted for the shell", () => {
  assert.equal(clickCommand("/a b/herdr-app", { name: "agent.focus", args: { terminal: "t1" } }),
    "'/a b/herdr-app' do agent.focus '{\"terminal\":\"t1\"}'");
  assert.equal(clickCommand("/x/herdr-app", { name: "relevo.panel-inbox" }), "'/x/herdr-app' do relevo.panel-inbox");
  assert.equal(clickCommand("/x/herdr-app", { name: "bad; rm" }), null);
  assert.equal(clickCommand(null, { name: "relevo.panel-inbox" }), null);
});

test("with terminal-notifier a banner brings Herdr forward and focuses the agent, and goes once it's answered", async () => {
  fake.window = { active: false };
  fake.exec = (cmd) => (cmd === "sh" ? { stdout: "/opt/bin/terminal-notifier\n/opt/bin/herdr-app\n" } : null);
  fake.panes = [{ pane: "p1", cwd: "/w/app" }];
  const set = (status) => { fake.agents = [{ address: "t1", status, pane: "p1", tab_name: "fix", space_name: "app" }]; };
  const watch = new AgentWatch();
  set("working");
  watch.tick();
  set("blocked");
  watch.tick();
  await flush();
  const shown = calls(/^\/opt\/bin\/terminal-notifier -title/)[0];
  assert.match(shown, /-activate dev\.herdr\.app/);
  assert.match(shown, /-execute '\/opt\/bin\/herdr-app' do agent\.focus/);
  assert.match(shown, /-group relevo-t1/);
  set("working");
  watch.tick();
  await flush();
  assert.equal(calls(/terminal-notifier -remove relevo-t1/).length, 1);
});

test("Desktop sessions ready for review fold under one line; questions stay open", async () => {
  const now = Date.now() / 1000;
  fake.stored[DESKTOP] = [session({ at: now }), session({ id: "local_2", state: "review", at: now }), session({ id: "local_3", state: "review", at: now })];
  const { box, cx } = await inbox();
  let ui = box.render(cx);
  assert.ok(find(ui, "dk-local_1"));
  assert.equal(find(ui, "dk-local_2"), null);
  assert.match(text(find(ui, "desktop-review")), /▸ 2 ready for review/);
  click(find(ui, "desktop-review"), cx);
  ui = box.render(cx);
  assert.ok(find(ui, "dk-local_2"));
  assert.equal(fake.stored["relevo.inbox.count"], 1);
});
