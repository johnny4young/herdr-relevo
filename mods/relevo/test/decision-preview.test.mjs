import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { fake, resetFake, watched } from "./fake/herdr.mjs";
import { fakeCx, find, text, click, flush } from "./fake/ui.mjs";

const { default: Relevo } = await import("../main.js");
const { PreviewInbox, DecisionDetail } = await import("../decision-preview.js");
const { createDemoItems } = await import("../lib/decision-inbox.js");
const STATE = "relevo.preview.decisions.v1";
const state = () => fake.stored[STATE];
const ids = createDemoItems().map((i) => i.id);
const layout = JSON.parse(readFileSync(new URL("../../../layouts/relevo-preview.json", import.meta.url), "utf8"));
const blocks = (node) => [...(node.content ? [node.content] : []), ...(node.children ?? []).flatMap(blocks)];
const disabled = (view, id) => !find(view, id).handlers.on_click;
function open() {
  const inbox = new PreviewInbox(), detail = new DecisionDetail(), cx = fakeCx();
  inbox.init({}, cx);
  return { inbox, detail, cx, press: (key, modifiers = {}) => inbox.render().handlers.on_key_down({ key, modifiers }, cx),
    tap: (id) => click(find(detail.render(), id) ?? find(inbox.render(), id), cx) };
}
beforeEach(resetFake);

test("guarded Relevo layout blocks initialize and render without operational IO or background workers", async () => {
  let reads = 0, writes = 0, spawned = 0;
  fake.read = () => { reads++; throw new Error("preview must not read files"); };
  fake.write = () => { writes++; throw new Error("preview must not write files"); };
  fake.exec = () => { throw new Error("preview must not execute commands"); };
  const views = [];
  for (const content of blocks(layout).filter((content) => content.mod === "relevo")) {
    assert.equal(content.mod, "relevo");
    assert.equal(content.props.syntheticPreview, true);
    fake.props = content.props;
    const view = new Relevo(), cx = fakeCx();
    cx.spawn = () => { spawned++; throw new Error("preview must not start a live worker"); };
    view.init(content.props, cx);
    assert.ok(view.render(cx));
    for (const command of ["settings", "handoff", "review", "find-file", "quick-reply", "sessions", "worktree-clean", "usage-scan", "panel-inbox", "launch-test"]) {
      view.command(command, cx);
    }
    views.push({ view, cx });
    assert.deepEqual(cx.timers, []);
    assert.deepEqual(cx.slept, []);
  }
  assert.equal(views.length, 5);
  for (const { view, cx } of views) await view.close(cx);
  await flush();
  assert.equal(spawned, 0);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.deepEqual(fake.execs, []);
  assert.deepEqual(fake.runs, []);
  assert.deepEqual(fake.overlays, []);
  assert.deepEqual(watched(), []);
});

test("real inbox filters and row selection keep selection visible; reset restores all fixtures", () => {
  const { inbox, detail, tap } = open();
  assert.match(text(inbox.render()), /Example A.*Example B.*Example C/);
  tap("preview-filter-review");
  assert.equal(state().selected, ids[1]);
  assert.equal(find(inbox.render(), `preview-item-${ids[0]}`), null);
  assert.match(text(detail.render()), /Example B/);
  tap("preview-filter-all");
  assert.equal(state().selected, ids[1]);
  tap("preview-filter-ready");
  assert.equal(state().selected, ids[2]);
  tap("preview-filter-all");
  tap(`preview-item-${ids[0]}`);
  assert.equal(state().selected, ids[0]);
  assert.equal(state().filter, "all");
  tap("preview-reviewed");
  tap("preview-new-revision");
  tap("preview-filter-ready");
  tap("preview-reset");
  assert.deepEqual(state().items, createDemoItems());
  assert.equal(state().selected, ids[0]);
  assert.equal(state().filter, "all");
  assert.match(text(detail.render()), /Preview reset/);
});

test("keyboard moves only within visible items, respects modifiers and handles empty lists", () => {
  const { inbox, press, tap, cx } = open();
  press("down"); assert.equal(state().selected, ids[1]);
  press("j"); assert.equal(state().selected, ids[2]);
  press("j"); assert.equal(state().selected, ids[2]);
  press("up"); assert.equal(state().selected, ids[1]);
  press("k"); assert.equal(state().selected, ids[0]);
  press("k"); assert.equal(state().selected, ids[0]);
  const notified = cx.notified;
  for (const modifier of ["platform", "control", "alt"]) press("j", { [modifier]: true });
  press("unhandled");
  assert.equal(state().selected, ids[0]);
  assert.equal(cx.notified, notified);
  tap("preview-filter-ready"); press("down"); assert.equal(state().selected, ids[2]);
  press("escape"); assert.equal(state().filter, "all");
  assert.equal(state().selected, ids[2]);
  inbox.chooseFilter("empty");
  assert.equal(state().selected, null);
  assert.match(text(inbox.render()), /No examples/);
  press("j"); assert.equal(state().selected, null);
  assert.match(text(new DecisionDetail().render()), /Select an item/);
});

test("native review→revision→refresh→review cycle gates buttons and preserves other items", () => {
  const { inbox, detail, tap } = open();
  tap("preview-reviewed");
  const untouched = state().items.slice(1);
  assert.equal(state().items[0].reviewedRevision, "r1");
  assert.ok(disabled(detail.render(), "preview-reviewed"));
  assert.ok(disabled(detail.render(), "preview-evidence"));
  assert.match(text(detail.render()), /Marked in this preview only/);
  assert.match(text(inbox.render()), /Reviewed here · not approved/);
  tap("preview-new-revision");
  assert.equal(state().items[0].revision, "r2");
  assert.equal(state().items[0].reviewedRevision, null);
  assert.ok(disabled(detail.render(), "preview-reviewed"));
  assert.ok(!disabled(detail.render(), "preview-evidence"));
  assert.match(text(detail.render()), /STALE EVIDENCE/);
  assert.match(text(detail.render()), /New simulated revision/);
  assert.doesNotMatch(text(inbox.render()), /Reviewed here/);
  tap("preview-evidence");
  assert.ok(!disabled(detail.render(), "preview-reviewed"));
  assert.ok(disabled(detail.render(), "preview-evidence"));
  assert.match(text(detail.render()), /Sample evidence linked/);
  tap("preview-reviewed");
  assert.equal(state().items[0].reviewedRevision, "r2");
  assert.deepEqual(state().items.slice(1), untouched);
  tap(`preview-item-${ids[1]}`);
  assert.ok(!disabled(detail.render(), "preview-reviewed"));
  assert.equal(state().items[1].reviewedRevision, null);
  assert.equal(state().notice, "");
  assert.doesNotMatch(text(detail.render()), /Marcado solo/);
});

test("repeated captured clicks are idempotent and never target the newly selected item", () => {
  const { detail, tap, cx } = open();
  const mark = find(detail.render(), "preview-reviewed");
  click(mark, cx);
  const first = JSON.parse(JSON.stringify(state().items));
  click(mark, cx);
  assert.deepEqual(state().items, first);
  tap(`preview-item-${ids[1]}`);
  click(mark, cx);
  assert.equal(state().items[1].reviewedRevision, null);
  assert.equal(state().items[0].reviewedRevision, "r1");
  tap(`preview-item-${ids[0]}`);
  tap("preview-new-revision");
  const refresh = find(detail.render(), "preview-evidence");
  click(refresh, cx);
  const refreshed = JSON.parse(JSON.stringify(state().items));
  click(refresh, cx);
  assert.deepEqual(state().items, refreshed);
  const advance = find(detail.render(), "preview-new-revision");
  click(advance, cx); click(advance, cx);
  assert.equal(state().items[0].revision, "r3");
  assert.equal(state().items[1].revision, "r1");
  assert.deepEqual(fake.execs, []);
  assert.deepEqual(fake.runs, []);
  assert.deepEqual(Object.keys(fake.stored).sort(), [STATE, "relevo.inbox.count"].sort());
});

test("synthetic shared state survives view reconstruction but reset clears it", () => {
  const first = open();
  first.tap("preview-reviewed");
  const second = open();
  assert.ok(disabled(second.detail.render(), "preview-reviewed"));
  assert.match(text(second.inbox.render()), /Reviewed here/);
  second.tap("preview-reset");
  assert.ok(!disabled(second.detail.render(), "preview-reviewed"));
  assert.doesNotMatch(text(second.inbox.render()), /Reviewed here/);
});


test("captured mark from r1 cannot review refreshed r2 or overwrite its notice", () => {
  const { detail, tap, cx } = open();
  const markR1 = find(detail.render(), "preview-reviewed");
  tap("preview-new-revision");
  tap("preview-evidence");
  const before = JSON.parse(JSON.stringify(state()));
  click(markR1, cx);
  assert.deepEqual(state(), before);
  assert.equal(state().items[0].reviewedRevision, null);
  assert.equal(state().items[0].revision, "r2");
  tap("preview-reviewed");
  assert.equal(state().items[0].reviewedRevision, "r2");
});

test("captured controls from another selection cannot mutate items, selection or notices", () => {
  const { detail, tap, cx } = open();
  const mark = find(detail.render(), "preview-reviewed");
  const advance = find(detail.render(), "preview-new-revision");
  tap("preview-new-revision");
  const refresh = find(detail.render(), "preview-evidence");
  const advanceR2 = find(detail.render(), "preview-new-revision");
  tap(`preview-item-${ids[1]}`);
  const before = JSON.parse(JSON.stringify(state()));
  for (const control of [mark, advance, refresh, advanceR2]) {
    click(control, cx);
    assert.deepEqual(state(), before);
  }
});

test("stale or missing persisted evidence never displays a reviewed badge", () => {
  const { inbox, detail, tap } = open();
  tap("preview-reviewed");
  for (const evidence of [null, { ...state().items[0].evidence, revision: "r0" }]) {
    fake.stored[STATE] = { ...state(), items: state().items.map((item, n) => n ? item : { ...item, evidence, reviewedRevision: "r1" }) };
    assert.doesNotMatch(text(inbox.render()), /Reviewed here/);
    assert.doesNotMatch(text(find(detail.render(), "preview-reviewed")), /✓ Revisado/);
    assert.ok(disabled(detail.render(), "preview-reviewed"));
    assert.match(text(detail.render()), /STALE EVIDENCE/);
  }
});


test("unknown, missing and live-only preview roles fail closed without operational initialization", async () => {
  let reads = 0, writes = 0;
  fake.read = () => { reads++; throw new Error("preview fallback must not read files"); };
  fake.write = () => { writes++; throw new Error("preview fallback must not write files"); };
  fake.exec = () => { throw new Error("preview fallback must not execute commands"); };
  for (const role of [undefined, "typo-role", "settings", "review-diff", "account-menu", "handoff", "usage", "sessions"]) {
    fake.props = { syntheticPreview: true, ...(role === undefined ? {} : { role }) };
    const view = new Relevo(), cx = fakeCx();
    cx.spawn = () => { throw new Error("preview fallback must not start workers"); };
    view.init(fake.props, cx);
    assert.match(text(view.render(cx)), role === undefined ? /ACCOUNTS/ : /PREVIEW · Isolated profile/);
    view.command("settings", cx);
    await view.close(cx);
    assert.deepEqual(cx.timers, []);
    assert.deepEqual(cx.slept, []);
  }
  await flush();
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.deepEqual(fake.execs, []);
  assert.deepEqual(fake.runs, []);
  assert.deepEqual(fake.overlays, []);
  assert.deepEqual(watched(), []);
});


test("preview preserves the native shell and terminal instead of replacing them with synthetic panels", () => {
  const original = JSON.parse(readFileSync(new URL("../../../layouts/relevo.json", import.meta.url), "utf8"));
  const nodes = (node) => [node, ...(node.children ?? []).flatMap(nodes)];
  const byId = (tree, id) => nodes(tree).find((node) => node.id === id);
  for (const id of ["brand", "tabs", "agents", "main", "files", "changes", "sidebar-footer", "status"]) {
    assert.deepEqual(byId(layout, id), byId(original, id), `${id} must preserve the original native shell`);
  }
  assert.equal(byId(layout, "spaces").content.mod, "spaces");
  assert.equal(byId(layout, "main").content.tab, "active");
  assert.deepEqual(byId(layout, "sidebar").size, byId(original, "sidebar").size);
  assert.deepEqual(byId(layout, "panel").size, byId(original, "panel").size);
  assert.equal(byId(layout, "panel-body").active, "inbox");
});

test("selection does not open a dialog; explicit review and Enter open a native closable overlay", () => {
  const { inbox, detail, tap, press, cx } = open();
  tap(`preview-item-${ids[1]}`);
  assert.equal(fake.overlays.length, 0);
  assert.equal(state().selected, ids[1]);
  tap(`preview-open-${ids[0]}`);
  assert.equal(state().selected, ids[0]);
  assert.deepEqual(fake.overlays, [{ mod: "relevo", props: { role: "decision-detail", syntheticPreview: true }, kind: "dialog", width: 640, height: 0.85 }]);
  fake.props = { ...fake.overlays[0].props, overlay: "synthetic-dialog-1" };
  const view = new Relevo();
  view.init(fake.props, cx);
  assert.match(text(view.render(cx)), /Reuse the existing invitation/);
  click(find(view.render(cx), "preview-close"), cx);
  assert.deepEqual(fake.closedOverlays, ["synthetic-dialog-1"]);
  press("down"); press("enter");
  assert.equal(state().selected, ids[1]);
  assert.equal(fake.overlays.length, 2);
  assert.match(text(detail.render()), /Example B/);
  inbox.chooseFilter("empty"); press("enter");
  assert.equal(fake.overlays.length, 2);
  assert.equal(fake.stored["relevo.inbox.count"], 3);
  assert.deepEqual(fake.execs, []);
  assert.deepEqual(fake.runs, []);
});

test("stale criteria display unverified instead of historical pass or fail", () => {
  const { detail, tap } = open();
  assert.match(text(find(detail.render(), `criterion-${ids[0]}-0`)), /Failed/);
  assert.match(text(find(detail.render(), `criterion-${ids[0]}-1`)), /Passed/);
  tap("preview-new-revision");
  for (const index of [0, 1]) {
    const criterion = text(find(detail.render(), `criterion-${ids[0]}-${index}`));
    assert.match(criterion, /To verify/);
    assert.doesNotMatch(criterion, /Passed|Failed|✓/);
  }
  tap("preview-evidence");
  assert.match(text(find(detail.render(), `criterion-${ids[0]}-0`)), /Failed/);
});

test("native account and file-finder controls remain visible but do not launch live actions in preview", async () => {
  let reads = 0;
  fake.read = () => { reads++; throw new Error("preview control must not read files"); };
  fake.exec = () => { throw new Error("preview control must not launch a command"); };
  const clickAll = (node, cx) => {
    if (!node || typeof node !== "object") return;
    if (node.handlers?.on_click) click(node, cx);
    for (const child of node.items ?? []) clickAll(child, cx);
  };
  for (const role of ["accounts", "panel-bar"]) {
    fake.props = { role, syntheticPreview: true };
    const view = new Relevo(), cx = fakeCx();
    cx.spawn = () => { throw new Error("preview control must not spawn a worker"); };
    view.init(fake.props, cx);
    clickAll(view.render(cx), cx);
    assert.deepEqual(cx.timers, []);
    await view.close(cx);
  }
  await flush();
  assert.equal(reads, 0);
  assert.deepEqual(fake.execs, []);
  assert.deepEqual(fake.runs, []);
  assert.deepEqual(fake.overlays, []);
});
