// Now's states: nothing needs you, the first read, sources that could not be read, the away digest and the narrowest panel.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake, calls } from "./fake/herdr.mjs";
import { fakeCx, find, text, click, flush, spinners } from "./fake/ui.mjs";

const { Inbox } = await import("../inbox.js");
const { inFlightLine, staleFor } = await import("../inbox-now.js");

const VIEW = "relevo.inbox.view", NOW = new Date().toISOString();
const EMPTY = JSON.stringify({ data: { viewer: { login: "me", merged: { nodes: [] }, pullRequests: { nodes: [] } }, search: { nodes: [] } } });
const url = (n) => `https://github.com/acme/app/pull/${n}`;
const pr = (n, extra = {}) => ({ url: url(n), number: n, repo: "acme/app", title: `PR ${n}`, reasons: [], skills: [], updatedAt: NOW, ...extra });
const running = { commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] } };
const words = (node) => text(node).replace(/\s+/g, " ").trim();

beforeEach(() => {
  resetFake();
  fake.exec = (cmd, args) => (cmd === "gh" ? { stdout: EMPTY } : args.includes("--show-toplevel") ? { stdout: "/work/app\n" } : null);
});

async function open() {
  const inbox = new Inbox(), cx = fakeCx();
  inbox.init({}, cx);
  await flush();
  inbox.h.is_focused = () => true;
  return { inbox, cx, ui: () => inbox.render(cx), key: (k) => { inbox.navKey({ key: k }, cx); return inbox.render(cx); } };
}

const parentOf = (node, id) => (node?.items ?? []).some((k) => k?.key === id) ? node
  : (node?.items ?? []).reduce((hit, k) => hit ?? (typeof k === "object" ? parentOf(k, id) : null), null);

// The glyph in a row's lane.
const lane = (row) => row.items[0].items[0].items[0];

test("nothing needs you: a calm block with no sentence when nothing is in flight", async () => {
  const { ui } = await open();
  const view = ui();
  const block = find(view, "now-empty");
  assert.ok(block);
  assert.match(lane({ items: [block] }).src, /check\.svg$/);
  assert.equal(lane({ items: [block] }).ink, "#done");
  assert.equal(words(block), "Nothing needs you m Maintenance · 0 n New run");
  assert.equal(find(view, "leg-me"), null);
});

test("nothing needs you: says what is in flight in words, and the in-flight rows still list below", async () => {
  const { inbox, ui } = await open();
  inbox.mine = [pr(12, running)];
  assert.match(words(find(ui(), "now-empty")), /One thing is still in flight\./);
  inbox.mine = [pr(12, running), pr(13, running)];
  const view = ui();
  assert.match(words(find(view, "now-empty")), /Two things are still in flight\./);
  assert.equal(words(find(view, "leg-flight")), "IN FLIGHT 2");
  assert.ok(find(view, `pr-${url(13)}`));
  assert.equal(inFlightLine(9), "Nine things are still in flight.");
  assert.equal(inFlightLine(12), "12 things are still in flight.");
  assert.equal(inFlightLine(0), null);
});

test("nothing needs you gives way to Needs me or Ready, and never shows before PRs were read", async () => {
  const { inbox, ui } = await open();
  inbox.mine = [pr(11, { reasons: ["CI failing"] })];
  assert.equal(find(ui(), "now-empty"), null);
  inbox.mine = [];
  inbox.ready = [pr(14)];
  assert.equal(find(ui(), "now-empty"), null);
  inbox.ready = [];
  inbox.prsAt = 0;
  assert.equal(find(ui(), "now-empty"), null);
  inbox.prsAt = Date.now() / 1000;
  inbox.localOkAt = 0;
  assert.equal(find(ui(), "now-empty"), null, "nor before the first agents scan");
});

test("the calm block's buttons and keys switch to Maintenance and open a new run", async () => {
  const { cx, ui, key } = await open();
  click(find(ui(), "now-empty-run"), cx);
  assert.equal(fake.overlays.at(-1).props.role, "goal-editor");
  assert.equal(fake.overlays.at(-1).props.mode, "run");
  key("n");
  assert.equal(fake.overlays.length, 2);
  assert.equal(fake.stored[VIEW], undefined, "n opens a run instead of switching view");
  click(find(ui(), "now-empty-maintenance"), cx);
  assert.equal(fake.stored[VIEW], "maintenance");
  fake.stored[VIEW] = "now";
  key("m");
  assert.equal(fake.stored[VIEW], "maintenance");
});

test("Tab switches between Now and Maintenance, n always starts a run, and opening Reviews lands on Now", async () => {
  const { key } = await open();
  key("tab");
  assert.equal(fake.stored[VIEW], "maintenance");
  key("n");
  assert.equal(fake.overlays.at(-1).props.role, "goal-editor");
  assert.equal(fake.stored[VIEW], "maintenance", "n in Maintenance opens a run too");
  key("tab");
  assert.equal(fake.stored[VIEW], "now");
  fake.stored[VIEW] = "maintenance";
  fake.stored["relevo.goals.mode"] = true;
  const { landOnReviews } = await import("../toolbar.js");
  landOnReviews();
  assert.equal(fake.stored[VIEW], "now");
  assert.equal(fake.stored["relevo.goals.mode"], false);
});

// Holds the PR query until the test answers it.
function holdPRs() {
  let answer;
  const held = new Promise((resolve) => { answer = resolve; });
  const before = fake.exec;
  fake.exec = (cmd, args) => (cmd === "gh" && args[0] === "api" ? held : before(cmd, args));
  return answer;
}

test("first read: the tabs count …, a status line says what is read and what is asked, PRs show as grey bars", async () => {
  const answer = holdPRs();
  const { inbox, ui } = await open();
  inbox.local = [{ kind: "blocked", top: "/work/app", repo: "app", agent: { address: "t1", status: "blocked", pane: "p-t1" }, at: 1 }];
  const view = ui();
  assert.equal(words(find(view, "view-now")), "Now …");
  assert.equal(words(find(view, "view-maintenance")), "Maintenance …");
  assert.equal(words(find(view, "first-read")), "agents and runs read asking GitHub…");
  assert.equal(spinners(find(view, "first-read")), 1);
  assert.equal(words(find(view, "leg-me")), "NEEDS ME 1");
  assert.equal(words(find(view, "leg-prs-loading")), "PULL REQUESTS …");
  for (const i of [0, 1, 2]) {
    const bars = find(view, `pr-skeleton-${i}`).items[1].items;
    assert.deepEqual(bars.map((b) => b.fill), ["#border", "#hover"]);
  }
  assert.equal(find(view, "now-empty"), null);
  answer({ stdout: EMPTY });
  await flush();
  const after = ui();
  assert.equal(find(after, "first-read"), null);
  assert.equal(find(after, "pr-skeleton-0"), null);
  assert.equal(words(find(after, "view-now")), "Now 1");
});

test("could not read: one row per source, with how old its last read is, above everything else", async () => {
  const { inbox, ui } = await open();
  inbox.error = "HTTP 401: Bad credentials";
  inbox.prsAt = Date.now() / 1000 - 12 * 60;
  inbox.localError = "Agents: hc not found";
  inbox.localOkAt = Date.now() / 1000 - 3 * 60;
  inbox.workflowError = "Workflow status unavailable.";
  inbox.workflowAt = undefined;
  inbox.local = [{ kind: "blocked", top: "/work/app", repo: "app", agent: { address: "t1", status: "blocked", pane: "p-t1" }, at: 1 }];
  const view = ui();
  assert.equal(words(find(view, "leg-errors")), "COULD NOT READ 3");
  assert.equal(words(find(view, "error-prs")), "GitHub PRs · me PRs are 12 min old Retry");
  assert.equal(words(find(view, "error-local")), "Local agents Agents are 3 min old Retry");
  assert.equal(words(find(view, "error-workflow")), "Runs never read Retry");
  assert.equal(find(view, "error-prs").tip, "HTTP 401: Bad credentials");
  assert.match(lane(find(view, "error-prs")).src, /warn\.svg$/);
  assert.equal(find(view, "local-error"), null, "no red line in Now");
  assert.deepEqual(inbox.nav.slice(0, 4).map((n) => n.id), ["error-prs", "error-local", "error-workflow", "in-t1"]);
  assert.equal(find(view, "now-empty"), null);
  fake.stored[VIEW] = "maintenance";
  assert.ok(find(ui(), "local-error"), "Maintenance keeps its lines");
  assert.equal(staleFor(0, 90 * 60), "1 h");
  assert.equal(staleFor(0, 3 * 86400), "3 d");
});

test("Retry, by click or r on the selected error, reads that source again; selected, the row shows the whole error", async () => {
  const { inbox, cx, ui, key } = await open();
  inbox.error = "HTTP 502";
  ui();
  const before = calls(/^gh api graphql/).length;
  let view = key("down");
  assert.equal(inbox.sel, "error-prs");
  assert.match(words(find(view, "error-prs")), /HTTP 502/);
  const edge = parentOf(find(view, "error-prs"), "retry-error-prs");
  assert.equal(text(edge.items[0]), "r", "the keycap beside Retry");
  key("r");
  await flush();
  assert.ok(calls(/^gh api graphql/).length > before);
  assert.equal(inbox.error, null);
  assert.equal(find(ui(), "error-prs"), null);
  inbox.localError = "Agents: boom";
  inbox.scanning = false;
  view = ui();
  click(find(view, "retry-error-local"), cx);
  await flush();
  assert.equal(inbox.localError, null);
  assert.ok(inbox.localOkAt > 0);
});

test("Enter on a selected error reads that source again", async () => {
  const { inbox, ui, key } = await open();
  inbox.error = "HTTP 502";
  ui();
  const before = calls(/^gh api graphql/).length;
  key("down");
  assert.equal(inbox.sel, "error-prs");
  key("enter");
  await flush();
  assert.ok(calls(/^gh api graphql/).length > before);
  assert.equal(inbox.error, null);
});

function away(inbox) {
  const now = Date.now();
  fake.agents = [{ address: "t1", status: "done", pane: "p1" }, { address: "t2", status: "blocked", pane: "p2" }];
  fake.panes = [{ pane: "p1", cwd: "/w/app", branch: "main" }, { pane: "p2", cwd: "/w/api" }];
  inbox.digest = {
    since: now - 20 * 60_000, now, finished: ["t1"], waiting: ["t2"], said: { t1: "All tests pass" }, seconds: 600,
    prs: [{ title: "CI failed · app #1", url: url(1) }], quota: [{ key: "p", label: "Personal", h5: 12, d7: 0 }],
  };
}

test("away digest: a header with its duration and Dismiss, the facts under it, and each item as a row in its lane", async () => {
  const { inbox, cx, ui } = await open();
  away(inbox);
  const view = ui();
  assert.equal(words(find(view, "away")), "WHILE YOU WERE AWAY 20m Dismiss");
  assert.equal(words(find(view, "away-facts")), "Personal 5h +12% · 10m of agent time");
  const done = find(view, "away-done-t1"), wait = find(view, "away-wait-t2"), changed = find(view, "away-pr-0");
  assert.equal(words(done), "app · main All tests pass Agent");
  assert.match(lane(done).src, /check\.svg$/);
  assert.equal(lane(wait).fill, "#blocked");
  assert.equal(lane(changed).stroke, "#accent");
  assert.equal(words(changed), "CI failed · app #1 Open");
  click(find(view, "away-dismiss"), cx);
  assert.equal(inbox.digest, null);
  assert.equal(find(ui(), "away"), null);
});

test("away rows take o and Enter like any row", async () => {
  const { inbox, ui, key } = await open();
  away(inbox);
  ui();
  key("down");
  assert.equal(inbox.sel, "away-done-t1");
  key("o");
  assert.deepEqual(fake.runs.at(-1), ["agent.focus", { terminal: "t1" }]);
  key("down");
  key("enter");
  assert.deepEqual(fake.runs.at(-1), ["agent.focus", { terminal: "t2" }]);
});

test("at the narrowest: short legend labels, no age, and a me row's action is a chevron that still runs it", async () => {
  const { inbox, cx, ui } = await open();
  inbox.local = [{ kind: "diff", top: "/work/app", repo: "app", agent: { address: "t2", status: "done", pane: "p-t2" }, files: 1, add: 1, del: 0, at: 1 }];
  inbox.mine = [pr(12, running)];
  inbox.ready = [pr(14)];
  let view = ui();
  assert.match(words(find(view, "in-t2")), /\d+d Review$/);
  find(view, "relevo-inbox").handlers.on_size_change({ width: 280 }, cx);
  assert.equal(inbox.tightInbox, true);
  view = ui();
  assert.equal(words(find(view, "now-legend")), "Me 1 · Flight 1 · Ready 1");
  assert.doesNotMatch(words(find(view, "in-t2")), /\d+d/);
  const chevron = find(view, "review-t2");
  assert.match(chevron.items[0].src, /chevron-right\.svg$/);
  assert.equal(chevron.accessibleLabel, "Review");
  click(chevron, cx);
  await flush();
  assert.equal(fake.runs.at(-1)[0], "pane.split");
});
