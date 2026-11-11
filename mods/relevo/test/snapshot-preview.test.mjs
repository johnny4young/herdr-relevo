import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { fake, resetFake, watched } from "./fake/herdr.mjs";
import { fakeCx, find, text, click, flush } from "./fake/ui.mjs";
import { snapshotCards, filterSnapshot, snapshotTime } from "../lib/snapshot-inbox.js";
const { SnapshotInbox, SnapshotDetail } = await import("../snapshot-preview.js");
const { default: Relevo } = await import("../main.js");

const SOURCE = "relevo.snapshot";
const fixture = () => ({ schemaVersion: 1, mode: "metadata-snapshot", capturedAt: "2026-11-09T02:00:00Z",
  sourceMtimes: { docs: "2026-11-09T01:00:00Z", terminals: "2026-11-08T23:00:00Z" },
  spaces: [{ sourceId: "s1", title: "Example project", repoBasename: "example", tabs: [
    { sourceId: "tab1", title: "Existing tab", terminals: [{ sourceId: "t1", title: "Agent A", repoBasename: "example", status: "working", statusAt: null, agentApp: "codex" }] },
    { sourceId: "tab2", title: "Blocked tab", terminals: [{ sourceId: "t2", title: "Agent B", status: "blocked", statusAt: "2026-11-08T23:00:00Z", agentApp: "claude-code" },
      { sourceId: "t3", title: "Shell", status: "idle" }] },
  ] }] });
beforeEach(() => { resetFake(); fake.stored[SOURCE] = fixture(); });

test("snapshot groups actual sessions by tab and keeps missing responsibilities unknown", () => {
  const input = fixture(), before = JSON.stringify(input), cards = snapshotCards(input);
  assert.equal(cards.length, 2);
  assert.equal(cards[0].sourceTab, "tab2");
  assert.equal(cards[0].sessions.length, 2);
  assert.equal(cards[0].goal, "Not set");
  assert.equal(cards[0].responsible, "Not set");
  assert.equal(cards[0].criteria, "No evidence imported");
  assert.equal(cards[0].projectId, cards[1].projectId);
  assert.notEqual(cards[0].id, cards[1].id);
  assert.equal(JSON.stringify(input), before);
});

test("unknown terminal status never becomes a human decision or evidence", () => {
  const input = fixture(); input.spaces[0].tabs = [{ sourceId: "x", title: "Task-like title", terminals: [{ sourceId: "t9", status: "success", owner: "Injected owner", goal: "Injected goal" }] }];
  const card = snapshotCards(input)[0];
  assert.equal(card.status, "unknown"); assert.equal(card.goal, "Not set"); assert.equal(card.responsible, "Not set");
  assert.equal(card.decision, undefined); assert.equal(card.evidence, undefined); assert.equal(card.revision, undefined);
});

test("invalid or excessive snapshots fail closed instead of falling back to fictional data", () => {
  for (const value of [null, {}, { ...fixture(), mode: "live" }, { ...fixture(), capturedAt: "invalid" },
    { ...fixture(), spaces: Array(101).fill(fixture().spaces[0]) }, { ...fixture(), spaces: [{ sourceId: "s", tabs: null }] }]) assert.equal(snapshotCards(value), null);
  const input = fixture(); input.spaces[0].tabs.push(input.spaces[0].tabs[0]); assert.equal(snapshotCards(input), null);
});

test("source ids stay distinct across spaces and empty tabs stay unknown", () => {
  const input = fixture(); input.spaces.push({ sourceId: "s2", title: "Second", tabs: [{ sourceId: "tab1", title: "Another", terminals: [] }] });
  const cards = snapshotCards(input); assert.equal(cards.length, 3); assert.equal(new Set(cards.map((c) => c.id)).size, 3);
  assert.equal(cards.at(-1).status, "unknown"); assert.equal(cards.at(-1).sessions.length, 0);
});

test("filters and timestamps represent saved states without claiming live freshness", () => {
  const cards = snapshotCards(fixture()); assert.equal(filterSnapshot(cards, "blocked").length, 1);
  assert.equal(filterSnapshot(cards, "working").length, 1); assert.equal(filterSnapshot(cards, "resting").length, 0);
  assert.match(snapshotTime(0), /1970-01-01/); assert.equal(snapshotTime(1e99), "Unavailable");
  assert.equal(snapshotTime(null), "Unavailable"); assert.equal(snapshotTime("bad"), "Unavailable");
});

test("all snapshot roles have no live IO, workers, timers or operational command execution", async () => {
  const layout = JSON.parse(readFileSync(new URL("../../../layouts/relevo-snapshot.json", import.meta.url), "utf8"));
  const blocks = (node) => [...(node.content ? [node.content] : []), ...(node.children ?? []).flatMap(blocks)];
  fake.exec = () => { throw new Error("No processes allowed"); }; fake.read = () => { throw new Error("No source reads allowed"); }; fake.write = () => { throw new Error("No source writes allowed"); };
  for (const content of blocks(layout).filter((c) => c.mod === "relevo")) {
    assert.equal(content.props.snapshotPreview, true);
    fake.props = content.props;
    const view = new Relevo(), cx = fakeCx(); cx.spawn = () => { throw new Error("No workers allowed"); };
    view.init({}, cx); assert.ok(view.render(cx));
    for (const command of ["launch-codex", "quick-reply", "usage", "review", "handoff", "settings", "worktree-clean"]) view.command(command, cx);
    assert.deepEqual(cx.timers, []); await view.close(cx);
  }
  await flush(); assert.deepEqual(fake.execs, []); assert.deepEqual(fake.runs, []); assert.deepEqual(watched(), []);
});

test("snapshot flag alone fails closed and unsupported roles never enter live or synthetic detail", () => {
  for (const role of ["inbox", "accounts", "panel-bar", "settings", "decision-detail", "unknown"]) {
    fake.props = { snapshotPreview: true, role };
    const view = new Relevo(), cx = fakeCx(); cx.spawn = () => { throw new Error("No worker"); };
    view.init({}, cx); const result = text(view.render(cx));
    assert.doesNotMatch(result, /Aurora|Cedar|Lumen|Ana|Simulate revision/);
    view.command("launch-codex", cx); assert.deepEqual(fake.runs, []);
  }
});

test("snapshot list uses actual metadata, opens context explicitly and does not mutate source", () => {
  const before = JSON.stringify(fake.stored[SOURCE]), inbox = new SnapshotInbox(), detail = new SnapshotDetail(), cx = fakeCx(); inbox.init({}, cx);
  const id = snapshotCards(fixture())[0].id;
  click(find(inbox.render(), `snapshot-item-${id}`), cx); assert.deepEqual(fake.overlays, []);
  click(find(inbox.render(), `snapshot-open-${id}`), cx);
  assert.equal(fake.overlays.length, 1); assert.equal(fake.overlays[0].props.role, "snapshot-detail");
  const output = text(detail.render()); assert.match(output, /Blocked tab/); assert.match(output, /Not set/);
  assert.match(output, /cause was not imported/); assert.doesNotMatch(output, /Mark reviewed|Simulate|Approve|Send|Merge/);
  fake.props.overlay = "snapshot-overlay-id"; click(find(detail.render(), "snapshot-close"), cx);
  assert.deepEqual(fake.closedOverlays, ["snapshot-overlay-id"]); assert.equal(JSON.stringify(fake.stored[SOURCE]), before);
  assert.deepEqual(fake.runs, []); assert.deepEqual(fake.execs, []);
});

test("snapshot keyboard and filters are confined to local selection", () => {
  const inbox = new SnapshotInbox(), cx = fakeCx(); inbox.init({}, cx);
  inbox.key({ key: "down" }, cx); assert.equal(inbox.selected, snapshotCards(fixture())[0].id);
  inbox.key({ key: "j" }, cx); assert.equal(inbox.selected, snapshotCards(fixture())[1].id);
  inbox.key({ key: "enter", modifiers: { platform: true } }, cx); assert.deepEqual(fake.overlays, []);
  click(find(inbox.render(), "snapshot-filter-blocked"), cx); assert.equal(inbox.list().length, 1);
  inbox.key({ key: "enter" }, cx); assert.equal(fake.overlays.length, 1);
  inbox.key({ key: "escape" }, cx); assert.equal(inbox.list().length, 2);
  inbox.choose("resting"); inbox.key({ key: "enter" }, cx); assert.equal(fake.overlays.length, 1);
  inbox.close(); assert.equal(cx.released, undefined); assert.deepEqual(fake.runs, []);
});

test("missing snapshot shows an explicit error and never exposes synthetic examples", () => {
  fake.stored[SOURCE] = null; const inbox = new SnapshotInbox(), cx = fakeCx(); inbox.init({}, cx);
  const output = text(inbox.render()); assert.match(output, /No valid snapshot/); assert.doesNotMatch(output, /Aurora|Cedar|Lumen/);
});
