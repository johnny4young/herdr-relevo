import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { fake, resetFake } from "./fake/herdr.mjs";
import { click, fakeCx, find, flush, text } from "./fake/ui.mjs";
import { AGY_AWK, AGY_SCAN, SeenIds, addAgy, cutDay, emptyState, parseScan, reportOf } from "../lib/usage-scan.js";
import { SNOOZE_PRESETS, isSnoozed, pruneSnoozed, snoozeLabel, snoozeUntil } from "../lib/snooze.js";
import { INBOX_SHORTCUT_ACTIONS } from "../lib/shortcut-help.js";
import { PROVIDERS } from "../lib/providers.js";
import { summarize } from "../lib/usage.js";

const { Inbox } = await import("../inbox.js");
const { AccountStatus } = await import("../account-status.js");
const { UsageDialog } = await import("../usage.js");
const { InboxButton, RUNS_COUNT, RUNS_FLIGHT } = await import("../toolbar.js");
const { GoalEditor, openGoal } = await import("../goals-editor.js");
const { RUN_START } = await import("../run-launcher.js");
const { row } = await import("../ui.js");

let dir;
beforeEach(() => {
  resetFake();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), "relevo-p1-"));
});

test("Antigravity token transcripts are scanned cleanly without double-counting and appear in Usage summary", () => {
  assert.equal(PROVIDERS.agy.caps.usage, true);
  assert.deepEqual(PROVIDERS.agy.usageDirs({}, "/h"), ["/h/.gemini/antigravity/brain"]);
  const conv = join(dir, "brain", "16a41124-baa5-4535-944e-803e82d86fdf", ".system_generated", "logs");
  mkdirSync(conv, { recursive: true });
  const file = join(conv, "transcript.jsonl");
  const now = new Date().toISOString();
  writeFileSync(file, [
    JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "hi" }),
    JSON.stringify({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", created_at: now, model: "gemini-4-neon-high", input_tokens: 17413, cache_read_tokens: 0, output_tokens: 911 }),
    JSON.stringify({ step_index: 2, source: "MODEL", type: "GENERIC", tool_calls: [{ args: { Path: "/Users/dev/herdr-relevo/README.md" } }] }),
    JSON.stringify({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", created_at: now, model: "gemini-4-neon-high", input_tokens: 9344, cache_read_tokens: 17414, output_tokens: 530 }),
  ].join("\n") + "\n");
  const len = readFileSync(file).length;
  const out = execFileSync("sh", ["-c", AGY_SCAN, "sh", AGY_AWK, `${file}|0|${len}`]).toString();
  const parsed = parseScan(out);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].agy.length, 2);
  const state = emptyState(), seen = new SeenIds(state);
  addAgy(state, seen, parsed[0], { account: "agy", project: (cwd) => cwd.split("/").pop(), cut: cutDay() });
  // Re-reading the same byte range counts nothing twice.
  addAgy(state, seen, parsed[0], { account: "agy", project: (cwd) => cwd.split("/").pop(), cut: cutDay() });
  const report = reportOf(state, Math.round(Date.now() / 1000));
  const summary = summarize(report, 7, "agy");
  assert.equal(summary.total.write, 17413 + 9344);
  assert.equal(summary.total.read, 17414);
  assert.equal(summary.total.output, 911 + 530);
  assert.equal(summary.surfaces[0].label, "Antigravity");
  assert.equal(summary.projects[0].key, "herdr-relevo");
});

test("AccountStatus exposes Usage and Settings in the bar and popup, and UsageDialog closes on Escape", () => {
  const bar = new AccountStatus(), cx = fakeCx();
  bar.init({ detail: false }, cx);
  const leaf = bar.render();
  assert.ok(find(leaf, "account-status-bar-usage"));
  assert.ok(find(leaf, "account-status-bar-settings"));
  click(find(leaf, "account-status-bar-usage"), cx);
  assert.equal(fake.overlays.at(-1).props.role, "usage");

  const pop = new AccountStatus();
  pop.init({ detail: true }, cx);
  const detail = pop.render();
  assert.ok(find(detail, "account-status-usage"));
  assert.ok(find(detail, "account-status-week"));
  assert.ok(find(detail, "account-status-settings"));

  fake.props = { overlay: "usage-dlg" };
  const dlg = new UsageDialog();
  dlg.init({}, cx);
  const tree = dlg.render(cx);
  assert.equal(text(find(tree, "usage-title")), "Tokens & Usage");
  find(tree, "relevo-usage").handlers.on_key_down({ key: "escape", modifiers: {} }, cx);
  assert.deepEqual(fake.closedOverlays, ["usage-dlg"]);
  dlg.close();
  pop.close();
});

test("Needs me and stuck rows place their reason on a dedicated second line; ready rows stay one line", () => {
  const t = { accent: "#a", selected: "#s", blocked: "#b", muted: "#m", dim: "#d", done: "#g", working: "#w", idle: "#i", border: "#r", raised: "#x", background: "#bg" };
  const hot = row(t, "pr-1", { turn: "me", kind: "pr", title: "app #1", reason: "CI failing: unit · 2 comments" });
  const ready = row(t, "pr-2", { turn: "ready", kind: "pr", title: "app #2", reason: "ready to merge" });
  assert.equal(text(find(hot, "pr-1-reason")), "CI failing: unit · 2 comments");
  assert.equal(find(ready, "pr-2-reason"), null);
});

test("Snooze hides items until deadline or CI green, supports undo and Maintenance wake, and auto-advances selection", async () => {
  const nowSec = 1_700_000_000;
  const untilCi = snoozeUntil("ci", { since: nowSec - 10, label: "app #1" }, nowSec * 1000);
  assert.equal(isSnoozed(untilCi, { ci: "FAILURE", updatedAt: nowSec - 10 }, nowSec + 60), true);
  assert.equal(isSnoozed(untilCi, { ci: "SUCCESS", updatedAt: nowSec - 10 }, nowSec + 60), false);
  assert.equal(isSnoozed(untilCi, { ci: "FAILURE", updatedAt: nowSec + 30 }, nowSec + 60), false);
  assert.equal(snoozeLabel(untilCi, nowSec + 60), "until CI green");
  assert.deepEqual(pruneSnoozed({ old: { until: nowSec - 1 }, live: untilCi }, nowSec), { live: untilCi });
  assert.ok(SNOOZE_PRESETS.some((p) => p.key === "30m"));

  const pr = (n) => ({
    url: `https://github.com/acme/app/pull/${n}`, repo: "acme/app", number: n, title: `PR ${n}`,
    reasons: ["CI failing"], skills: ["fix"], ci: "FAILURE", updatedAt: new Date().toISOString(),
  });
  const inbox = new Inbox(), cx = fakeCx();
  inbox.init({}, cx); await flush();
  inbox.h.is_focused = () => true;
  inbox.clones["acme/app"] = "/work/app";
  inbox.mine = [pr(1), pr(2)];
  inbox.sel = `pr-${pr(1).url}`;
  inbox.render(cx);
  // h opens Snooze menu; choosing 30m hides PR #1 and auto-advances selection to PR #2.
  inbox.navKey({ key: "h", modifiers: {} }, cx);
  const menu = find(inbox.render(cx), "inbox-action-menu");
  assert.ok(menu);
  click(find(menu, `snooze-30m-pr-${pr(1).url}`), cx);
  inbox.render(cx);
  assert.equal(inbox.sel, `pr-${pr(2).url}`, "auto-advances to next item");
  // Maintenance lists the snoozed PR and Wake restores it.
  inbox.setReviewView("maintenance", cx);
  inbox.expanded["maintenance-snoozed"] = true;
  const maint = inbox.render(cx);
  assert.ok(find(maint, `unsnooze-pr-${pr(1).url}`));
  click(find(maint, `unsnooze-pr-${pr(1).url}`), cx);
  assert.equal(inbox.snoozed[`pr-${pr(1).url}`], undefined);
});

test("⌘K opens contextual Action Panel, m toggles Now/Maintenance, empty states render cleanly, and Runs tab shows badges", async () => {
  const inbox = new Inbox(), cx = fakeCx();
  inbox.init({}, cx); await flush();
  inbox.h.is_focused = () => true;
  const pr = {
    url: "https://github.com/acme/app/pull/9", repo: "acme/app", number: 9, title: "Fix cache",
    reasons: ["CI failing"], skills: [], ci: "FAILURE", updatedAt: new Date().toISOString(),
  };
  inbox.mine = [pr];
  inbox.sel = `pr-${pr.url}`;
  inbox.render(cx);
  inbox.navKey({ key: "k", modifiers: { platform: true } }, cx);
  const panel = find(inbox.render(cx), "inbox-action-menu");
  assert.ok(panel);
  assert.ok(find(panel, `copy-url-pr-${pr.url}`));
  inbox.actionMenuKey({ key: "escape" }, cx);
  assert.equal(inbox.actionMenu, null);

  // Filter with no matches shows clearable empty state.
  inbox.filterField.set_value("zzzz-no-hit");
  const filtered = inbox.render(cx);
  assert.ok(find(filtered, "now-no-matches"));
  click(find(filtered, "now-clear-filter"), cx);
  assert.equal(inbox.filterField.value(), "");

  // m toggles Now -> Maintenance -> Now, and empty Maintenance says All clean.
  inbox.navKey({ key: "m", modifiers: {} }, cx);
  assert.equal(inbox.reviewView(), "maintenance");
  assert.ok(find(inbox.render(cx), "maintenance-empty"));
  inbox.navKey({ key: "m", modifiers: {} }, cx);
  assert.equal(inbox.reviewView(), "now");

  // Runs tab badge reflects needs_you count or in-flight working dot.
  fake.layout = { id: "root", children: [{ id: "panel", hidden: false }, { id: "panel-body", active: "inbox" }] };
  fake.stored[RUNS_COUNT] = 0;
  fake.stored[RUNS_FLIGHT] = 2;
  const bar = new InboxButton();
  assert.ok(find(bar.render(), "runs-flight-dot"));
  fake.stored[RUNS_COUNT] = 3;
  assert.equal(text(find(bar.render(), "runs-badge")), "3");
});

test("New run composer offers one-step Start run when a repository is focused", async () => {
  fake.focused = { pane: "p1", cwd: "/work/app" };
  fake.panes = [{ pane: "p1", cwd: "/work/app" }];
  fake.exec = (cmd, args) => (cmd === "git" && args.includes("--show-toplevel") ? { code: 0, stdout: "/work/app\n" } : { code: 1, stdout: "" });
  openGoal();
  fake.props = { ...fake.overlays.at(-1).props, overlay: "new-run-fast" };
  const editor = new GoalEditor(), cx = fakeCx();
  editor.init({}, cx); await flush();
  const tree = editor.render();
  assert.ok(find(tree, "new-run-defaults"));
  assert.ok(find(tree, "goal-start-now"));
  editor.fields.criteria.set_value("Add dark mode toggle");
  click(find(tree, "goal-start-now"), cx); await flush();
  assert.equal(fake.stored[RUN_START].fields.root, "/work/app");
  assert.equal(fake.stored[RUN_START].fields.criteria, "Add dark mode toggle");
  assert.deepEqual(fake.runs.at(-1), ["relevo.run-start", undefined]);
  editor.close();
});

test("shortcut help catalog covers every command in keys.json", () => {
  const keysJson = JSON.parse(readFileSync(new URL("../../../keys.json", import.meta.url), "utf8"));
  const commands = Object.values(keysJson["layout:relevo"]);
  const listed = new Set(INBOX_SHORTCUT_ACTIONS.map((a) => a.id));
  const missing = commands.filter((cmd) => !listed.has(cmd));
  assert.deepEqual(missing, []);
});
