// Background work that waits for a reason: the review pane's poll, a queued auto-merge, and Desktop session files.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake, calls } from "./fake/herdr.mjs";
import { fakeCx, flush } from "./fake/ui.mjs";

const { ReviewDiff } = await import("../review.js");
const { Inbox } = await import("../inbox.js");
const { LANDING } = await import("../inbox-land.js");
const { slim } = await import("../desktop.js");
const { desktopSession } = await import("../lib/desktop.js");
beforeEach(resetFake);

function pane(hash = () => "hashA") {
  fake.exec = (cmd, args) => {
    const a = args.join(" ");
    if (cmd === "git" && a.includes("--numstat")) return { stdout: "1\t0\ta.ts\n1\t0\tb.ts\n" };
    if (cmd === "git" && a.includes("ls-files")) return { stdout: "" };
    if (cmd === "sh") return { stdout: `a.ts\nb.ts\n--\n${hash()}\nhashB\n` };
    if (cmd === "git" && a.endsWith("-- a.ts")) return { stdout: "@@ -0,0 +1 @@\n+a\n" };
    if (cmd === "git" && a.endsWith("-- b.ts")) return { stdout: "@@ -0,0 +1 @@\n+b\n" };
    return null;
  };
  const v = new ReviewDiff(), cx = fakeCx();
  v.init({}, cx);
  Object.assign(v, { key: "/repo", root: "/repo" });
  return { v, cx };
}
const fileDiffs = () => calls(/^git .* diff HEAD --no-color --no-ext-diff -- /).length;

test("the review pane's poll reads the open file's diff again only when the file changed", async () => {
  let h = "hashA";
  const { v, cx } = pane(() => h);
  await v.read(cx); await v.read(cx); await v.read(cx);
  assert.equal(fileDiffs(), 1);
  h = "hashA2";
  await v.read(cx);
  assert.equal(fileDiffs(), 2);
  assert.equal(typeof v.diffSign, "string");
  assert.ok(v.diffSign.length < 40, "a sign is kept, not the diff");
});

test("a slower diff for a file left behind never lands under the file picked after it", async () => {
  const { v, cx } = pane();
  const real = fake.exec;
  let release;
  fake.exec = (cmd, args) => (args.join(" ").endsWith("-- a.ts") ? new Promise((r) => { release = () => r(real(cmd, args)); }) : real(cmd, args));
  const a = v.pick({ path: "a.ts" }, cx);
  await v.pick({ path: "b.ts" }, cx);
  release(); await a;
  assert.equal(v.open.path, "b.ts");
  assert.deepEqual(v.rows.map((r) => r.text), ["@@ -0,0 +1 @@", "b"]);
});

test("each review keeps its marks, and only the newest forty reviews keep theirs", async () => {
  const { v, cx } = pane();
  await v.read(cx);
  fake.stored["relevo.review.viewed"] = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`/old-${i}`, { "x.ts": "h" }]));
  v.toggleViewed("a.ts", cx);
  const kept = Object.keys(fake.stored["relevo.review.viewed"]);
  assert.equal(kept.length, 40);
  assert.equal(kept.at(-1), "/repo");
  assert.ok(!kept.includes("/old-0") && kept.includes("/old-44"));
});

test("a queued auto-merge is asked about every two minutes once it is a few minutes old, and an unchanged poll redraws nothing", async () => {
  fake.exec = (cmd, args) => (cmd === "gh" && args[0] === "pr" ? { stdout: JSON.stringify({ state: "OPEN" }) } : null);
  const box = new Inbox(), cx = fakeCx();
  box.init({}, cx);
  await flush();
  const at = Math.round(Date.now() / 1000) - 600;
  fake.stored[LANDING] = { u: { repo: "me/app", number: 1, phase: "queued", at } };
  const views = () => calls(/^gh pr view 1 /).length;
  const notified = cx.notified;
  await box.landTick(cx); await box.landTick(cx); await box.landTick(cx);
  assert.equal(views(), 1);
  assert.equal(cx.notified, notified, "nothing changed, nothing redrawn");
  box.landAsked.u -= 121;
  await box.landTick(cx);
  assert.equal(views(), 2);
  fake.stored[LANDING] = { v: { repo: "me/app", number: 1, phase: "queued", at: Math.round(Date.now() / 1000) } };
  await box.landTick(cx); await box.landTick(cx);
  assert.equal(views(), 4, "a fresh one is asked every tick");
});

test("a Desktop session is kept as the fields its row reads, and reads the same", () => {
  const file = {
    sessionId: "local_1", cliSessionId: "abc", title: "Fix", cwd: "/w/app", originCwd: "/w/app", isArchived: false,
    latestUserFrameAt: 5, lastTurnEdgeAt: 4, lastActivityAt: Date.now(), postTurnSummary: { status_category: "blocked", needs_action: "Pick", status_detail: "d", extra: "x" },
    remoteMcpServersConfig: { big: "x".repeat(300000) },
  };
  const kept = slim(file);
  assert.equal(kept.remoteMcpServersConfig, undefined);
  assert.ok(JSON.stringify(kept).length < 400);
  assert.deepEqual(desktopSession(kept, 0), desktopSession(file, 0));
  assert.equal(slim(null), null);
});
