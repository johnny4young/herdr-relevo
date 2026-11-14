// The hook's note of a permission request, and how the screen reader uses it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteAsk, parseNote } from "../lib/asks.js";
import { readPrompt, reasonOf } from "../lib/prompt.js";

const FENCED = "╌".repeat(20), RULE = "─".repeat(20);
const CHOICES = [" Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again", "   3. No", ""];
const bash = (command, at = 1000) => ({ at, terminal: "t1", cwd: "/repo", tool: "Bash", input: { command, description: "Deploy it" } });
// The dialog's top has scrolled away: only the command's end is on screen.
const cutScreen = (...tail) => [...tail.map((l) => ` ${l}`), FENCED, ...CHOICES].join("\n");
const LONG = ["set -e", ...Array.from({ length: 70 }, (_, i) => `echo step ${i}`), "git push --force origin main"];

test("parseNote: only a note with a tool and its input counts", () => {
  assert.equal(parseNote(null), null);
  assert.equal(parseNote("{not json"), null);
  assert.equal(parseNote('{"tool":"Bash"}'), null);
  assert.equal(parseNote(JSON.stringify(bash("ls"))).tool, "Bash");
});

test("a command cut by the screen shows whole from the note, and can be answered", () => {
  const screen = cutScreen(...LONG.slice(-5));
  const blind = readPrompt(screen);
  assert.equal(blind.unparsed, true);
  assert.deepEqual(blind.options, []);
  const p = readPrompt(screen, bash(LONG.join("\n")), 1000);
  assert.deepEqual(p.ask, { title: "Bash command", about: "Deploy it", body: LONG, cut: false });
  assert.deepEqual(p.options.map((o) => o.label), ["Yes", "Yes, and don't ask again", "No"]);
  assert.equal(reasonOf(p), "Run: set -e · +71 lines");
});

test("a note for another command, an older wait or another tool is not used", () => {
  const screen = cutScreen("echo step 69", "git push --force origin main");
  const used = (note, since = 1000) => Boolean(noteAsk(note, screen, { since }));
  assert.equal(used(bash("set -e\ngit push --force origin main")), true);
  assert.equal(used(bash("npm test")), false);
  assert.equal(used(bash("set -e\ngit push --force origin main", 100)), false);
  assert.equal(used(bash("set -e\ngit push --force origin main", 900)), true);
  assert.equal(used({ ...bash("x"), tool: "Write", input: { file_path: "/repo/notes.md", content: "git push --force origin main" } }), false);
  assert.equal(readPrompt(screen, bash("npm test"), 1000).unparsed, true);
  // A short command needs its dialog's title on screen: its letters alone are in many others.
  assert.equal(Boolean(noteAsk(bash("ls"), cutScreen("echo tools", "false"), { since: 1000 })), false);
  assert.equal(Boolean(noteAsk(bash("ls"), [RULE, " Bash command", " ls", ...CHOICES].join("\n"), { since: 1000 })), true);
});

test("a dialog the screen reads whole keeps its own words", () => {
  const screen = [RULE, " Bash command", " Run the tests", FENCED, " npm test", FENCED, ...CHOICES].join("\n");
  const p = readPrompt(screen, bash("npm test\necho hidden"), 1000);
  assert.deepEqual(p.ask, { title: "Bash command", about: "Run the tests", body: ["npm test"], cut: false });
});

test("a plan cut by the screen shows whole; a plan note never fills another dialog", () => {
  const plan = { at: 1000, tool: "ExitPlanMode", input: { plan: "# Plan\n1. Read\n2. Write\n3. Test" } };
  const screen = [" 2. Write", " 3. Test", FENCED, " Claude has written up a plan and is ready to execute. Would you like to proceed?", " ❯ 1. Yes", "   2. No", ""].join("\n");
  const p = readPrompt(screen, plan, 1000);
  assert.deepEqual(p.ask.body, ["# Plan", "1. Read", "2. Write", "3. Test"]);
  assert.equal(p.ask.cut, false);
  assert.equal(reasonOf(p), "Plan to approve");
  assert.equal(noteAsk(plan, cutScreen("Bash command", "x"), { since: 1000 }), null);
});

test("an edit, a fetch and another tool say what they are; a question has no ask", () => {
  const ask = (tool, input, screen) => noteAsk({ at: 1, tool, input }, screen);
  assert.deepEqual(ask("Edit", { file_path: "/repo/src/app.js", old_string: "a\nb", new_string: "c" }, "Edit file src/app.js"),
    { title: "Edit file", about: "/repo/src/app.js", body: ["- a", "- b", "+ c"], cut: false });
  assert.deepEqual(ask("Write", { file_path: "/repo/new.md", content: "one\n\ntwo" }, "new.md").body, ["one", "two"]);
  assert.deepEqual(ask("WebFetch", { url: "https://example.com/a?b", prompt: "Summarize" }, "example.com").body, ["url: https://example.com/a?b", "Summarize"]);
  assert.equal(ask("mcp__github__create_issue", { title: "Broken build" }, "Brokenbuild").title, "github · create issue");
  assert.equal(ask("mcp__github__create_issue", { title: "Broken build" }, "something else"), null);
  assert.equal(ask("AskUserQuestion", { questions: [{ question: "Which?" }] }, "Which?"), null);
});
