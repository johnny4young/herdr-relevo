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
const TAIL = LONG.slice(-5);

test("parseNote: only a note with a tool and its input, written for this terminal, counts", () => {
  assert.equal(parseNote(null), null);
  assert.equal(parseNote("{not json"), null);
  assert.equal(parseNote('{"tool":"Bash"}'), null);
  assert.equal(parseNote(JSON.stringify(bash("ls"))).tool, "Bash");
  assert.equal(parseNote(JSON.stringify(bash("ls")), "t1").tool, "Bash");
  assert.equal(parseNote(JSON.stringify(bash("ls")), "t2"), null);
});

test("a command cut by the screen shows whole from the note, and can be answered", () => {
  const screen = cutScreen(...TAIL);
  const blind = readPrompt(screen);
  assert.equal(blind.unparsed, true);
  assert.deepEqual(blind.options, []);
  const p = readPrompt(screen, bash(LONG.join("\n")), 1000);
  assert.deepEqual(p.ask, { title: "Bash command", about: "Deploy it", body: LONG, cut: false });
  assert.deepEqual(p.options.map((o) => o.label), ["Yes", "Yes, and don't ask again", "No"]);
  assert.equal(reasonOf(p), "Run: set -e · +71 lines");
});

test("a line the terminal wrapped still matches", () => {
  const wide = `curl -sS https://example.com/install.sh --retry 3 --output /tmp/install.sh`;
  const note = bash(`${LONG.join("\n")}\n${wide}`);
  assert.ok(noteAsk(note, ["echo step 69", "git push --force origin main", wide.slice(0, 40), wide.slice(40)], { since: 1000 }));
});

test("every line still on screen must be the note's own end, or the card stays unanswerable", () => {
  const whole = LONG.join("\n"), used = (note, visible = TAIL, since = 1000) => Boolean(noteAsk(note, visible, { since }));
  assert.equal(used(bash(whole)), true);
  // Another command with the same last line, or the same first lines.
  assert.equal(used(bash(`rm -rf /data\n${LONG.at(-1)}`)), false);
  assert.equal(used(bash(whole), [...TAIL.slice(0, 4), "rm -rf /data"]), false);
  assert.equal(used(bash(whole), ["rm -rf /data", ...TAIL.slice(1)]), false);
  // The note's command went on after what the screen shows.
  assert.equal(used(bash(`${whole}\nrm -rf /data`)), false);
  // Too little on screen, an older wait, a note with no time.
  assert.equal(used(bash(whole), ["origin main"]), false);
  assert.equal(used(bash(whole, 100)), false);
  assert.equal(used(bash(whole, 900)), true);
  assert.equal(used({ ...bash(whole), at: undefined }), false);
  const stale = readPrompt(cutScreen(...TAIL), bash("npm test"), 1000);
  assert.equal(stale.unparsed, true);
  assert.deepEqual(stale.options, []);
});

test("a dialog the screen reads whole, or one with nothing of the request on screen, keeps to the screen", () => {
  const screen = [RULE, " Bash command", " Run the tests", FENCED, " npm test", FENCED, ...CHOICES].join("\n");
  const p = readPrompt(screen, bash("npm test\necho hidden"), 1000);
  assert.deepEqual(p.ask, { title: "Bash command", about: "Run the tests", body: ["npm test"], cut: false });
  const blind = readPrompt(CHOICES.join("\n"), bash(LONG.join("\n")), 1000);
  assert.equal(blind.unparsed, true);
  assert.equal(blind.ask, null);
});

test("a plan cut by the screen shows whole; other tools and other dialogs get nothing from a note", () => {
  const text = "# Plan\n\n1. **Read** the config loader\n2. Write the migration\n3. Test it on a copy";
  const plan = { at: 1000, terminal: "t1", tool: "ExitPlanMode", input: { plan: text } };
  const screen = [" 1. Read the config loader", " 2. Write the migration", " 3. Test it on a copy", FENCED,
    " Claude has written up a plan and is ready to execute. Would you like to proceed?", " ❯ 1. Yes", "   2. No", ""].join("\n");
  const p = readPrompt(screen, plan, 1000);
  assert.deepEqual(p.ask.body, ["# Plan", "1. **Read** the config loader", "2. Write the migration", "3. Test it on a copy"]);
  assert.equal(p.ask.cut, false);
  assert.equal(reasonOf(p), "Plan to approve");
  assert.equal(noteAsk(plan, TAIL, { since: 1000 }), null);
  assert.equal(noteAsk(bash(LONG.join("\n")), TAIL, { since: 1000, plan: true }), null);
  for (const tool of ["Edit", "Write", "WebFetch", "AskUserQuestion", "mcp__github__create_issue"]) {
    assert.equal(noteAsk({ at: 1000, tool, input: { command: LONG.join("\n"), file_path: "/a" } }, TAIL, { since: 1000 }), null, tool);
  }
});
