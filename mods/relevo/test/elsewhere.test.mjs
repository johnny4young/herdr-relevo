// Claude Code in terminals outside Herdr: the hook's notes read as sessions.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fake, resetFake } from "./fake/herdr.mjs";
import { elsewhereSession } from "../lib/elsewhere.js";

const { ELSEWHERE, ElsewhereWatch } = await import("../elsewhere.js");
const NOW = 2_000_000;
const note = (over = {}) => ({ session: "s-1", event: "SessionStart", cwd: "/w/code/app", transcript: "/h/.claude/projects/-w-app/s-1.jsonl", app: "Apple_Terminal",
  bundle: "com.apple.Terminal", dir: ".claude", at: NOW - 600, tool: "", ...over });

beforeEach(() => resetFake());

test("a note and its transcript say whether the session works, asks, finished or rests", () => {
  const state = (over, mtime) => elsewhereSession(note(over), mtime, null, NOW).state;
  assert.equal(state({}, NOW - 10), "working", "written after the note, just now");
  assert.equal(state({ event: "Stop", at: NOW - 30 }, NOW - 31), "review");
  assert.equal(state({ event: "Stop", at: NOW - 900 }, NOW - 5), "working", "a new prompt after the turn ended");
  assert.equal(state({ event: "PermissionRequest", tool: "Bash", at: NOW - 20 }, NOW - 21), "blocked");
  assert.equal(state({}, NOW - 3600), "idle");
  const s = elsewhereSession(note({ event: "PermissionRequest", tool: "Bash" }), NOW - 700, { doing: "running npm", said: "Next the tests." }, NOW);
  assert.deepEqual({ app: s.app, project: s.project, needs: s.needs, doing: s.doing }, { app: "Terminal", project: "app", needs: "asks to use Bash", doing: "running npm" });
  assert.equal(elsewhereSession({}, 0, null, NOW), null);
});

test("the watch publishes noted sessions, leaves Claude Desktop's out and reads each transcript once per change", async () => {
  const now = Math.round(Date.now() / 1000);
  const notes = [note({ at: now - 60 }), note({ session: "d-1", transcript: "/h/.claude/projects/-w-app/d-1.jsonl", at: now - 60 })];
  fake.stored["relevo.desktop"] = [{ id: "local_1", cli: "d-1", state: "working" }];
  let tails = 0;
  fake.exec = (cmd, args) => {
    if (cmd === "sh" && args[1].includes("relevo/elsewhere")) return { stdout: notes.map((n) => JSON.stringify(n)).join("\n") };
    if (cmd === "sh") return { stdout: args.slice(3).map((p) => `${now - 5} ${p}`).join("\n") };
    if (cmd === "tail") { tails += 1; return { stdout: JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/w/a/b.js" } }] } }) }; }
    return null;
  };
  const watch = new ElsewhereWatch();
  await watch.tick();
  assert.deepEqual(fake.stored[ELSEWHERE].map((s) => [s.id, s.state, s.doing, s.app]), [["s-1", "working", "reading b.js", "Terminal"]]);
  await watch.tick();
  assert.equal(tails, 1);
});
