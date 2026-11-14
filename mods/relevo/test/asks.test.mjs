// The hook's notes of permission requests, and how the screen reader uses them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteAsk, parseNotes } from "../lib/asks.js";
import { readPrompt, reasonOf } from "../lib/prompt.js";

const FENCED = "╌".repeat(20), RULE = "─".repeat(20);
const CHOICES = [" Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again", "   3. No", ""];
const bash = (command, at = 1000) => ({ at, terminal: "t1", cwd: "/repo", tool: "Bash", input: { command, description: "Deploy it" } });
// The dialog's top has scrolled away: only the command's end is on screen.
const cutScreen = (...tail) => [...tail.map((l) => ` ${l}`), FENCED, ...CHOICES].join("\n");
const LONG = ["set -e", ...Array.from({ length: 70 }, (_, i) => `echo step ${i}`), "git push --force origin main"];
const TAIL = LONG.slice(-5), WHOLE = LONG.join("\n");
const used = (notes, visible = TAIL, since = 1000) => Boolean(noteAsk(notes, visible, { since }));

test("parseNotes: lines with a tool, its input and a time, written for this terminal", () => {
  assert.deepEqual(parseNotes(null, "t1"), []);
  const raw = [JSON.stringify(bash("one")), "{not json", '{"tool":"Bash"}', JSON.stringify({ ...bash("x"), at: "soon" }),
    JSON.stringify({ ...bash("other"), terminal: "t2" }), JSON.stringify(bash("two"))].join("\n");
  assert.deepEqual(parseNotes(raw, "t1").map((n) => n.input.command), ["one", "two"]);
  assert.deepEqual(parseNotes(raw, "t3"), []);
});

test("a command cut by the screen shows whole from its note, and can be answered", () => {
  const screen = cutScreen(...TAIL);
  const blind = readPrompt(screen);
  assert.equal(blind.unparsed, true);
  assert.deepEqual(blind.options, []);
  const p = readPrompt(screen, [bash("npm test", 400), bash(WHOLE, 999)], 1000);
  assert.deepEqual(p.ask, { title: "Bash command", about: "Deploy it", body: LONG, cut: false });
  assert.deepEqual(p.options.map((o) => o.label), ["Yes", "Yes, and don't ask again", "No"]);
  assert.equal(reasonOf(p), "Run: set -e · +71 lines");
});

test("a line the terminal wrapped still matches, at a space or inside a word", () => {
  const wide = "curl -sS https://example.com/install.sh --retry 3 --output /tmp/install.sh";
  const notes = [bash(`${WHOLE}\n${wide}`)];
  assert.equal(used(notes, ["echo step 69", "git push --force origin main", "curl -sS https://example.com/install.sh", "--retry 3 --output /tmp/install.sh"]), true);
  assert.equal(used(notes, ["git push --force origin main", "curl -sS https://exam", "ple.com/install.sh --retry 3 --output /tmp/install.sh"]), true);
});

test("every line still on screen must be the note's own end, spaces included", () => {
  assert.equal(used([bash(WHOLE)]), true);
  // Another command with the same last line, or the same first lines.
  assert.equal(used([bash(`rm -rf /data\n${LONG.at(-1)}`)]), false);
  assert.equal(used([bash(WHOLE)], [...TAIL.slice(0, 4), "rm -rf /data"]), false);
  assert.equal(used([bash(WHOLE)], ["rm -rf /data", ...TAIL.slice(1)]), false);
  // The noted command went on after what the screen shows.
  assert.equal(used([bash(`${WHOLE}\nrm -rf /data`)]), false);
  // A space the note doesn't have, or lacks.
  assert.equal(used([bash(`${WHOLE}\nrm -rf /tmp/build-cache/old`)], [...TAIL, "rm -rf / tmp/build-cache/old"]), false);
  assert.equal(used([bash(`${WHOLE}\nrm -rf / tmp/build-cache/old`)], [...TAIL, "rm -rf /tmp/build-cache/old"]), false);
  assert.equal(used([bash(WHOLE)], ["origin main"]), false);
});

test("two requests noted as the wait began, an older one or no known time fill nothing", () => {
  assert.equal(used([bash(WHOLE, 995), bash(WHOLE, 996)]), false);
  assert.equal(used([bash(WHOLE, 980), bash(WHOLE, 996)]), true);
  assert.equal(used([bash(WHOLE, 980)]), false);
  assert.equal(used([bash(WHOLE, 1005)]), true);
  assert.equal(used([bash(WHOLE)], TAIL, null), false);
  assert.equal(used([]), false);
  assert.equal(used(null), false);
  const stale = readPrompt(cutScreen(...TAIL), [bash("npm test")], 1000);
  assert.equal(stale.unparsed, true);
  assert.deepEqual(stale.options, []);
});

test("a dialog the screen reads whole, or one with nothing of the request on screen, keeps to the screen", () => {
  const screen = [RULE, " Bash command", " Run the tests", FENCED, " npm test", FENCED, ...CHOICES].join("\n");
  const p = readPrompt(screen, [bash("npm test\necho hidden")], 1000);
  assert.deepEqual(p.ask, { title: "Bash command", about: "Run the tests", body: ["npm test"], cut: false });
  const blind = readPrompt(CHOICES.join("\n"), [bash(WHOLE)], 1000);
  assert.equal(blind.unparsed, true);
  assert.equal(blind.ask, null);
});

test("a plan cut by the screen shows whole; other tools and other dialogs get nothing from a note", () => {
  const text = "# Plan\n\n1. **Read** the config loader\n2. Write the migration\n3. Test it on a copy";
  const plan = { at: 1000, terminal: "t1", tool: "ExitPlanMode", input: { plan: text } };
  const screen = [" 1. Read the config loader", " 2. Write the migration", " 3. Test it on a copy", FENCED,
    " Claude has written up a plan and is ready to execute. Would you like to proceed?", " ❯ 1. Yes", "   2. No", ""].join("\n");
  const p = readPrompt(screen, [plan], 1000);
  assert.deepEqual(p.ask.body, ["# Plan", "1. **Read** the config loader", "2. Write the migration", "3. Test it on a copy"]);
  assert.equal(p.ask.cut, false);
  assert.equal(reasonOf(p), "Plan to approve");
  assert.equal(noteAsk([plan], TAIL, { since: 1000 }), null);
  assert.equal(noteAsk([bash(WHOLE)], TAIL, { since: 1000, plan: true }), null);
  for (const tool of ["Edit", "Write", "WebFetch", "AskUserQuestion", "mcp__github__create_issue"]) {
    assert.equal(noteAsk([{ at: 1000, terminal: "t1", tool, input: { command: WHOLE, file_path: "/a" } }], TAIL, { since: 1000 }), null, tool);
  }
});
