// From this folder: node --test 'test/*.test.mjs'. Covers the pure helpers in lib/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ago, duration, windowOf, FIVE_HOURS, runsOut } from "../lib/time.js";
import { diffRows, lineKey } from "../lib/diff.js";
import { ownerOf, contextFor } from "../lib/context.js";
import { totals, weekStart, week, weekTable } from "../lib/ledger.js";
import { keyMap, formatShortcut } from "../lib/keys.js";
import { mapMine, mapRequested, unresolved, prChanges } from "../lib/github.js";
import { readPrompt, submitKeys, freeOption, moveKeys, lastMessage } from "../lib/prompt.js";

const now = () => Math.floor(Date.now() / 1000);

test("ago: minutes, then hours up to two days, then days", () => {
  assert.equal(ago(now() - 30), "now");
  assert.equal(ago(now() - 5 * 60), "5m ago");
  assert.equal(ago(now() - 47 * 3600), "47h ago");
  assert.equal(ago(now() - 3 * 86400), "3d ago");
});

test("duration: minutes under an hour, then hours and padded minutes", () => {
  assert.equal(duration(25 * 60), "25m");
  assert.equal(duration(3600 + 5 * 60), "1h 05m");
});

test("windowOf: a window past its reset reads as empty", () => {
  assert.equal(windowOf(null, 0, FIVE_HOURS), null);
  assert.deepEqual(windowOf(80, now() - 10, FIVE_HOURS), { pct: 0, resets: null, pace: null });
  const w = windowOf(42.4, now() + FIVE_HOURS / 2, FIVE_HOURS);
  assert.equal(w.pct, 42);
  assert.ok(Math.abs(w.pace - 0.5) < 0.01);
});

test("diffRows: skips the file header and numbers both sides", () => {
  const rows = diffRows(["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -10,3 +10,3 @@", " same", "-old", "+new"]);
  assert.deepEqual(rows.map((r) => [r.kind, r.number ?? null]), [["@", null], [" ", 10], ["-", 11], ["+", 11]]);
  assert.equal(lineKey(rows[2]), "-11");
  assert.equal(lineKey(rows[3]), "+11");
});

test("contextFor: the owner picks the context, ssh aliases included", () => {
  const contexts = [{ key: "home", account: "a" }, { key: "work", account: "b", orgs: ["Acme"] }];
  assert.equal(ownerOf("git@github-work:acme/api.git"), "acme");
  assert.equal(contextFor("acme/api", contexts).key, "work");
  assert.equal(contextFor("https://github.com/someone/api", contexts).key, "home");
  assert.equal(contextFor("", contexts).key, "home");
});

test("totals: overlapping stretches on one ticket count once", () => {
  const since = 1000;
  const rows = [
    { start: 1000, end: 1600, jira: "ABC-1", repo: "api" },
    { start: 1300, end: 1900, jira: "ABC-1", repo: "api" },
    { start: 500, end: 1100, jira: null, repo: "web" },
    { start: 2000, end: 2030, jira: null, repo: "tiny" },
  ];
  assert.deepEqual(totals(rows, since), [
    { key: "ABC-1", repo: "api", jira: "ABC-1", seconds: 900 },
    { key: "web", repo: "web", jira: null, seconds: 100 },
  ]);
});

test("shortcuts: first combo per action, macOS modifier order", () => {
  const map = keyMap({ "cmd-alt-d": "relevo.review", "ctrl-r": "relevo.review", "cmd-alt-shift-w": "relevo.worktree-open" });
  assert.equal(formatShortcut(map["relevo.review"]), "⌥⌘D");
  assert.equal(formatShortcut(map["relevo.worktree-open"]), "⌥⇧⌘W");
  assert.equal(formatShortcut(undefined), "");
});

const pr = (over) => ({
  number: 1, title: "t", url: "u1", isDraft: false, updatedAt: "2026-10-30T10:00:00Z", reviewDecision: null,
  repository: { nameWithOwner: "me/repo" },
  commits: { nodes: [{ commit: { committedDate: "2026-10-30T09:00:00Z", statusCheckRollup: { state: "SUCCESS" } } }] },
  reviews: { nodes: [] }, reviewThreads: { nodes: [] }, ...over,
});

test("mapMine: only PRs that need something, with why and which skill", () => {
  const data = { viewer: { login: "me", pullRequests: { nodes: [
    pr({ url: "quiet" }),
    pr({ url: "draft", isDraft: true, reviewDecision: "CHANGES_REQUESTED" }),
    pr({ url: "ci", commits: { nodes: [{ commit: { committedDate: "2026-10-30T09:00:00Z", statusCheckRollup: { state: "FAILURE" } } }] } }),
    pr({ url: "threads", reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] } }),
    pr({ url: "review", reviews: { nodes: [{ author: { login: "copilot-pull-request-reviewer" }, state: "COMMENTED", submittedAt: "2026-10-30T09:30:00Z" }] } }),
  ] } } };
  const byUrl = Object.fromEntries(mapMine(data).map((p) => [p.url, p]));
  assert.deepEqual(Object.keys(byUrl).sort(), ["ci", "review", "threads"]);
  assert.deepEqual(byUrl.ci.skills, ["fix"]);
  assert.equal(byUrl.ci.hot, true);
  assert.equal(byUrl.threads.threads, 1);
  assert.deepEqual(byUrl.threads.reasons, []);
  assert.deepEqual(byUrl.review.reasons, ["review from copilot"]);
});

test("mapRequested: newest first, with unresolved threads", () => {
  const data = { search: { nodes: [
    { url: "old", updatedAt: "2026-10-01T00:00:00Z", repository: { nameWithOwner: "o/a" }, reviewThreads: { nodes: [{ isResolved: false }] } },
    { url: "new", updatedAt: "2026-10-30T00:00:00Z", repository: { nameWithOwner: "o/b" } },
    {},
  ] } };
  const list = mapRequested(data);
  assert.deepEqual(list.map((p) => p.url), ["new", "old"]);
  assert.equal(list[1].threads, 1);
  assert.equal(unresolved({}), 0);
});

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime() / 1000;

test("weekStart: the Monday at midnight, local time", () => {
  const wed = at(2026, 10, 28, 15, 30);
  assert.equal(weekStart(wed), at(2026, 10, 26));
  assert.equal(weekStart(wed, -1), at(2026, 10, 19));
  assert.equal(weekStart(at(2026, 11, 1, 23)), at(2026, 10, 26));
});

test("week: splits a stretch at midnight and merges parallel agents per day", () => {
  const start = at(2026, 10, 26);
  const rows = [
    { start: at(2026, 10, 26, 23, 0), end: at(2026, 10, 27, 1, 0), jira: "ABC-1", repo: "api" },
    { start: at(2026, 10, 27, 0, 30), end: at(2026, 10, 27, 1, 30), jira: "ABC-1", repo: "api" },
    { start: at(2026, 10, 30, 9, 0), end: at(2026, 10, 30, 9, 45), jira: null, repo: "web" },
    { start: at(2026, 10, 20, 9, 0), end: at(2026, 10, 20, 12, 0), jira: null, repo: "old" },
  ];
  const w = week(rows, start);
  assert.deepEqual(w.rows.map((r) => [r.key, r.days]), [
    ["ABC-1", [3600, 5400, 0, 0, 0, 0, 0]],
    ["web", [0, 0, 0, 0, 2700, 0, 0]],
  ]);
  assert.deepEqual(w.dayTotals, [3600, 5400, 0, 0, 2700, 0, 0]);
  assert.equal(w.total, 11700);
});

test("weekTable: tab-separated with empty cells for idle days", () => {
  const w = { days: [1, 2, 3, 4, 5, 6, 7], rows: [{ key: "ABC-1", jira: "ABC-1", repo: "api", days: [3600, 0, 0, 0, 0, 0, 0], total: 3600 }],
    dayTotals: [3600, 0, 0, 0, 0, 0, 0], total: 3600 };
  const lines = weekTable(w, (s) => `D${s}`, (s) => `${s / 3600}h`).split("\n");
  assert.equal(lines[0], "Ticket\tRepo\tD1\tD2\tD3\tD4\tD5\tD6\tD7\tTotal");
  assert.equal(lines[1], "ABC-1\tapi\t1h\t\t\t\t\t\t\t1h");
  assert.equal(lines[2], "Total\t\t1h\t\t\t\t\t\t\t1h");
});

test("readPrompt: a boxed permission dialog", () => {
  const screen = [
    "● Bash(npm test)",
    "╭──────────────────────────────────────────────╮",
    "│ Bash command                                 │",
    "│   rm -rf dist                                │",
    "│ Do you want to proceed?                      │",
    "│ ❯ 1. Yes                                     │",
    "│   2. Yes, and don't ask again for rm commands │",
    "│   3. No, and tell Claude what to do differently (esc) │",
    "╰──────────────────────────────────────────────╯",
  ].join("\n");
  const p = readPrompt(screen);
  assert.equal(p.question, "rm -rf dist\nDo you want to proceed?");
  assert.deepEqual(p.options.map((o) => o.n), [1, 2, 3]);
  assert.equal(p.options[1].label, "Yes, and don't ask again for rm commands");
});

test("readPrompt: choices without a frame, then nothing to answer", () => {
  const p = readPrompt(" Which database?\n › 1. Postgres\n   2. SQLite\n");
  assert.equal(p.question, "Which database?");
  assert.deepEqual(p.options.map(({ n, label }) => ({ n, label })), [{ n: 1, label: "Postgres" }, { n: 2, label: "SQLite" }]);
  const none = readPrompt("I changed three files.\nShould I also update the docs?\n");
  assert.deepEqual(none.options, []);
  assert.equal(none.question, "I changed three files.\nShould I also update the docs?");
});

test("readPrompt: an old numbered list is not a question", () => {
  const p = readPrompt("Plan:\n1. Read\n3. Write\nWaiting.");
  assert.deepEqual(p.options, []);
});

test("prChanges: silent on the first look, then CI, threads and review decisions", () => {
  const look = (ci, threads, decision) => ({ viewer: { pullRequests: { nodes: [pr({
    url: "u", number: 7, repository: { nameWithOwner: "me/api" }, reviewDecision: decision,
    commits: { nodes: [{ commit: { committedDate: "2026-10-30T09:00:00Z", statusCheckRollup: { state: ci } } }] },
    reviewThreads: { nodes: Array.from({ length: threads }, () => ({ isResolved: false })) },
  })] } } });
  const first = prChanges(null, look("PENDING", 0, null));
  assert.deepEqual(first.events, []);
  const red = prChanges(first.state, look("FAILURE", 2, "CHANGES_REQUESTED"));
  assert.deepEqual(red.events.map((e) => e.kind), ["ci-failed", "threads", "changes"]);
  assert.equal(red.events[1].title, "2 new review threads · api #7");
  const green = prChanges(red.state, look("SUCCESS", 1, "APPROVED"));
  assert.deepEqual(green.events.map((e) => e.kind), ["ci-passed", "approved"]);
  assert.deepEqual(prChanges(green.state, look("SUCCESS", 1, "APPROVED")).events, []);
});

test("readPrompt: Claude's question menu with descriptions, a separator and a help line", () => {
  const screen = [
    "❯ hazme una pregunta sencillo esperando respuesta si o no",
    "────────────────────────────────",
    " □ PRs",
    "",
    "¿Quieres que revise si hay PRs abiertos pendientes en puntovivo?",
    "",
    "❯ 1. Sí",
    "     Reviso los PRs abiertos del repo.",
    "  2. No",
    "     No reviso nada por ahora.",
    "  3. Type something.",
    "────────────────────────────────",
    "  4. Chat about this",
    "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
  const p = readPrompt(screen);
  assert.equal(p.question, "¿Quieres que revise si hay PRs abiertos pendientes en puntovivo?");
  assert.deepEqual(p.options.map((o) => [o.n, o.label, o.detail]), [
    [1, "Sí", "Reviso los PRs abiertos del repo."],
    [2, "No", "No reviso nada por ahora."],
    [3, "Type something.", ""],
    [4, "Chat about this", ""],
  ]);
});

test("readPrompt: a multiple choice with checked boxes and a Submit item", () => {
  const screen = [
    "❯ hazme una pregunta con seleccion multiple",
    "────────────────────────────────",
    "← ☒ CI gates  ✔ Submit  →",
    "",
    "¿Qué gates de CI quieres que corra en puntovivo? (puedes elegir varios)",
    "",
    "❯ 1. [✔] ci:web",
    "     Typecheck, lint, tests y build de apps/web.",
    "  2. [ ] ci:server",
    "     Typecheck, lint y tests de packages/server.",
    "  3. [✔] ci:desktop",
    "  4. [✔] test:e2e:web",
    "  5. [ ] Type something",
    "     Submit",
    "────────────────────────────────",
    "  6. Chat about this",
    "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
  const p = readPrompt(screen);
  assert.equal(p.question, "¿Qué gates de CI quieres que corra en puntovivo? (puedes elegir varios)");
  assert.equal(p.multi, true);
  assert.equal(freeOption(p), 5);
  assert.equal(freeOption({ options: [{ n: 5, label: "interesante" }] }, 5), 5);
  const typed = { ...p, options: p.options.map((o) => (o.n === 5 ? { ...o, label: "interesante" } : o)) };
  assert.equal(freeOption(typed), 5);
  assert.equal(freeOption({ options: [{ n: 1, label: "Sí" }, { n: 2, label: "otra" }, { n: 3, label: "Chat about this" }] }), 2);
  assert.equal(freeOption({ options: [{ n: 1, label: "Yes" }, { n: 2, label: "No" }] }), null);
  assert.deepEqual(moveKeys(p, 5), ["down", "down", "down", "down"]);
  assert.deepEqual(moveKeys({ ...p, cursor: 6 }, 5), ["up", "up"]);
  assert.deepEqual(moveKeys({ ...p, cursor: "submit" }, 5), ["up"]);
  assert.deepEqual(moveKeys({ ...p, cursor: 5 }, 5), []);
  assert.deepEqual(p.options.map((o) => [o.n, o.label, o.checked]), [
    [1, "ci:web", true], [2, "ci:server", false], [3, "ci:desktop", true], [4, "test:e2e:web", true],
    [5, "Type something", false], [6, "Chat about this", undefined],
  ]);
  assert.equal(p.options[4].detail, "");
  assert.deepEqual(p.submit, { after: 5 });
  assert.equal(p.cursor, 1);
  assert.deepEqual(submitKeys(p), ["down", "down", "down", "down", "down", "enter"]);
  assert.deepEqual(submitKeys({ ...p, cursor: 6 }), ["up", "enter"]);
  assert.deepEqual(submitKeys({ ...p, cursor: "submit" }), ["enter"]);
  assert.equal(submitKeys(readPrompt("Pick one\n❯ 1. A\n  2. B")), null);
});

test("readPrompt: a single choice with a preview beside the choices", () => {
  const screen = "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n ☐ Commit fmt\nWhich commit message format do you want to use?\n❯ 1. Conventional Commits         ┌──────────────────────────────────────────┐\n  2. Imperative summary           │ feat(auth): add token refresh on 401     │\n  3. Gitmoji                      │                                          │\n                                  │ Retry the original request once after    │\n                                  │ refreshing the access token.             │\n                                  └──────────────────────────────────────────┘\n                                  Notes: press n to add notes\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  Chat about this\nEnter to select · ↑/↓ to navigate · n to add notes · Esc to cancel";
  const p = readPrompt(screen);
  assert.equal(p.question, "Which commit message format do you want to use?");
  assert.deepEqual(p.options.map((o) => o.label), ["Conventional Commits", "Imperative summary", "Gitmoji"]);
  assert.equal(p.multi, false);
  assert.equal(p.cursor, 1);
  assert.deepEqual(moveKeys(p, 2), ["down"]);
  assert.equal(p.preview, "feat(auth): add token refresh on 401\n\nRetry the original request once after\nrefreshing the access token.");
  assert.equal(readPrompt("Pick\n❯ 1. A\n  2. B").preview, "");
});

test("readPrompt: the answers summary before Submit answers", () => {
  const screen = [
    "← ☒ Horario ☒ Tema ☒ Git hosting ✔ Submit →",
    "",
    "Review your answers",
    "",
    " ● ¿En qué momento del día programas mejor?",
    "   → Mañana",
    " ● ¿Qué plataformas de Git usas? (puedes elegir varias)",
    "   → GitHub, local",
    "",
    "Ready to submit your answers?",
    "",
    "❯ 1. Submit answers",
    "  2. Cancel",
  ].join("\n");
  const p = readPrompt(screen);
  assert.equal(p.question, "Ready to submit your answers?");
  assert.deepEqual(p.summary, [
    { question: "¿En qué momento del día programas mejor?", answer: "Mañana" },
    { question: "¿Qué plataformas de Git usas? (puedes elegir varias)", answer: "GitHub, local" },
  ]);
  assert.deepEqual(readPrompt("Pick\n❯ 1. A\n  2. B").summary, []);
});

test("runsOut: when a window hits 100% at the pace so far", () => {
  const now = 1_000_000, hour = 3600;
  // 2h into a 5h window at 60%: 30%/h, so the remaining 40% takes 80 minutes.
  const hot = { pct: 60, resets: now + 3 * hour, pace: 0.4 };
  assert.equal(runsOut(hot, FIVE_HOURS, now), now + 80 * 60);
  // 2h in at 20%: 10%/h, 8h more needed, past the reset.
  assert.equal(runsOut({ pct: 20, resets: now + 3 * hour, pace: 0.4 }, FIVE_HOURS, now), null);
  assert.equal(runsOut({ pct: 5, resets: now + hour, pace: 0.01 }, FIVE_HOURS, now), null);
  assert.equal(runsOut({ pct: 100, resets: now + hour, pace: 0.5 }, FIVE_HOURS, now), null);
  assert.equal(runsOut(null, FIVE_HOURS, now), null);
});

test("lastMessage: the agent's last words, not tool calls or hook noise", () => {
  const screen = [
    "⏺ I'll add the tests first.",
    "⏺ Bash(npm test)",
    "  ⎿  12 passed",
    "⏺ Listo: agregué los tests y todos pasan.",
    "⏺ token-meter: its classic.Stop hook was skipped. \"cc-plugin\" runs first.",
    "✻ Cooked for 6s",
    "❯ ",
  ].join("\n");
  assert.equal(lastMessage(screen), "Listo: agregué los tests y todos pasan.");
  assert.equal(lastMessage("• Codex done: updated 3 files"), "Codex done: updated 3 files");
  assert.equal(lastMessage("no agent here"), "");
});
