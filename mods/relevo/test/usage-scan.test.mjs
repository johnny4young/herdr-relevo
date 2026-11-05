// The shell's extraction runs for real on fixture transcripts, then the pure functions add it up.
import "./fake/register.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fake, resetFake } from "./fake/herdr.mjs";
import {
  AWK, CLAUDE_SCAN, CODEX_SCAN, CONTEXT_SCAN, addClaude, addCodex, contextOf, cutDay, emptyState, parseList, parseScan,
  plan, prune, reportOf, seenSet,
} from "../lib/usage-scan.js";

const { UsageScanner, AGENT_CONTEXT, publishContext } = await import("../usage-scan.js");

const sh = (script, ...args) => execFileSync("sh", ["-c", script, "sh", ...args]).toString();
const stamp = (hoursAgo = 0) => new Date(Date.now() - hoursAgo * 3600000).toISOString();
const CUT = cutDay();

// Field order as Claude writes it: the message first, its usage at the message's end, the line's own after.
function line(n, ts, { write = 100, output = 10, entrypoint = "cli", cwd = "/w/.herdr/worktrees/app/fix", sid = "s1", text = "hi", h1 = write, m5 = 0 } = {}) {
  return `${JSON.stringify({
    parentUuid: "p", isSidechain: false,
    message: {
      model: "claude-x", id: `msg_${String(n).padStart(14, "0")}`, type: "message", role: "assistant",
      content: [{ type: "text", text }],
      usage: { input_tokens: 1, cache_creation_input_tokens: write, cache_read_input_tokens: 5, output_tokens: output,
        cache_creation: { ephemeral_1h_input_tokens: h1, ephemeral_5m_input_tokens: m5 }, iterations: [{ input_tokens: 99 }] },
    },
    requestId: `req_${n}`, type: "assistant", uuid: "u", timestamp: ts, entrypoint, cwd, sessionId: sid,
  })}\n`;
}

let dir;
beforeEach(() => {
  resetFake();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), "relevo-usage-"));
});

function read(path, start = 0, end = readFileSync(path).length, prev = "") {
  return parseScan(sh(CLAUDE_SCAN, AWK, `${path}|${start}|${end}|${prev}`));
}

function add(files, state = emptyState(), seen = new Set(), kind = "main") {
  for (const f of files) addClaude(state, seen, f, { account: "personal", kind, project: (cwd) => cwd.split("/").pop(), cut: CUT });
  return { state, seen, rows: reportOf(state, 0).rows };
}

const sum = (rows, field) => rows.reduce((n, r) => n + r[field], 0);

test("the shell reads each message's tokens, time and place", () => {
  const f = join(dir, "a.jsonl");
  writeFileSync(f, line(1, stamp(), { write: 300, output: 20, h1: 0, m5: 300 }));
  const [file] = read(f);
  assert.deepEqual({ ...file.msgs[0], ts: undefined }, {
    id: "msg_00000000000001", ts: undefined, model: "claude-x", entrypoint: "cli", input: 1, write: 300, read: 5, output: 20,
    h1: 0, m5: 300, sid: "s1", cwd: "/w/.herdr/worktrees/app/fix",
  });
});

test("words inside a message never pass for its fields", () => {
  const f = join(dir, "a.jsonl");
  writeFileSync(f, line(1, stamp(), { text: '"usage":{"input_tokens":777,"cwd":"/elsewhere","id":"msg_fake"' }));
  const m = read(f)[0].msgs[0];
  assert.deepEqual([m.input, m.cwd, m.id], [1, "/w/.herdr/worktrees/app/fix", "msg_00000000000001"]);
});

test("a message written in several lines counts once", () => {
  const f = join(dir, "a.jsonl"), ts = stamp();
  writeFileSync(f, line(1, ts) + line(1, ts) + line(2, ts));
  assert.equal(sum(add(read(f)).rows, "write"), 200);
});

test("the same message in two transcripts counts once", () => {
  const a = join(dir, "a.jsonl"), b = join(dir, "b.jsonl"), ts = stamp();
  writeFileSync(a, line(1, ts));
  writeFileSync(b, line(1, ts) + line(2, ts));
  assert.equal(sum(add([...read(a), ...read(b)]).rows, "write"), 200);
});

test("a second read takes only what was added", () => {
  const f = join(dir, "a.jsonl");
  writeFileSync(f, line(1, stamp()));
  const first = add(read(f));
  const size = first.state.files[f].size;
  appendFileSync(f, line(2, stamp()));
  const again = add(read(f, size, readFileSync(f).length, first.state.files[f].prev), first.state, first.seen);
  assert.equal(sum(again.rows, "write"), 200);
});

test("a line cut by a range's end is left for the next range", () => {
  const f = join(dir, "a.jsonl"), whole = line(1, stamp());
  writeFileSync(f, whole);
  assert.equal(read(f, 0, 200)[0].msgs.filter((m) => m.ts).length, 0);
});

test("big files go in overlapping ranges, and the overlap counts once", () => {
  const f = join(dir, "a.jsonl");
  writeFileSync(f, Array.from({ length: 40 }, (_, i) => line(i + 1, stamp())).join(""));
  const size = readFileSync(f).length;
  const batches = plan([{ path: f, from: 0, size, prev: "" }], 3000, 1000);
  assert.ok(batches.length > 3);
  const files = batches.flat().flatMap((r) => read(f, r.start, r.end, r.prev));
  assert.equal(sum(add(files).rows, "write"), 4000);
});

test("ranges batch together up to the chunk", () => {
  const batches = plan([{ path: "a", from: 0, size: 40, prev: "" }, { path: "b", from: 10, size: 30, prev: "x" }], 100, 10);
  assert.deepEqual(batches.map((b) => b.map((r) => [r.path, r.start, r.end, r.prev])), [[["a", 0, 40, ""], ["b", 10, 30, "x"]]]);
});

test("each entrypoint has its surface, and an automatic session stays out of the sessions", () => {
  const f = join(dir, "a.jsonl"), ts = stamp();
  writeFileSync(f, line(1, ts, { entrypoint: "claude-desktop" }) + line(2, ts) + line(3, ts, { entrypoint: "sdk-py", sid: "auto" }));
  const { rows, state } = add(read(f));
  assert.deepEqual(rows.map((r) => [r.surface, r.kind]).sort(), [["automatic", "automatic"], ["desktop", "main"], ["terminal", "main"]]);
  assert.deepEqual(Object.keys(state.sessions), ["s1"]);
});

test("a big write after a long pause counts as caching the conversation again", () => {
  const f = join(dir, "a.jsonl");
  writeFileSync(f, line(1, stamp(3), { write: 500 }) + line(2, stamp(), { write: 50000 }) + line(3, stamp(), { write: 60000 }));
  const { rows } = add(read(f));
  assert.deepEqual([sum(rows, "pause_write"), sum(rows, "pauses")], [50000, 1]);
});

test("a subagent's messages count under its type, never as a pause", () => {
  const f = join(dir, "a.jsonl");
  writeFileSync(f, line(1, stamp(3)) + line(2, stamp(), { write: 90000 }));
  const { rows } = add(read(f), emptyState(), new Set(), "sub:general-purpose");
  assert.deepEqual([rows[0].kind, sum(rows, "pauses")], ["sub:general-purpose", 0]);
});

test("a session takes its title", () => {
  const f = join(dir, "a.jsonl");
  writeFileSync(f, `${JSON.stringify({ type: "ai-title", aiTitle: 'Fix "login"', sessionId: "s1" })}\n${line(1, stamp())}`);
  assert.equal(add(read(f)).state.sessions.s1.title, 'Fix "login"');
});

test("days past the window, gone files and old sessions are dropped", () => {
  const state = emptyState();
  state.rows[`2000-01-01\tp\tterminal\tapp\tmain\tm`] = [1, 1, 1, 1, 1, 0, 0];
  state.files["/gone.jsonl"] = { size: 1 };
  state.sessions.old = { last: "2000-01-01T00:00:00Z" };
  state.seen["2000-01-01"] = "x";
  prune(state, CUT, new Set());
  assert.deepEqual([state.rows, state.files, state.sessions, state.seen], [{}, {}, {}, {}]);
});

test("the saved ids come back as a set", () => {
  assert.deepEqual([...seenSet({ seen: { "2026-11-01": "a b", "2026-11-02": "c" } })], ["a", "b", "c"]);
});

test("wc's list keeps sizes and drops its totals", () => {
  assert.deepEqual([...parseList("  12 /a b.jsonl\n 30 /c.jsonl\n 42 total\n")], [["/a b.jsonl", 12], ["/c.jsonl", 30]]);
});

test("Codex counts what each event adds, and an event read again adds nothing", () => {
  const f = join(dir, "c.jsonl");
  const event = (out) => `${JSON.stringify({ timestamp: stamp(), type: "event_msg", payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: out * 3, cached_input_tokens: out, output_tokens: out } } } })}\n`;
  writeFileSync(f, `${JSON.stringify({ type: "session_meta", payload: { cwd: "/w/.herdr/worktrees/app/x" } })}\n${event(10)}${event(10)}${event(25)}`);
  const state = emptyState(), project = (cwd) => cwd.split("/.herdr/worktrees/")[1].split("/")[0];
  const scan = () => parseScan(sh(CODEX_SCAN, `${f}|0|${readFileSync(f).length}`))[0];
  addCodex(state, scan(), { project, cut: CUT });
  addCodex(state, scan(), { project, cut: CUT });
  assert.deepEqual(reportOf(state, 0).rows.map((r) => [r.surface, r.project, r.output, r.read, r.input]), [["codex", "app", 25, 25, 50]]);
});

test("the newest message gives an agent's context and cache life", () => {
  const f = join(dir, "t.jsonl");
  writeFileSync(f, line(1, stamp(1)) + line(2, stamp(), { write: 1000, h1: 0, m5: 1000 }) + '{"type":"user"}\n');
  assert.deepEqual({ ...contextOf(parseScan(sh(CONTEXT_SCAN, AWK, f))[0]), at: 0 }, { model: "claude-x", at: 0, context: 1006, ttl: 300 });
});

// The scanner on the fake app, its commands run for real against a fixture home.
function realHome() {
  const home = join(dir, "home"), projects = join(home, ".claude", "projects", "p");
  mkdirSync(projects, { recursive: true });
  fake.exec = (cmd, args) => {
    const real = cmd === "nice" ? args.slice(2) : [cmd, ...args];
    try {
      return { code: 0, stdout: execFileSync(real[0], real.slice(1).map((a) => a.replaceAll("/home/test", home))).toString() };
    } catch (e) {
      return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "" };
    }
  };
  fake.read = (path) => {
    try {
      return readFileSync(path.replace("/home/test", home), "utf8");
    } catch {
      return null;
    }
  };
  fake.write = (path, body) => writeFileSync(path.replace("/home/test", home), body);
  return { home, projects };
}

test("the scanner reads, saves, and on the next read takes only what was added", async () => {
  const { projects } = realHome();
  const f = join(projects, "a.jsonl");
  writeFileSync(f, line(1, stamp()));
  await new UsageScanner().scan();
  appendFileSync(f, line(2, stamp()));
  const scanner = new UsageScanner();
  await scanner.scan();
  await scanner.scan();
  const report = JSON.parse(fake.read("/home/test/.local/state/relevo/usage/report.json"));
  assert.equal(sum(report.rows, "write"), 200);
  assert.ok(fake.stored["relevo.usage"].updated > 0);
});

test("each live agent's context is published from its transcript", async () => {
  const { projects } = realHome();
  const f = join(projects, "a.jsonl");
  writeFileSync(f, line(1, stamp(), { write: 10 }));
  fake.terminals = [{ address: "t1", state: "live", labels: { "agent.transcript": f } }];
  await publishContext();
  assert.equal(fake.stored[AGENT_CONTEXT].t1.context, 16);
});
