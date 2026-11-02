import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import vm from "node:vm";

const source = (file) => readFileSync(new URL(file, import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
function scans(load) {
  const host = vm.createContext({});
  vm.runInContext(source("../inbox-prs.js").replace("export class PrViews", "class PrViews") + "\nglobalThis.PrViews = PrViews;", host);
  const view = new host.PrViews(), tasks = [];
  let notifications = 0;
  view.loadPRs = load;
  const cx = { notify: () => notifications++, spawn: fn => tasks.push(fn(cx)) };
  return { view, cx, tasks, notifications: () => notifications };
}

test("a failed first PR scan clears loading and preserves its error", async () => {
  const h = scans(async () => { throw new Error("offline"); });
  h.view.scanPRs(h.cx);
  assert.equal(h.view.prsLoading, 1);
  await Promise.all(h.tasks);
  assert.equal(h.view.prsLoading, 0);
  assert.equal(h.view.error, "PRs: offline");
  assert.equal(h.notifications(), 2);
});

test("a nonthrowing gh failure also clears loading", async () => {
  const h = scans(async function () { this.error = "gh failed"; });
  h.view.scanPRs(h.cx);
  await Promise.all(h.tasks);
  assert.equal(h.view.prsLoading, 0);
  assert.equal(h.view.error, "gh failed");
});

test("overlapping PR scans keep loading until every request settles", async () => {
  const complete = [];
  const h = scans(() => new Promise(resolve => complete.push(resolve)));
  h.view.scanPRs(h.cx); h.view.scanPRs(h.cx);
  assert.equal(h.view.prsLoading, 2);
  complete[0](); await h.tasks[0];
  assert.equal(h.view.prsLoading, 1);
  complete[1](); await h.tasks[1];
  assert.equal(h.view.prsLoading, 0);
});

function header({ at = 0, loading = 0, error = null }) {
  let spinners = 0;
  const labels = [];
  let node;
  node = new Proxy({}, { get: (_target, key) => (...args) => {
    if (key === "when" && args[0]) args[1](node);
    if (key === "child" && typeof args[0] === "string") labels.push(args[0]);
    return node;
  } });
  const host = vm.createContext({
    div: () => node, h_flex: () => node, v_flex: () => node,
    theme: () => ({}), ago: () => "just now", spinner: () => { spinners++; return node; },
  });
  const code = source("../inbox.js").split("\nfor (const views of [PrViews,")[0];
  vm.runInContext(code.replace("export class Inbox", "class Inbox") + "\nglobalThis.Inbox = Inbox;", host);
  const view = new host.Inbox();
  Object.assign(view, {
    prsAt: at, prsLoading: loading, error, h: { is_focused: () => false },
    shown: () => ({ local: [], mine: [], requested: [], mineDone: [], requestedDone: [], today: [], worktrees: [] }),
    publish() {}, takeFocus() {}, navItems: () => [],
    viewport: () => ({ hidden: new Set(), sections: new Set(), above: 0 }),
    localGroup: () => [], prGroup: () => [], todayGroup: () => [], treeGroups: () => [],
  });
  view.render({});
  return { spinners, labels };
}

test("an unavailable first snapshot renders a static header, not an endless animation", () => {
  const h = header({ error: "offline" });
  assert.equal(h.spinners, 0);
  assert.ok(h.labels.includes("PRs unavailable"));
});

test("a pending initial scan displays loading", () => {
  const h = header({ loading: 1 });
  assert.equal(h.spinners, 1);
  assert.ok(h.labels.includes("loading"));
});

test("refreshing an existing snapshot animates only while it is pending", () => {
  assert.equal(header({ at: 123, loading: 1 }).spinners, 1);
  const h = header({ at: 123 });
  assert.equal(h.spinners, 0);
  assert.ok(h.labels.includes("PRs just now"));
});
